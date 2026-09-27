import { z } from "zod";

export const PaymentState = z.enum([
  "CREATED",
  "PENDING",
  "UNKNOWN",
  "SUCCEEDED",
  "FAILED",
  "SETTLED",
  "REFUNDED",
]);
export type PaymentState = z.infer<typeof PaymentState>;

export const EvidenceSource = z.enum([
  "MANUAL",
  "BANK_STATEMENT",
  "SETTLEMENT",
  "STATUS_QUERY",
  "WEBHOOK",
  "SYNC_RESPONSE",
]);
export type EvidenceSource = z.infer<typeof EvidenceSource>;

/** Trust ranking used by the resolver to pick a winning claim; higher wins ties by recency. */
export const EVIDENCE_SOURCE_TRUST: Record<EvidenceSource, number> = {
  MANUAL: 100,
  BANK_STATEMENT: 95,
  SETTLEMENT: 90,
  STATUS_QUERY: 70,
  WEBHOOK: 60,
  SYNC_RESPONSE: 50,
};

export const ReportedStatus = z.enum([
  "SUCCEEDED",
  "FAILED",
  "PROCESSING",
  "NOT_FOUND",
  "SETTLED",
  "CREDITED",
  "REFUNDED",
]);
export type ReportedStatus = z.infer<typeof ReportedStatus>;

export const Confidence = z.enum(["HIGH", "MEDIUM", "LOW"]);
export type Confidence = z.infer<typeof Confidence>;

export const CaseType = z.enum([
  "CONFLICT",
  "AMOUNT_MISMATCH",
  "UNRESOLVED",
  "SETTLED_BUT_FAILED",
  "SETTLEMENT_MISSING",
  "BANK_NOT_CREDITED",
  "DOUBLE_CHARGE",
  "SUSPECTED_DUPLICATE",
  "ORPHAN",
]);
export type CaseType = z.infer<typeof CaseType>;

export const CaseStatus = z.enum(["OPEN", "RESOLVED"]);
export type CaseStatus = z.infer<typeof CaseStatus>;

export const CaseResolution = z.enum([
  "MARK_SUCCEEDED",
  "MARK_FAILED",
  "REFUND",
  "DISMISS",
]);
export type CaseResolution = z.infer<typeof CaseResolution>;

export const LedgerEntryType = z.enum(["CAPTURE", "REFUND", "REVERSAL"]);
export type LedgerEntryType = z.infer<typeof LedgerEntryType>;

export const PspId = z.enum(["psp_a", "psp_b"]);
export type PspId = z.infer<typeof PspId>;

/** Success-class reported statuses treated as a positive terminal claim. */
export const SUCCESS_CLASS_STATUSES: ReadonlySet<ReportedStatus> = new Set([
  "SUCCEEDED",
  "SETTLED",
  "CREDITED",
]);

/** All reported statuses that constitute a terminal claim (as opposed to PROCESSING/NOT_FOUND). */
export const TERMINAL_STATUSES: ReadonlySet<ReportedStatus> = new Set([
  "SUCCEEDED",
  "FAILED",
  "SETTLED",
  "CREDITED",
  "REFUNDED",
]);
