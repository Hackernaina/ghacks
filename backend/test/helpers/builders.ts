import type { EvidenceSource, ReportedStatus } from "@reconcile/shared";
import type { ResolveInput, ResolverEvidence, ResolverPayment } from "../../src/resolver/index.js";

export const T0 = new Date("2026-09-27T10:00:00.000Z");

export function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * 1000);
}

export const CONFIG = {
  POLL_BASE_MS: 2000,
  POLL_MAX_MS: 60000,
  NOT_FOUND_GRACE_MS: 30000,
  SETTLEMENT_WINDOW_MS: 300000,
  BANK_WINDOW_MS: 300000,
  SUSPECT_WINDOW_MS: 120000,
};

export function payment(overrides: Partial<ResolverPayment> = {}): ResolverPayment {
  return {
    id: "pay-1",
    orderId: "order-1",
    customerId: "cust-1",
    attempt: 1,
    psp: "psp_a",
    pspRef: "pa_1",
    amount: 150000,
    currency: "INR",
    state: "PENDING",
    deadlineAt: at(600),
    notFoundSince: null,
    pollCount: 0,
    ...overrides,
  };
}

let seq = 0;

export function ev(
  source: EvidenceSource,
  reportedStatus: ReportedStatus,
  observedAtSeconds: number,
  overrides: Partial<ResolverEvidence> = {},
): ResolverEvidence {
  seq += 1;
  return {
    id: `ev-${seq}`,
    source,
    sourceEventId: `${source.toLowerCase()}-${seq}`,
    pspRef: "pa_1",
    reportedStatus,
    amount: 150000,
    currency: "INR",
    observedAt: at(observedAtSeconds),
    duplicateCount: 0,
    ...overrides,
  };
}

export function input(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    payment: payment(),
    evidence: [],
    siblingsForOrder: [],
    suspects: [],
    postedLedger: [],
    now: at(60),
    config: CONFIG,
    ...overrides,
  };
}
