import type { FastifyInstance } from "fastify";
import type pg from "pg";
import type { PaymentView } from "@reconcile/shared";
import { PAYMENT_UPDATED, type PgListener } from "../db/notify.js";
import { isUuid } from "../db/pool.js";
import { loadPaymentView } from "../db/rows.js";
import { logger } from "../logger.js";

const HEARTBEAT_MS = 15_000;

type Subscriber = (view: PaymentView) => void;

/** Fans payment_updated notifications out to SSE subscribers of that payment. */
export class PaymentStreamHub {
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  constructor(
    private readonly pool: pg.Pool,
    listener: PgListener,
  ) {
    listener.on(PAYMENT_UPDATED, (id: string) => {
      void this.publish(id);
    });
  }

  subscribe(id: string, fn: Subscriber): () => void {
    let set = this.subscribers.get(id);
    if (!set) this.subscribers.set(id, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.subscribers.delete(id);
    };
  }

  private async publish(id: string): Promise<void> {
    const set = this.subscribers.get(id);
    if (!set?.size) return;
    try {
      const view = await loadPaymentView(this.pool, id);
      if (view) for (const fn of set) fn(view);
    } catch (err) {
      logger.error({ err, paymentId: id }, "loading payment for SSE failed");
    }
  }
}

export function registerStreamRoutes(app: FastifyInstance, pool: pg.Pool, hub: PaymentStreamHub): void {
  app.get<{ Params: { id: string } }>("/payments/:id/stream", async (req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "NOT_FOUND" });
    const initial = await loadPaymentView(pool, req.params.id);
    if (!initial) return reply.code(404).send({ error: "NOT_FOUND" });

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (view: PaymentView) => res.write(`event: payment\ndata: ${JSON.stringify(view)}\n\n`);
    send(initial);

    const unsubscribe = hub.subscribe(req.params.id, send);
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), HEARTBEAT_MS);
    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
