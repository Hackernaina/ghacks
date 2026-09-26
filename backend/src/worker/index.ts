import { listenUrlFor } from "../config/index.js";
import { EVIDENCE_INSERTED, PgListener } from "../db/notify.js";
import { pollAllFeeds } from "../ingestion/pollers.js";
import { logger } from "../logger.js";
import { sweepOrphans } from "./orphans.js";
import { processPayment, type WorkerDeps } from "./process.js";

const DEBOUNCE_MS = 200;
const SWEEP_BATCH = 50;

export interface Worker {
  enqueue(id: string): void;
  sweepOnce(): Promise<void>;
  /** Resolves once the queue is empty and nothing is being processed. */
  idle(): Promise<void>;
  stop(): Promise<void>;
}

export async function startWorker(deps: WorkerDeps, opts: { pollFeeds?: boolean } = {}): Promise<Worker> {
  const { config, pool } = deps;
  const queue = new Set<string>();
  const timers = new Map<string, NodeJS.Timeout>();
  let flushTimer: NodeJS.Timeout | null = null;
  let draining: Promise<void> | null = null;
  let stopped = false;

  function scheduleRecheck(id: string, at: Date | null): void {
    const existing = timers.get(id);
    if (existing) clearTimeout(existing);
    timers.delete(id);
    if (!at || stopped) return;
    const delay = at.getTime() - Date.now();
    // Checks further out than one sweep are left to the sweep.
    if (delay > config.SWEEP_MS) return;
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        enqueue(id);
      }, Math.max(delay, 0) + 10),
    );
  }

  async function drain(): Promise<void> {
    while (queue.size > 0 && !stopped) {
      const id = queue.values().next().value as string;
      queue.delete(id);
      try {
        const resolution = await processPayment(deps, id);
        if (resolution) scheduleRecheck(id, resolution.nextCheckAt);
      } catch (err) {
        logger.error({ err, paymentId: id }, "processing payment failed; will retry on next sweep");
      }
    }
  }

  function flush(): void {
    flushTimer = null;
    if (draining) return;
    draining = drain().finally(() => {
      draining = null;
      if (queue.size > 0 && !stopped) flush();
    });
  }

  function enqueue(id: string): void {
    if (stopped) return;
    queue.add(id);
    flushTimer ??= setTimeout(flush, DEBOUNCE_MS);
  }

  async function sweepOnce(): Promise<void> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT p.id FROM payments p
        WHERE p.next_check_at <= now()
           OR EXISTS (SELECT 1 FROM evidence e WHERE e.payment_id = p.id AND e.received_at > p.updated_at)
        ORDER BY p.next_check_at NULLS LAST
        LIMIT $1`,
      [SWEEP_BATCH],
    );
    for (const r of rows) enqueue(r.id);
    for (const id of await sweepOrphans(pool)) enqueue(id);
  }

  const listener = new PgListener(listenUrlFor(config), [EVIDENCE_INSERTED]);
  listener.on(EVIDENCE_INSERTED, (payload: string) => {
    if (payload && payload !== "orphan") enqueue(payload);
  });
  await listener.start();

  const sweepTimer = setInterval(() => {
    sweepOnce().catch((err) => logger.error({ err }, "sweep failed"));
  }, config.SWEEP_MS);
  const feedTimer =
    opts.pollFeeds === false
      ? null
      : setInterval(() => {
          pollAllFeeds(pool, config).catch((err) => logger.error({ err }, "feed polling failed"));
        }, config.CSV_POLL_MS);

  await sweepOnce().catch((err) => logger.error({ err }, "initial sweep failed"));
  logger.info({ sweepMs: config.SWEEP_MS, csvPollMs: config.CSV_POLL_MS }, "worker started");

  return {
    enqueue,
    sweepOnce,
    async idle() {
      while (flushTimer || draining || queue.size > 0) {
        if (draining) await draining;
        else await new Promise((r) => setTimeout(r, DEBOUNCE_MS));
      }
    },
    async stop() {
      stopped = true;
      clearInterval(sweepTimer);
      if (feedTimer) clearInterval(feedTimer);
      if (flushTimer) clearTimeout(flushTimer);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      await listener.stop();
      if (draining) await draining;
    },
  };
}
