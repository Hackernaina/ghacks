import type { PaymentState } from "@reconcile/shared";
import type { ClaimAnalysis } from "./claims.js";
import { type EvidenceFacts, snapshotOf } from "./facts.js";
import type { CaseDraft, ResolverConfig, ResolverEvidence, ResolverPayment } from "./types.js";

export interface SettlementOutcome {
  cases: CaseDraft[];
  /** End of a settlement/bank window we are still inside, for a follow-up check. */
  windowCheckAt: Date | null;
}

export function settlementChecks(
  payment: ResolverPayment,
  state: PaymentState,
  analysis: ClaimAnalysis,
  facts: EvidenceFacts,
  evidence: ResolverEvidence[],
  now: Date,
  config: ResolverConfig,
): SettlementOutcome {
  const cases: CaseDraft[] = [];
  const base = { paymentId: payment.id, orderId: payment.orderId, targetPspRef: null, evidenceSnapshot: snapshotOf(evidence) };
  let windowCheckAt: Date | null = null;

  const hadFailedClaim = analysis.classClaims.some((c) => c.reportedStatus === "FAILED");
  if (facts.settlementPresent && (hadFailedClaim || payment.state === "FAILED")) {
    cases.push({
      ...base,
      caseType: "SETTLED_BUT_FAILED",
      dedupeKey: `SETTLED_BUT_FAILED:${payment.id}`,
      summary: "Funds settled for a payment that was reported failed",
      suggestedAction: "Fulfil the order or refund the customer",
    });
  }

  if (state === "SUCCEEDED" && facts.successAt) {
    const windowEnd = facts.successAt.getTime() + config.SETTLEMENT_WINDOW_MS;
    if (now.getTime() > windowEnd) {
      cases.push({
        ...base,
        caseType: "SETTLEMENT_MISSING",
        dedupeKey: `SETTLEMENT_MISSING:${payment.id}`,
        summary: `Succeeded at ${facts.successAt.toISOString()} but no settlement line within the window`,
        suggestedAction: "Chase the PSP for the settlement report",
      });
    } else {
      windowCheckAt = new Date(windowEnd);
    }
  }

  if (state === "SETTLED" && facts.settledAt && !facts.bankCredited) {
    const windowEnd = facts.settledAt.getTime() + config.BANK_WINDOW_MS;
    if (now.getTime() > windowEnd) {
      cases.push({
        ...base,
        caseType: "BANK_NOT_CREDITED",
        dedupeKey: `BANK_NOT_CREDITED:${payment.id}`,
        summary: `Settled at ${facts.settledAt.toISOString()} but no bank credit within the window`,
        suggestedAction: "Chase the bank and PSP for the payout",
      });
    } else {
      windowCheckAt = new Date(windowEnd);
    }
  }

  return { cases, windowCheckAt };
}
