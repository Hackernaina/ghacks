import {
  EVIDENCE_SOURCE_TRUST,
  type CaseType,
  type Confidence,
  type EvidenceSource,
  type EvidenceView,
  type LedgerEntryType,
  type LedgerEntryView,
  type OrderView,
  type PaymentState,
  type PaymentView,
  type PspId,
  type ReportedStatus,
  type ReviewCaseView,
} from "@reconcile/shared";
import type { Db } from "./pool.js";

export interface OrderRow {
  id: string;
  customer_id: string;
  amount: number;
  currency: string;
  created_at: Date;
}

export interface PaymentRow {
  id: string;
  order_id: string;
  attempt: number;
  psp: PspId;
  idem_key: string;
  psp_ref: string | null;
  amount: number;
  currency: string;
  state: PaymentState;
  confidence: Confidence | null;
  reason: string | null;
  next_check_at: Date | null;
  deadline_at: Date;
  not_found_since: Date | null;
  poll_count: number;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface EvidenceRow {
  id: string;
  source: EvidenceSource;
  source_event_id: string;
  payment_id: string | null;
  psp: string | null;
  psp_ref: string | null;
  idem_key: string | null;
  order_id: string | null;
  reported_status: ReportedStatus;
  amount: number | null;
  currency: string | null;
  observed_at: Date;
  received_at: Date;
  duplicate_count: number;
  raw: unknown;
}

export interface LedgerRow {
  id: string;
  payment_id: string;
  order_id: string;
  psp_ref: string;
  entry_type: LedgerEntryType;
  amount: number;
  created_at: Date;
}

export interface CaseRow {
  id: string;
  payment_id: string | null;
  order_id: string | null;
  case_type: CaseType;
  status: "OPEN" | "RESOLVED";
  summary: string;
  suggested_action: string | null;
  evidence_snapshot: { targetPspRef?: string | null } | unknown[];
  resolution: string | null;
  note: string | null;
  dedupe_key: string;
  created_at: Date;
  resolved_at: Date | null;
}

export function orderView(r: OrderRow): OrderView {
  return { id: r.id, customerId: r.customer_id, amount: r.amount, currency: r.currency, createdAt: r.created_at.toISOString() };
}

export function paymentView(r: PaymentRow): PaymentView {
  return {
    id: r.id,
    orderId: r.order_id,
    attempt: r.attempt,
    psp: r.psp,
    pspRef: r.psp_ref,
    amount: r.amount,
    currency: r.currency,
    state: r.state,
    confidence: r.confidence,
    reason: r.reason,
    updatedAt: r.updated_at.toISOString(),
  };
}

export function evidenceView(r: EvidenceRow): EvidenceView {
  return {
    id: r.id,
    source: r.source,
    trust: EVIDENCE_SOURCE_TRUST[r.source],
    reportedStatus: r.reported_status,
    pspRef: r.psp_ref,
    amount: r.amount,
    observedAt: r.observed_at.toISOString(),
    receivedAt: r.received_at.toISOString(),
    duplicateCount: r.duplicate_count,
    raw: r.raw,
  };
}

export function ledgerView(r: LedgerRow): LedgerEntryView {
  return {
    id: r.id,
    paymentId: r.payment_id,
    orderId: r.order_id,
    pspRef: r.psp_ref,
    entryType: r.entry_type,
    amount: r.amount,
    createdAt: r.created_at.toISOString(),
  };
}

export function caseView(r: CaseRow): ReviewCaseView {
  return {
    id: r.id,
    caseType: r.case_type,
    paymentId: r.payment_id,
    orderId: r.order_id,
    status: r.status,
    summary: r.summary,
    suggestedAction: r.suggested_action,
    resolution: r.resolution,
    note: r.note,
    createdAt: r.created_at.toISOString(),
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
  };
}

export function targetPspRefOf(r: CaseRow): string | null {
  const snap = r.evidence_snapshot;
  return !Array.isArray(snap) && snap && typeof snap.targetPspRef === "string" ? snap.targetPspRef : null;
}

export async function loadPayment(db: Db, id: string): Promise<PaymentRow | null> {
  const { rows } = await db.query<PaymentRow>("SELECT * FROM payments WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function loadPaymentView(db: Db, id: string): Promise<PaymentView | null> {
  const row = await loadPayment(db, id);
  return row ? paymentView(row) : null;
}
