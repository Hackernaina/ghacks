import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import {
  CreatePaymentRequest,
  CreateRefundRequest,
  SETTLEMENT_CSV_HEADER,
  type PspPaymentResponse,
  type PspRefundResponse,
} from "@reconcile/shared";
import { payOutToBank } from "./payout.js";
import {
  addPayment,
  getPayment,
  addSettlement,
  idempotencyStore,
  refundStore,
  settlementLog,
  getSettlements,
  getFaultConfig,
  setFaultConfig,
  clearStore,
  type FaultConfig,
} from "./store.js";
import { fireWebhook } from "./webhooks.js";
import { applyFaultMiddleware } from "./faults.js";

// A new id per process start: in-memory line numbers restart at 1, and
// (batch_id, line_no) must never repeat for a different line.
const BOOT_ID = randomUUID().slice(0, 6);

export interface PspServerOptions {
  pspId?: "psp_a" | "psp_b";
  port?: number;
  webhookSecret?: string;
}

export function buildPspServer(options?: PspServerOptions): FastifyInstance {
  const pspId =
    options?.pspId ??
    ((process.env.PSP_ID === "psp_b" ? "psp_b" : "psp_a") as "psp_a" | "psp_b");
  const defaultPort = pspId === "psp_b" ? 4002 : 4001;
  const port = options?.port ?? (Number(process.env.PORT) || defaultPort);
  const defaultSecret = pspId === "psp_b" ? "dev-secret-psp-b" : "dev-secret-psp-a";
  const webhookSecret =
    options?.webhookSecret ||
    process.env.WEBHOOK_SECRET ||
    (pspId === "psp_b"
      ? process.env.WEBHOOK_SECRET_PSP_B || defaultSecret
      : process.env.WEBHOOK_SECRET_PSP_A || defaultSecret);

  const app = Fastify({
    logger: false,
  });

  // Register fault-injection preHandler hook (dropPercent, bypassIdempotency)
  applyFaultMiddleware(app, getFaultConfig);

  // Health check
  app.get("/healthz", async () => ({
    ok: true,
    pspId,
    port,
  }));

  // POST /v1/payments
  app.post("/v1/payments", async (req, reply) => {
    const idempotencyHeader = req.headers["idempotency-key"];
    if (!idempotencyHeader || typeof idempotencyHeader !== "string") {
      return reply.code(400).send({
        error: "MISSING_IDEMPOTENCY_KEY",
        message: "Idempotency-Key header is required",
      });
    }

    const idempotencyKey = idempotencyHeader.trim();
    // Validate format: orderId:attempt
    const colonIndex = idempotencyKey.indexOf(":");
    if (colonIndex <= 0 || colonIndex === idempotencyKey.length - 1) {
      return reply.code(400).send({
        error: "INVALID_IDEMPOTENCY_KEY",
        message: "Idempotency-Key header must be in format orderId:attempt",
      });
    }

    // Validate body
    const bodyResult = CreatePaymentRequest.safeParse(req.body);
    if (!bodyResult.success) {
      return reply.code(422).send({
        error: "VALIDATION_ERROR",
        message: bodyResult.error.message,
      });
    }
    const body = bodyResult.data;

    // Check idempotency store
    const existing = getPayment(idempotencyKey);
    if (existing) {
      return reply.code(200).send(existing);
    }

    // Generate pspRef: "pa_" + randomUUID().slice(0,8) for PSP A, "pb_" for PSP B
    const prefix = pspId === "psp_b" ? "pb_" : "pa_";
    const pspRef = `${prefix}${randomUUID().slice(0, 8)}`;
    const createdAt = new Date().toISOString();

    const response: PspPaymentResponse = {
      pspRef,
      idempotencyKey,
      status: "SUCCEEDED",
      amount: body.amount,
      currency: body.currency,
      createdAt,
    };

    addPayment(idempotencyKey, response);

    // Fire webhook asynchronously (fire-and-forget, retries internally)
    fireWebhook({
      pspId,
      webhookSecret,
      payment: { ...response, orderId: body.orderId },
    });

    // Record settlement, then pay it out to the merchant's bank
    const dateStr = createdAt.slice(0, 10).replace(/-/g, "");
    const settlement = {
      batch_id: `stl_${dateStr}_${BOOT_ID}`,
      line_no: settlementLog.size + 1,
      psp_ref: pspRef,
      idempotency_key: idempotencyKey,
      order_id: body.orderId,
      amount: body.amount,
      currency: body.currency,
      status: "SETTLED" as const,
      settled_at: createdAt,
    };
    addSettlement(settlement);
    payOutToBank(settlement);

    return reply.code(200).send(response);
  });

  // GET /v1/payments?idempotency_key=K
  app.get("/v1/payments", async (req, reply) => {
    const query = req.query as { idempotency_key?: string };
    const key = query.idempotency_key;
    if (!key) {
      return reply.code(400).send({
        error: "MISSING_IDEMPOTENCY_KEY",
        message: "idempotency_key query parameter is required",
      });
    }

    const payment = getPayment(key);
    if (!payment) {
      return reply.code(404).send({ error: "NOT_FOUND" });
    }

    return reply.code(200).send(payment);
  });

  // POST /v1/refunds — idempotent by Idempotency-Key; fires payment.refunded
  app.post("/v1/refunds", async (req, reply) => {
    const key = req.headers["idempotency-key"];
    if (!key || typeof key !== "string") {
      return reply.code(400).send({
        error: "MISSING_IDEMPOTENCY_KEY",
        message: "Idempotency-Key header is required",
      });
    }
    const bodyResult = CreateRefundRequest.safeParse(req.body);
    if (!bodyResult.success) {
      return reply.code(422).send({ error: "VALIDATION_ERROR", message: bodyResult.error.message });
    }
    const existing = refundStore.get(key.trim());
    if (existing) return reply.code(200).send(existing);

    const { pspRef, amount } = bodyResult.data;
    const charge = [...idempotencyStore.values()].find((p) => p.pspRef === pspRef);
    const settled = [...settlementLog.values()].find((s) => s.psp_ref === pspRef);
    if (!charge || !settled) {
      return reply.code(422).send({ error: "UNKNOWN_PSP_REF", message: `No charge ${pspRef}` });
    }
    if (amount <= 0 || amount > charge.amount) {
      return reply.code(422).send({ error: "INVALID_AMOUNT", message: "Refund must be between 1 and the charge amount" });
    }

    const refund: PspRefundResponse = {
      refundRef: `rf_${randomUUID().slice(0, 8)}`,
      pspRef,
      status: "SUCCEEDED",
      amount,
    };
    refundStore.set(key.trim(), refund);
    fireWebhook({
      pspId,
      webhookSecret,
      payment: { ...charge, amount, orderId: settled.order_id },
      type: "payment.refunded",
      status: "REFUNDED",
    });
    return reply.code(200).send(refund);
  });

  // GET /v1/settlements?since=ISO_TIMESTAMP
  app.get("/v1/settlements", async (req, reply) => {
    const query = req.query as { since?: string };
    const faults = getFaultConfig();
    let settlements = getSettlements(query.since);

    if (faults.settlementMismatch && settlements.length > 0) {
      // Randomly drop ~30% of rows, ensuring at least 1 row is dropped so CSV differs
      let filtered = settlements.filter(() => Math.random() * 100 >= 30);
      if (filtered.length === settlements.length) {
        filtered = filtered.slice(0, -1);
      }
      settlements = filtered;
    }

    const rows = [SETTLEMENT_CSV_HEADER];
    for (const s of settlements) {
      rows.push(
        `${s.batch_id},${s.line_no},${s.psp_ref},${s.idempotency_key},${s.order_id},${s.amount},${s.currency},${s.status},${s.settled_at}`
      );
    }

    const csvContent = rows.join("\n") + "\n";
    reply.header("content-type", "text/csv; charset=utf-8");
    return reply.code(200).send(csvContent);
  });

  // POST /admin/faults
  app.post("/admin/faults", async (req, reply) => {
    const faults = req.body as Partial<FaultConfig>;
    setFaultConfig(faults ?? {});
    return reply.code(200).send({ ok: true, faults: getFaultConfig() });
  });

  // GET /admin/faults
  app.get("/admin/faults", async () => ({
    ok: true,
    faults: getFaultConfig(),
  }));

  // POST /admin/reset
  app.post("/admin/reset", async () => {
    clearStore();
    return { ok: true };
  });

  return app;
}

export async function start(options?: PspServerOptions): Promise<FastifyInstance> {
  const pspId =
    options?.pspId ??
    ((process.env.PSP_ID === "psp_b" ? "psp_b" : "psp_a") as "psp_a" | "psp_b");
  const defaultPort = pspId === "psp_b" ? 4002 : 4001;
  const port = options?.port ?? (Number(process.env.PORT) || defaultPort);

  const server = buildPspServer(options);
  try {
    await server.listen({ port, host: "0.0.0.0" });
    console.log(`Mock PSP (${pspId}) running on port ${port}`);
    return server;
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("index.ts") ||
    process.argv[1].endsWith("index.js") ||
    (import.meta.url.startsWith("file:") &&
      path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))));

if (isDirectRun) {
  start().catch((err) => {
    console.error("Failed to start PSP mock server:", err);
    process.exit(1);
  });
}
