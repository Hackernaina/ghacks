import type pg from "pg";
import type { EvidenceSource, ReportedStatus } from "@reconcile/shared";
import { withTransaction } from "../db/pool.js";
import { notifyEvidence } from "../ingestion/evidence-store.js";
import { insertCases } from "../ledger/persist.js";
import { logger } from "../logger.js";

/** Retries linking unmatched evidence; opens ORPHAN cases for what still matches nothing. Returns relinked payment ids. */
export async function sweepOrphans(pool: pg.Pool): Promise<string[]> {
  const byKey = await pool.query<{ payment_id: string }>(
    `UPDATE evidence e SET payment_id = p.id
       FROM payments p
      WHERE e.payment_id IS NULL AND e.idem_key IS NOT NULL AND p.idem_key = e.idem_key
      RETURNING e.payment_id`,
  );
  const byRef = await pool.query<{ payment_id: string }>(
    `UPDATE evidence e SET payment_id = p.id
       FROM payments p
      WHERE e.payment_id IS NULL AND e.psp_ref IS NOT NULL AND p.psp_ref = e.psp_ref
      RETURNING e.payment_id`,
  );
  const linked = [...new Set([...byKey.rows, ...byRef.rows].map((r) => r.payment_id))];
  for (const id of linked) await notifyEvidence(pool, id);
  if (linked.length) logger.info({ paymentIds: linked }, "linked orphan evidence to payments");

  const { rows: orphans } = await pool.query<{
    id: string;
    source: EvidenceSource;
    source_event_id: string;
    psp_ref: string | null;
    reported_status: ReportedStatus;
    amount: number | null;
    observed_at: Date;
    received_at: Date;
  }>(
    `SELECT id, source, source_event_id, psp_ref, reported_status, amount, observed_at, received_at
       FROM evidence
      WHERE payment_id IS NULL AND received_at < now() - interval '30 seconds'
      ORDER BY received_at`,
  );

  for (const o of orphans) {
    const opened = await withTransaction(pool, (client) =>
      insertCases(
        client,
        [
          {
            caseType: "ORPHAN",
            paymentId: null,
            orderId: null,
            dedupeKey: `ORPHAN:${o.psp_ref ?? o.id}`,
            summary: `${o.source} ${o.reported_status} for ${o.psp_ref ?? "unknown pspRef"} matches no payment`,
            suggestedAction: "Investigate which order this belongs to, or dismiss",
            targetPspRef: null,
            evidenceSnapshot: [
              {
                source: o.source,
                sourceEventId: o.source_event_id,
                reportedStatus: o.reported_status,
                pspRef: o.psp_ref,
                amount: o.amount,
                observedAt: o.observed_at.toISOString(),
              },
            ],
          },
        ],
        o.received_at,
      ),
    );
    for (const c of opened) logger.warn({ caseId: c.id, pspRef: o.psp_ref }, "orphan evidence case opened");
  }
  return linked;
}
