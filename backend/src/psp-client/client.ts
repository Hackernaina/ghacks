import {
  type CreatePaymentRequest,
  type CreateRefundRequest,
  PspPaymentResponse,
  PspRefundResponse,
  type PspId,
} from "@reconcile/shared";
import { type Config, pspUrlFor } from "../config/index.js";
import { logger } from "../logger.js";

export type CreateOutcome =
  | { kind: "ok"; body: PspPaymentResponse }
  | { kind: "rejected"; body: unknown }
  | { kind: "unknown"; reason: string };

export type QueryOutcome = { kind: "ok"; body: PspPaymentResponse } | { kind: "not_found" } | { kind: "unknown"; reason: string };

export type RefundOutcome =
  | { kind: "ok"; body: PspRefundResponse }
  | { kind: "rejected"; body: unknown }
  | { kind: "unknown"; reason: string };

export interface PspClient {
  createPayment(psp: PspId, idempotencyKey: string, body: CreatePaymentRequest): Promise<CreateOutcome>;
  getPayment(psp: PspId, idempotencyKey: string): Promise<QueryOutcome>;
  refund(psp: PspId, idempotencyKey: string, body: CreateRefundRequest): Promise<RefundOutcome>;
}

type RawResult = { status: number; body: unknown } | { error: string };

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<RawResult> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON bodies are kept as text for the evidence record.
    }
    return { status: res.status, body };
  } catch (err) {
    return { error: (err as Error).name === "TimeoutError" ? "timeout" : (err as Error).message };
  }
}

export function createPspClient(config: Config): PspClient {
  const timeout = config.PSP_TIMEOUT_MS;

  function post(psp: PspId, path: string, key: string, body: unknown) {
    return request(
      `${pspUrlFor(config, psp)}${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(body),
      },
      timeout,
    );
  }

  function unknown(context: Record<string, unknown>, raw: RawResult): { kind: "unknown"; reason: string } {
    const reason = "error" in raw ? raw.error : `HTTP ${raw.status}`;
    logger.warn({ ...context, reason }, "PSP call outcome unknown");
    return { kind: "unknown", reason };
  }

  return {
    async createPayment(psp, idempotencyKey, body) {
      const raw = await post(psp, "/v1/payments", idempotencyKey, body);
      const ctx = { psp, idempotencyKey, call: "createPayment" };
      if ("error" in raw) return unknown(ctx, raw);
      if (raw.status === 422) return { kind: "rejected", body: raw.body };
      if (raw.status === 200) {
        const parsed = PspPaymentResponse.safeParse(raw.body);
        if (parsed.success) return { kind: "ok", body: parsed.data };
        logger.error({ ...ctx, issues: parsed.error.issues }, "PSP 200 response failed contract validation");
      }
      return unknown(ctx, raw);
    },

    async getPayment(psp, idempotencyKey) {
      const url = `${pspUrlFor(config, psp)}/v1/payments?idempotency_key=${encodeURIComponent(idempotencyKey)}`;
      const raw = await request(url, { method: "GET" }, timeout);
      const ctx = { psp, idempotencyKey, call: "getPayment" };
      if ("error" in raw) return unknown(ctx, raw);
      if (raw.status === 404) return { kind: "not_found" };
      if (raw.status === 200) {
        const parsed = PspPaymentResponse.safeParse(raw.body);
        if (parsed.success) return { kind: "ok", body: parsed.data };
        logger.error({ ...ctx, issues: parsed.error.issues }, "PSP 200 response failed contract validation");
      }
      return unknown(ctx, raw);
    },

    async refund(psp, idempotencyKey, body) {
      const raw = await post(psp, "/v1/refunds", idempotencyKey, body);
      const ctx = { psp, idempotencyKey, call: "refund" };
      if ("error" in raw) return unknown(ctx, raw);
      if (raw.status === 422) return { kind: "rejected", body: raw.body };
      if (raw.status === 200) {
        const parsed = PspRefundResponse.safeParse(raw.body);
        if (parsed.success) return { kind: "ok", body: parsed.data };
        logger.error({ ...ctx, issues: parsed.error.issues }, "PSP refund response failed contract validation");
      }
      return unknown(ctx, raw);
    },
  };
}
