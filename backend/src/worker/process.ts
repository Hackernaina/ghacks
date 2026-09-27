import type pg from "pg";
import type { Config } from "../config/index.js";
import { notify, PAYMENT_UPDATED } from "../db/notify.js";
import type { PaymentRow } from "../db/rows.js";
import { issueRefund, recordCreateOutcome, recordQueryOutcome } from "../ingestion/outbound.js";
import { insertCases, insertPostings, type OpenedCase } from "../ledger/persist.js";
import { logger } from "../logger.js";
import type { PspClient } from "../psp-client/client.js";
import { resolve, type Resolution } from "../resolver/index.js";
import { type LockedPayment, loadResolveInput, lockPayment } from "./load.js";

export interface WorkerDeps {
  config: Config;
  pool: pg.Pool;
  psp: PspClient;
}

interface Resolved {
  payment: LockedPayment;
  resolution: Resolution;
  opened: OpenedCase[];
}

async function persistResolution(
  client: pg.PoolClient,
  payment: LockedPayment,
  resolution: Resolution,
): Promise<boolean> {
  const setNotFound = resolution.markNotFoundSince !== undefined;
  const { rowCount } = await client.query(
    `UPDATE payments
        SET state = $3, confidence = $4, reason = $5, next_check_at = $6,
            not_found_since = CASE WHEN $7::boolean THEN $8::timestamptz ELSE not_found_since END,
            version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2`,
    [
      payment.id,
      payment.version,
      resolution.state,
      resolution.confidence,
      resolution.reason,
      resolution.nextCheckAt,
      setNotFound,
      resolution.markNotFoundSince ?? null,
    ],
  );
  return rowCount === 1;
}

/** Transaction A: load, resolve, persist. Never spans an HTTP call. */
async function resolveOnce(deps: WorkerDeps, id: string): Promise<Resolved | null | "retry"> {
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const payment = await lockPayment(client, id);
    if (!payment) {
      await client.query("ROLLBACK");
      return null;
    }
    const { input, latestEvidenceAt } = await loadResolveInput(client, payment, deps.config, new Date());
    const resolution = resolve(input);
    if (!(await persistResolution(client, payment, resolution))) {
      await client.query("ROLLBACK");
      return "retry";
    }
    const posted = await insertPostings(client, resolution.ledgerPostings);
    const opened = await insertCases(client, resolution.cases, latestEvidenceAt);
    await client.query("COMMIT");

    if (payment.state !== resolution.state) {
      logger.info(
        { paymentId: id, from: payment.state, to: resolution.state, reason: resolution.reason },
        "payment state changed",
      );
    }
    for (const p of posted) logger.info(p, "ledger posting written");
    for (const c of opened) logger.info({ paymentId: c.draft.paymentId, caseId: c.id, caseType: c.draft.caseType }, "review case opened");
    return { payment, resolution, opened };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function followUp(deps: WorkerDeps, { payment, resolution, opened }: Resolved): Promise<void> {
  const current: PaymentRow = { ...payment, state: resolution.state };

  if (resolution.needsPoll && payment.due) {
    const outcome = await deps.psp.getPayment(payment.psp, payment.idem_key);
    await recordQueryOutcome(deps.pool, current, outcome);
    await deps.pool.query("UPDATE payments SET poll_count = poll_count + 1 WHERE id = $1", [payment.id]);
  }

  if (resolution.action === "RESEND_SAME_KEY") {
    logger.info({ paymentId: payment.id, idemKey: payment.idem_key }, "resending payment with the same idempotency key");
    const outcome = await deps.psp.createPayment(payment.psp, payment.idem_key, {
      amount: payment.amount,
      currency: payment.currency,
      orderId: payment.order_id,
      merchantPaymentId: payment.id,
      customerId: payment.customer_id,
    });
    await recordCreateOutcome(deps.pool, deps.config, current, outcome, { markUnknownOnFailure: false });
  }

  if (deps.config.AUTO_REFUND_DUPLICATES) {
    for (const c of opened) {
      if (c.draft.caseType !== "DOUBLE_CHARGE" || !c.draft.targetPspRef || !c.draft.paymentId) continue;
      const target = await deps.pool.query<PaymentRow>("SELECT * FROM payments WHERE id = $1", [c.draft.paymentId]);
      if (!target.rows[0]) continue;
      const outcome = await issueRefund(deps.pool, deps.psp, target.rows[0], c.draft.targetPspRef);
      logger.info({ caseId: c.id, pspRef: c.draft.targetPspRef, outcome: outcome.kind }, "auto-refund of duplicate charge");
    }
  }
}

/** Resolves one payment and runs any outbound follow-up. Returns the resolution, or null if skipped. */
export async function processPayment(deps: WorkerDeps, id: string): Promise<Resolution | null> {
  let resolved = await resolveOnce(deps, id);
  if (resolved === "retry") resolved = await resolveOnce(deps, id);
  if (resolved === "retry") {
    logger.warn({ paymentId: id }, "payment version changed twice during resolve; leaving for the next sweep");
    return null;
  }
  if (!resolved) return null;
  await notify(deps.pool, PAYMENT_UPDATED, id);
  await followUp(deps, resolved);
  return resolved.resolution;
}
