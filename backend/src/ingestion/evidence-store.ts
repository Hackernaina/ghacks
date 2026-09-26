import type { EvidenceSource, ReportedStatus } from "@reconcile/shared";
import { EVIDENCE_INSERTED, notify } from "../db/notify.js";
import { type Db, isUuid } from "../db/pool.js";

export interface NewEvidence {
  source: EvidenceSource;
  sourceEventId: string;
  paymentId: string | null;
  psp: string | null;
  pspRef: string | null;
  idemKey: string | null;
  orderId: string | null;
  reportedStatus: ReportedStatus;
  amount: number | null;
  currency: string | null;
  observedAt: Date;
  raw: unknown;
}

export interface InsertResult {
  id: string;
  inserted: boolean;
}

/** Append-only insert. A repeat of (source, source_event_id) only bumps duplicate_count. */
export async function insertEvidence(db: Db, e: NewEvidence): Promise<InsertResult> {
  const { rows } = await db.query<{ id: string; inserted: boolean }>(
    `INSERT INTO evidence
       (source, source_event_id, payment_id, psp, psp_ref, idem_key, order_id,
        reported_status, amount, currency, observed_at, raw)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (source, source_event_id)
       DO UPDATE SET duplicate_count = evidence.duplicate_count + 1
     RETURNING id, (xmax = 0) AS inserted`,
    [
      e.source,
      e.sourceEventId,
      e.paymentId,
      e.psp,
      e.pspRef,
      e.idemKey,
      isUuid(e.orderId) ? e.orderId : null,
      e.reportedStatus,
      e.amount,
      e.currency,
      e.observedAt,
      JSON.stringify(e.raw ?? null),
    ],
  );
  return rows[0]!;
}

/** Link by idempotency key first, then by PSP reference. */
export async function findPaymentId(db: Db, idemKey: string | null, pspRef: string | null): Promise<string | null> {
  if (idemKey) {
    const { rows } = await db.query<{ id: string }>("SELECT id FROM payments WHERE idem_key = $1", [idemKey]);
    if (rows[0]) return rows[0].id;
  }
  if (pspRef) {
    const { rows } = await db.query<{ id: string }>(
      "SELECT id FROM payments WHERE psp_ref = $1 ORDER BY created_at LIMIT 1",
      [pspRef],
    );
    if (rows[0]) return rows[0].id;
  }
  return null;
}

export async function notifyEvidence(db: Db, paymentId: string | null): Promise<void> {
  await notify(db, EVIDENCE_INSERTED, paymentId ?? "orphan");
}

/** Insert, then notify the worker. Used by every ingestion path. */
export async function recordEvidence(db: Db, e: NewEvidence): Promise<InsertResult> {
  const result = await insertEvidence(db, e);
  await notifyEvidence(db, e.paymentId);
  return result;
}
