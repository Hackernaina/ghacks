import type pg from "pg";
import type { CaseDraft, LedgerPosting } from "../resolver/index.js";

/** Idempotent on UNIQUE (psp_ref, entry_type). Returns the postings actually written. */
export async function insertPostings(client: pg.PoolClient, postings: LedgerPosting[]): Promise<LedgerPosting[]> {
  const written: LedgerPosting[] = [];
  for (const p of postings) {
    const { rowCount } = await client.query(
      `INSERT INTO ledger_entries (payment_id, order_id, psp_ref, entry_type, amount)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (psp_ref, entry_type) DO NOTHING`,
      [p.paymentId, p.orderId, p.pspRef, p.entryType, p.amount],
    );
    if (rowCount) written.push(p);
  }
  return written;
}

export interface OpenedCase {
  id: string;
  draft: CaseDraft;
}

/**
 * Idempotent on the partial unique index (dedupe_key) WHERE status = 'OPEN'.
 * A case an operator already resolved is not reopened unless evidence arrived
 * after the resolution.
 */
export async function insertCases(
  client: pg.PoolClient,
  cases: CaseDraft[],
  latestEvidenceAt: Date,
): Promise<OpenedCase[]> {
  const opened: OpenedCase[] = [];
  for (const c of cases) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO review_cases
         (payment_id, order_id, case_type, summary, suggested_action, evidence_snapshot, dedupe_key)
       SELECT $1, $2, $3, $4, $5, $6, $7
        WHERE NOT EXISTS (
          SELECT 1 FROM review_cases
           WHERE dedupe_key = $7 AND status = 'RESOLVED' AND resolved_at >= $8::timestamptz)
       ON CONFLICT (dedupe_key) WHERE status = 'OPEN' DO NOTHING
       RETURNING id`,
      [
        c.paymentId,
        c.orderId,
        c.caseType,
        c.summary,
        c.suggestedAction,
        JSON.stringify({ targetPspRef: c.targetPspRef, evidence: c.evidenceSnapshot }),
        c.dedupeKey,
        latestEvidenceAt,
      ],
    );
    if (rows[0]) opened.push({ id: rows[0].id, draft: c });
  }
  return opened;
}
