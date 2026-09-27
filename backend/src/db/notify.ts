import { EventEmitter } from "node:events";
import pg from "pg";
import { logger } from "../logger.js";
import type { Db } from "./pool.js";

export const EVIDENCE_INSERTED = "evidence_inserted";
export const PAYMENT_UPDATED = "payment_updated";
/** A payment needs the worker's attention without new evidence (e.g. it just became UNKNOWN). */
export const PAYMENT_DUE = "payment_due";

export async function notify(db: Db, channel: string, payload: string): Promise<void> {
  await db.query("SELECT pg_notify($1, $2)", [channel, payload]);
}

/**
 * One dedicated connection per process for LISTEN. Needs a direct/session
 * connection on hosted Postgres. Reconnects on failure; the worker sweep
 * keeps the system correct while it is down.
 */
export class PgListener extends EventEmitter {
  private client: pg.Client | null = null;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly connectionString: string,
    private readonly channels: string[],
  ) {
    super();
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on("notification", (msg) => this.emit(msg.channel, msg.payload ?? ""));
    client.on("error", (err) => {
      logger.error({ err, channels: this.channels }, "LISTEN connection error");
      this.reconnect();
    });
    try {
      await client.connect();
      for (const channel of this.channels) await client.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
      this.client = client;
      logger.info({ channels: this.channels }, "listening for notifications");
    } catch (err) {
      logger.error({ err, channels: this.channels }, "LISTEN connect failed");
      await client.end().catch((endErr) => logger.warn({ err: endErr }, "closing failed LISTEN client"));
      this.reconnect();
    }
  }

  private reconnect(): void {
    if (this.stopped || this.retryTimer) return;
    const old = this.client;
    this.client = null;
    old?.end().catch((err) => logger.warn({ err }, "closing broken LISTEN client"));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, 1000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const client = this.client;
    this.client = null;
    if (client) await client.end();
  }
}
