import type {
  CaseType,
  Confidence,
  EvidenceSource,
  LedgerEntryType,
  PaymentState,
  PspId,
  ReportedStatus,
} from "@reconcile/shared";

export interface ResolverPayment {
  id: string;
  orderId: string;
  customerId: string;
  attempt: number;
  psp: PspId;
  pspRef: string | null;
  amount: number;
  currency: string;
  state: PaymentState;
  deadlineAt: Date;
  notFoundSince: Date | null;
  pollCount: number;
}

export interface ResolverEvidence {
  id: string;
  source: EvidenceSource;
  sourceEventId: string;
  pspRef: string | null;
  reportedStatus: ReportedStatus;
  amount: number | null;
  currency: string | null;
  observedAt: Date;
  duplicateCount: number;
}

/** Other payment attempts for the same order. */
export interface SiblingPayment {
  id: string;
  attempt: number;
  state: PaymentState;
  pspRef: string | null;
}

/** Success-class payments of the same customer + amount on a different order. */
export interface SuspectPayment {
  id: string;
  orderId: string;
  successAt: Date;
}

export interface PostedLedgerEntry {
  pspRef: string;
  entryType: LedgerEntryType;
}

export interface ResolverConfig {
  POLL_BASE_MS: number;
  POLL_MAX_MS: number;
  NOT_FOUND_GRACE_MS: number;
  SETTLEMENT_WINDOW_MS: number;
  BANK_WINDOW_MS: number;
  SUSPECT_WINDOW_MS: number;
}

export interface ResolveInput {
  payment: ResolverPayment;
  evidence: ResolverEvidence[];
  siblingsForOrder: SiblingPayment[];
  suspects: SuspectPayment[];
  postedLedger: PostedLedgerEntry[];
  now: Date;
  config: ResolverConfig;
}

export interface LedgerPosting {
  paymentId: string;
  orderId: string;
  pspRef: string;
  entryType: LedgerEntryType;
  amount: number;
}

export interface EvidenceSnapshotItem {
  source: EvidenceSource;
  sourceEventId: string;
  reportedStatus: ReportedStatus;
  pspRef: string | null;
  amount: number | null;
  observedAt: string;
}

export interface CaseDraft {
  caseType: CaseType;
  paymentId: string | null;
  orderId: string | null;
  dedupeKey: string;
  summary: string;
  suggestedAction: string;
  /** The charge a REFUND resolution should target, when the case implies one. */
  targetPspRef: string | null;
  evidenceSnapshot: EvidenceSnapshotItem[];
}

export type ResolverAction = "RESEND_SAME_KEY";

export interface Resolution {
  state: PaymentState;
  confidence: Confidence;
  reason: string;
  ledgerPostings: LedgerPosting[];
  cases: CaseDraft[];
  nextCheckAt: Date | null;
  needsPoll: boolean;
  /** undefined = leave unchanged; null = clear; Date = set. */
  markNotFoundSince?: Date | null;
  action?: ResolverAction;
}
