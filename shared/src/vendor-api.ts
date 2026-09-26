import { z } from "zod";
import { Currency, MinorUnits } from "./money.js";
import { CaseType, Confidence, EvidenceSource, LedgerEntryType, PaymentState, PspId, ReportedStatus } from "./enums.js";

export const CreateOrderRequest = z.object({
  customerId: z.string(),
  amount: MinorUnits,
  currency: Currency,
});
export type CreateOrderRequest = z.infer<typeof CreateOrderRequest>;

export const OrderView = z.object({
  id: z.string(),
  customerId: z.string(),
  amount: MinorUnits,
  currency: Currency,
  createdAt: z.string().datetime({ offset: true }),
});
export type OrderView = z.infer<typeof OrderView>;

export const PayOrderRequest = z.object({
  psp: PspId.optional(),
});
export type PayOrderRequest = z.infer<typeof PayOrderRequest>;

export const PaymentView = z.object({
  id: z.string(),
  orderId: z.string(),
  attempt: z.number().int(),
  psp: PspId,
  pspRef: z.string().nullable(),
  amount: MinorUnits,
  currency: Currency,
  state: PaymentState,
  confidence: Confidence.nullable(),
  reason: z.string().nullable(),
  updatedAt: z.string().datetime({ offset: true }),
});
export type PaymentView = z.infer<typeof PaymentView>;

export const OrderWithPaymentsView = z.object({
  order: OrderView,
  payments: z.array(PaymentView),
});
export type OrderWithPaymentsView = z.infer<typeof OrderWithPaymentsView>;

// ---- Admin API (Section 3.5) ----

export const EvidenceView = z.object({
  id: z.string(),
  source: EvidenceSource,
  trust: z.number().int(),
  reportedStatus: ReportedStatus,
  pspRef: z.string().nullable(),
  amount: MinorUnits.nullable(),
  observedAt: z.string().datetime({ offset: true }),
  receivedAt: z.string().datetime({ offset: true }),
  duplicateCount: z.number().int(),
  raw: z.unknown(),
});
export type EvidenceView = z.infer<typeof EvidenceView>;

export const LedgerEntryView = z.object({
  id: z.string(),
  paymentId: z.string(),
  orderId: z.string(),
  pspRef: z.string(),
  entryType: LedgerEntryType,
  amount: MinorUnits,
  createdAt: z.string().datetime({ offset: true }),
});
export type LedgerEntryView = z.infer<typeof LedgerEntryView>;

export const ReviewCaseView = z.object({
  id: z.string(),
  caseType: CaseType,
  paymentId: z.string().nullable(),
  orderId: z.string().nullable(),
  status: z.enum(["OPEN", "RESOLVED"]),
  summary: z.string(),
  suggestedAction: z.string().nullable(),
  resolution: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  resolvedAt: z.string().datetime({ offset: true }).nullable(),
});
export type ReviewCaseView = z.infer<typeof ReviewCaseView>;

export const PaymentDetailView = z.object({
  payment: PaymentView,
  evidence: z.array(EvidenceView),
  ledger: z.array(LedgerEntryView),
  cases: z.array(ReviewCaseView),
});
export type PaymentDetailView = z.infer<typeof PaymentDetailView>;

export const AdminPaymentsQuery = z.object({
  state: PaymentState.optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  cursor: z.string().optional(),
});
export type AdminPaymentsQuery = z.infer<typeof AdminPaymentsQuery>;

export const PagedPaymentsView = z.object({
  items: z.array(PaymentView),
  nextCursor: z.string().nullable(),
});
export type PagedPaymentsView = z.infer<typeof PagedPaymentsView>;

export const ResolveCaseRequest = z.object({
  resolution: z.enum(["MARK_SUCCEEDED", "MARK_FAILED", "REFUND", "DISMISS"]),
  note: z.string().optional(),
});
export type ResolveCaseRequest = z.infer<typeof ResolveCaseRequest>;

export const InvariantCheck = z.object({
  name: z.string(),
  ok: z.boolean(),
  details: z.array(z.unknown()),
});
export type InvariantCheck = z.infer<typeof InvariantCheck>;

export const InvariantsView = z.object({
  ok: z.boolean(),
  checks: z.array(InvariantCheck),
});
export type InvariantsView = z.infer<typeof InvariantsView>;

export const StatsView = z.object({
  byState: z.record(PaymentState, z.number().int()),
  openCasesByType: z.record(CaseType, z.number().int()),
  totalEvidence: z.number().int(),
  duplicatesSuppressed: z.number().int(),
});
export type StatsView = z.infer<typeof StatsView>;
