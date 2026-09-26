import { createHash } from "node:crypto";
import type pg from "pg";
import type { Config } from "../config/index.js";
import type { PaymentRow } from "../db/rows.js";
import { logger } from "../logger.js";
import type { CreateOutcome, PspClient, QueryOutcome, RefundOutcome } from "../psp-client/client.js";
import { recordEvidence } from "./evidence-store.js";

async function nextRequestSeq(pool: pg.Pool, idemKey: string): Promise<number> {
  const { rows } = await pool.query<{ seq: number }>(
    "SELECT count(*) + 1 AS seq FROM evidence WHERE source = 'SYNC_RESPONSE' AND idem_key = $1",
    [idemKey],
  );
  return rows[0]!.seq;
}

async function rememberPspRef(pool: pg.Pool, paymentId: string, pspRef: string): Promise<void> {
  await pool.query("UPDATE payments SET psp_ref = $2 WHERE id = $1 AND psp_ref IS NULL", [paymentId, pspRef]);
}

/**
 * Records the answer to POST /v1/payments. Only an answer is evidence: a
 * timeout or 5xx inserts nothing and (for the first send) moves the payment
 * to UNKNOWN so the worker polls by idempotency key.
 */
export async function recordCreateOutcome(
  pool: pg.Pool,
  config: Config,
  payment: PaymentRow,
  outcome: CreateOutcome,
  opts: { markUnknownOnFailure: boolean },
): Promise<void> {
  const base = {
    source: "SYNC_RESPONSE" as const,
    paymentId: payment.id,
    psp: payment.psp,
    idemKey: payment.idem_key,
    orderId: payment.order_id,
    observedAt: new Date(),
  };

  if (outcome.kind === "ok") {
    const seq = await nextRequestSeq(pool, payment.idem_key);
    await rememberPspRef(pool, payment.id, outcome.body.pspRef);
    await recordEvidence(pool, {
      ...base,
      sourceEventId: `sync:${payment.idem_key}:${seq}`,
      pspRef: outcome.body.pspRef,
      reportedStatus: outcome.body.status,
      amount: outcome.body.amount,
      currency: outcome.body.currency,
      raw: outcome.body,
    });
    return;
  }

  if (outcome.kind === "rejected") {
    const seq = await nextRequestSeq(pool, payment.idem_key);
    await recordEvidence(pool, {
      ...base,
      sourceEventId: `sync:${payment.idem_key}:${seq}`,
      pspRef: null,
      reportedStatus: "FAILED",
      amount: null,
      currency: null,
      raw: { status: 422, body: outcome.body },
    });
    return;
  }

  logger.warn({ paymentId: payment.id, reason: outcome.reason }, "PSP create outcome unknown; not evidence");
  if (opts.markUnknownOnFailure) {
    await pool.query(
      `UPDATE payments
          SET state = 'UNKNOWN',
              next_check_at = now() + ($2::double precision * interval '1 millisecond'),
              version = version + 1, updated_at = now()
        WHERE id = $1 AND state IN ('CREATED', 'PENDING')`,
      [payment.id, config.POLL_BASE_MS],
    );
  }
}

export function statusQueryEventId(idemKey: string, status: string, pspRef: string | null, amount: number | null): string {
  const hash = createHash("sha256").update(`${status}${pspRef ?? ""}${amount ?? ""}`).digest("hex");
  return `poll:${idemKey}:${hash}`;
}

/** Records a status-query answer. Identical answers collapse into one row; a changed answer is new evidence. */
export async function recordQueryOutcome(pool: pg.Pool, payment: PaymentRow, outcome: QueryOutcome): Promise<void> {
  if (outcome.kind === "unknown") return;
  const base = {
    source: "STATUS_QUERY" as const,
    paymentId: payment.id,
    psp: payment.psp,
    idemKey: payment.idem_key,
    orderId: payment.order_id,
    observedAt: new Date(),
  };
  if (outcome.kind === "not_found") {
    await recordEvidence(pool, {
      ...base,
      sourceEventId: statusQueryEventId(payment.idem_key, "NOT_FOUND", null, null),
      pspRef: null,
      reportedStatus: "NOT_FOUND",
      amount: null,
      currency: null,
      raw: { status: 404, error: "NOT_FOUND" },
    });
    return;
  }
  const b = outcome.body;
  await rememberPspRef(pool, payment.id, b.pspRef);
  await recordEvidence(pool, {
    ...base,
    sourceEventId: statusQueryEventId(payment.idem_key, b.status, b.pspRef, b.amount),
    pspRef: b.pspRef,
    reportedStatus: b.status,
    amount: b.amount,
    currency: b.currency,
    raw: b,
  });
}

/**
 * Calls the PSP refund endpoint with key refund:${pspRef} and records the
 * answer. A refund that isn't confirmed is recorded as PROCESSING, never as
 * a claim about the original charge.
 */
export async function issueRefund(
  pool: pg.Pool,
  psp: PspClient,
  payment: PaymentRow,
  pspRef: string,
): Promise<RefundOutcome> {
  const outcome = await psp.refund(payment.psp, `refund:${pspRef}`, { pspRef, amount: payment.amount });
  if (outcome.kind !== "ok") return outcome;
  await recordEvidence(pool, {
    source: "SYNC_RESPONSE",
    sourceEventId: `sync:refund:${pspRef}:${outcome.body.refundRef}`,
    paymentId: payment.id,
    psp: payment.psp,
    pspRef,
    idemKey: null,
    orderId: payment.order_id,
    reportedStatus: outcome.body.status === "SUCCEEDED" ? "REFUNDED" : "PROCESSING",
    amount: outcome.body.amount,
    currency: payment.currency,
    observedAt: new Date(),
    raw: outcome.body,
  });
  return outcome;
}
