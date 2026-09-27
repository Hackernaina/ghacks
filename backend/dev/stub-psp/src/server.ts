import { createHmac, randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import {
  BANK_STATEMENT_CSV_HEADER,
  CreatePaymentRequest,
  CreateRefundRequest,
  SETTLEMENT_CSV_HEADER,
  type PspPaymentResponse,
  type PspRefundResponse,
  type WebhookPayload,
} from "@reconcile/shared";

export interface Faults {
  /** Process the payment, then drop the connection without responding. */
  dropResponse: boolean;
  /** Deliver each webhook this many times with the same eventId. */
  webhookDuplicates: number;
  webhookDelayMs: number;
  /** Also emit an older payment.failed event and deliver it after payment.succeeded. */
  webhookReorder: boolean;
  /** A repeated Idempotency-Key creates a new charge with a new pspRef. */
  bypassIdempotency: boolean;
  /** Status queries return 404 for this long after the charge is created. */
  notFoundForMs: number;
  /** Added to amounts in the settlement report. */
  settlementAmountDelta: number;
}

export const DEFAULT_FAULTS: Faults = {
  dropResponse: false,
  webhookDuplicates: 1,
  webhookDelayMs: 0,
  webhookReorder: false,
  bypassIdempotency: false,
  notFoundForMs: 0,
  settlementAmountDelta: 0,
};

export interface StubOptions {
  pspId: "psp_a" | "psp_b";
  webhookSecret: string;
  callbackUrl: string;
  faults?: Partial<Faults>;
  logger?: boolean;
}

interface Charge extends PspPaymentResponse {
  orderId: string;
  settled: boolean;
}

interface SettlementRow {
  batch_id: string;
  line_no: number;
  psp_ref: string;
  idempotency_key: string;
  order_id: string;
  amount: number;
  currency: string;
  status: "SETTLED";
  settled_at: string;
}

interface BankRow {
  statement_id: string;
  line_no: number;
  psp_ref: string;
  amount: number;
  currency: string;
  type: "CREDIT";
  credited_at: string;
}

export interface StubPsp {
  app: FastifyInstance;
  options: StubOptions;
  faults: Faults;
  /** Resolves when every webhook scheduled so far has been delivered or given up on. */
  webhooksDelivered(): Promise<void>;
}

function toCsv(header: string, rows: object[]): string {
  const cols = header.split(",");
  const lines = rows.map((r) => cols.map((c) => String((r as Record<string, unknown>)[c] ?? "")).join(","));
  return [header, ...lines].join("\n") + "\n";
}

export function buildStubPsp(options: StubOptions): StubPsp {
  const app = Fastify({ logger: options.logger ?? false });
  const faults: Faults = { ...DEFAULT_FAULTS, ...options.faults };
  const prefix = options.pspId === "psp_a" ? "pa" : "pb";

  let latestByKey = new Map<string, Charge>();
  let charges: Charge[] = [];
  let refunds = new Map<string, PspRefundResponse>();
  let settlements: SettlementRow[] = [];
  let credits: BankRow[] = [];
  const pending = new Set<Promise<void>>();

  async function deliver(event: WebhookPayload): Promise<void> {
    const body = JSON.stringify(event);
    const signature = createHmac("sha256", options.webhookSecret).update(body).digest("hex");
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`${options.callbackUrl}/webhooks/${options.pspId}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-signature": signature },
          body,
        });
        if (res.ok) return;
        app.log.warn({ status: res.status, eventId: event.eventId }, "webhook rejected");
      } catch (err) {
        app.log.warn({ err, eventId: event.eventId }, "webhook delivery failed");
      }
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }

  function track(p: Promise<void>): void {
    pending.add(p);
    void p.finally(() => pending.delete(p));
  }

  function event(charge: Charge, type: WebhookPayload["type"], status: WebhookPayload["data"]["status"], createdAt: string, amount = charge.amount): WebhookPayload {
    return {
      eventId: `evt_${randomUUID()}`,
      type,
      createdAt,
      data: { pspRef: charge.pspRef, idempotencyKey: charge.idempotencyKey, orderId: charge.orderId, amount, currency: charge.currency, status },
    };
  }

  function scheduleWebhooks(events: WebhookPayload[]): void {
    const copies = Math.max(1, faults.webhookDuplicates);
    const delay = faults.webhookDelayMs;
    track(
      (async () => {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        for (const e of events) for (let i = 0; i < copies; i++) await deliver(e);
      })(),
    );
  }

  app.post("/v1/payments", async (req, reply) => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !key) return reply.code(422).send({ error: "MISSING_IDEMPOTENCY_KEY", message: "Idempotency-Key header is required" });
    const body = CreatePaymentRequest.safeParse(req.body);
    if (!body.success) return reply.code(422).send({ error: "INVALID_REQUEST", message: body.error.message });
    if (body.data.amount <= 0) return reply.code(422).send({ error: "INVALID_AMOUNT", message: "amount must be positive" });

    const existing = latestByKey.get(key);
    let charge: Charge;
    if (existing && !faults.bypassIdempotency) {
      charge = existing;
    } else {
      charge = {
        pspRef: `${prefix}_${randomUUID()}`,
        idempotencyKey: key,
        status: "SUCCEEDED",
        amount: body.data.amount,
        currency: body.data.currency,
        createdAt: new Date().toISOString(),
        orderId: body.data.orderId,
        settled: false,
      };
      latestByKey.set(key, charge);
      charges.push(charge);
      const events = [event(charge, "payment.succeeded", "SUCCEEDED", charge.createdAt)];
      if (faults.webhookReorder) {
        const older = new Date(new Date(charge.createdAt).getTime() - 1000).toISOString();
        events.push(event(charge, "payment.failed", "FAILED", older));
      }
      scheduleWebhooks(events);
    }

    if (faults.dropResponse) {
      reply.hijack();
      reply.raw.destroy();
      return;
    }
    const { orderId: _o, settled: _s, ...response } = charge;
    return response;
  });

  app.get<{ Querystring: { idempotency_key?: string } }>("/v1/payments", async (req, reply) => {
    const charge = req.query.idempotency_key ? latestByKey.get(req.query.idempotency_key) : undefined;
    if (!charge || Date.now() - new Date(charge.createdAt).getTime() < faults.notFoundForMs) {
      return reply.code(404).send({ error: "NOT_FOUND" });
    }
    const { orderId: _o, settled: _s, ...response } = charge;
    return response;
  });

  app.post("/v1/refunds", async (req, reply) => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || !key) return reply.code(422).send({ error: "MISSING_IDEMPOTENCY_KEY", message: "Idempotency-Key header is required" });
    const body = CreateRefundRequest.safeParse(req.body);
    if (!body.success) return reply.code(422).send({ error: "INVALID_REQUEST", message: body.error.message });
    const existing = refunds.get(key);
    if (existing) return existing;
    const charge = charges.find((c) => c.pspRef === body.data.pspRef);
    if (!charge) return reply.code(422).send({ error: "UNKNOWN_PSP_REF", message: "No such charge" });
    const refund: PspRefundResponse = { refundRef: `rf_${randomUUID()}`, pspRef: charge.pspRef, status: "SUCCEEDED", amount: body.data.amount };
    refunds.set(key, refund);
    scheduleWebhooks([event(charge, "payment.refunded", "REFUNDED", new Date().toISOString(), body.data.amount)]);
    return refund;
  });

  app.get<{ Querystring: { since?: string } }>("/v1/settlements", async (req, reply) => {
    const since = req.query.since ? new Date(req.query.since).getTime() : 0;
    const rows = settlements.filter((s) => new Date(s.settled_at).getTime() >= since);
    return reply.type("text/csv").send(toCsv(SETTLEMENT_CSV_HEADER, rows));
  });

  app.get<{ Querystring: { since?: string } }>("/statements", async (req, reply) => {
    const since = req.query.since ? new Date(req.query.since).getTime() : 0;
    const rows = credits.filter((c) => new Date(c.credited_at).getTime() >= since);
    return reply.type("text/csv").send(toCsv(BANK_STATEMENT_CSV_HEADER, rows));
  });

  // ---- dev/test controls ----

  app.get("/admin/faults", async () => faults);
  app.post("/admin/faults", async (req) => {
    Object.assign(faults, req.body as Partial<Faults>);
    return faults;
  });

  /** Writes a settlement line for every unsettled successful charge. */
  app.post("/admin/settle", async () => {
    const batchId = `stl_${options.pspId}_${Date.now()}`;
    let lineNo = 0;
    for (const c of charges.filter((c) => !c.settled && c.status === "SUCCEEDED")) {
      c.settled = true;
      settlements.push({
        batch_id: batchId,
        line_no: ++lineNo,
        psp_ref: c.pspRef,
        idempotency_key: c.idempotencyKey,
        order_id: c.orderId,
        amount: c.amount + faults.settlementAmountDelta,
        currency: c.currency,
        status: "SETTLED",
        settled_at: new Date().toISOString(),
      });
    }
    return { batchId, lines: lineNo };
  });

  /** Writes a bank credit for every settlement line not yet credited (acts as the bank for local dev). */
  app.post("/admin/credit", async () => {
    const statementId = `stmt_${options.pspId}_${Date.now()}`;
    const credited = new Set(credits.map((c) => c.psp_ref));
    let lineNo = 0;
    for (const s of settlements.filter((s) => !credited.has(s.psp_ref))) {
      credits.push({ statement_id: statementId, line_no: ++lineNo, psp_ref: s.psp_ref, amount: s.amount, currency: s.currency, type: "CREDIT", credited_at: new Date().toISOString() });
    }
    return { statementId, lines: lineNo };
  });

  app.post("/admin/reset", async () => {
    latestByKey = new Map();
    charges = [];
    refunds = new Map();
    settlements = [];
    credits = [];
    Object.assign(faults, DEFAULT_FAULTS);
    return { ok: true };
  });

  return {
    app,
    options,
    faults,
    async webhooksDelivered() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
