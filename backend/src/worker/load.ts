import type pg from "pg";
import type { Config } from "../config/index.js";
import type { EvidenceRow, PaymentRow } from "../db/rows.js";
import type { ResolveInput, ResolverEvidence } from "../resolver/index.js";

export interface LockedPayment extends PaymentRow {
  customer_id: string;
  due: boolean;
}

/** Row-locks the payment; returns null if another worker holds it. */
export async function lockPayment(client: pg.PoolClient, id: string): Promise<LockedPayment | null> {
  const { rows } = await client.query<LockedPayment>(
    `SELECT p.*, o.customer_id,
            (p.next_check_at IS NOT NULL AND p.next_check_at <= now()) AS due
       FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE p.id = $1
        FOR UPDATE OF p SKIP LOCKED`,
    [id],
  );
  return rows[0] ?? null;
}

function toResolverEvidence(r: EvidenceRow): ResolverEvidence {
  return {
    id: r.id,
    source: r.source,
    sourceEventId: r.source_event_id,
    pspRef: r.psp_ref,
    reportedStatus: r.reported_status,
    amount: r.amount,
    currency: r.currency,
    observedAt: r.observed_at,
    duplicateCount: r.duplicate_count,
  };
}

export interface LoadedInput {
  input: ResolveInput;
  latestEvidenceAt: Date;
}

export async function loadResolveInput(
  client: pg.PoolClient,
  payment: LockedPayment,
  config: Config,
  now: Date,
): Promise<LoadedInput> {
  const evidence = await client.query<EvidenceRow>("SELECT * FROM evidence WHERE payment_id = $1", [payment.id]);
  const siblings = await client.query<{ id: string; attempt: number; state: PaymentRow["state"]; psp_ref: string | null }>(
    "SELECT id, attempt, state, psp_ref FROM payments WHERE order_id = $1 AND id <> $2",
    [payment.order_id, payment.id],
  );
  const suspects = await client.query<{ id: string; order_id: string; success_at: Date }>(
    `SELECT p.id, p.order_id, MIN(e.observed_at) AS success_at
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       JOIN evidence e ON e.payment_id = p.id AND e.reported_status IN ('SUCCEEDED', 'SETTLED', 'CREDITED')
      WHERE o.customer_id = $1 AND p.amount = $2 AND p.order_id <> $3
        AND p.state IN ('SUCCEEDED', 'SETTLED')
      GROUP BY p.id, p.order_id`,
    [payment.customer_id, payment.amount, payment.order_id],
  );
  const ledger = await client.query<{ psp_ref: string; entry_type: "CAPTURE" | "REFUND" | "REVERSAL" }>(
    "SELECT psp_ref, entry_type FROM ledger_entries WHERE payment_id = $1",
    [payment.id],
  );

  const latestEvidenceAt = evidence.rows.reduce(
    (max, e) => (e.received_at > max ? e.received_at : max),
    new Date(0),
  );

  return {
    latestEvidenceAt,
    input: {
      payment: {
        id: payment.id,
        orderId: payment.order_id,
        customerId: payment.customer_id,
        attempt: payment.attempt,
        psp: payment.psp,
        pspRef: payment.psp_ref,
        amount: payment.amount,
        currency: payment.currency,
        state: payment.state,
        deadlineAt: payment.deadline_at,
        notFoundSince: payment.not_found_since,
        pollCount: payment.poll_count,
      },
      evidence: evidence.rows.map(toResolverEvidence),
      siblingsForOrder: siblings.rows.map((s) => ({ id: s.id, attempt: s.attempt, state: s.state, pspRef: s.psp_ref })),
      suspects: suspects.rows.map((s) => ({ id: s.id, orderId: s.order_id, successAt: s.success_at })),
      postedLedger: ledger.rows.map((l) => ({ pspRef: l.psp_ref, entryType: l.entry_type })),
      now,
      config,
    },
  };
}
