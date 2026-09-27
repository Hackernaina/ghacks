import type { PaymentState } from "@reconcile/shared";
import type { ClaimAnalysis } from "./claims.js";
import type { EvidenceFacts } from "./facts.js";
import type { ResolverPayment } from "./types.js";

export const SUCCESS_STATES: ReadonlySet<PaymentState> = new Set(["SUCCEEDED", "SETTLED", "REFUNDED"]);
/** Success states where the money is still with the merchant. */
export const CHARGED_STATES: ReadonlySet<PaymentState> = new Set(["SUCCEEDED", "SETTLED"]);

function isRefunded(analysis: ClaimAnalysis, facts: EvidenceFacts, payment: ResolverPayment): boolean {
  if (facts.successPspRefs.length > 0) {
    return facts.successPspRefs.every((ref) => facts.fullyRefunded.has(ref));
  }
  return analysis.refundClaims.some((e) => e.amount !== null && e.amount >= payment.amount);
}

export function deriveState(payment: ResolverPayment, analysis: ClaimAnalysis, facts: EvidenceFacts): PaymentState {
  if (analysis.winnerClass === "failed") return "FAILED";
  if (analysis.winnerClass === "success") {
    if (isRefunded(analysis, facts, payment)) return "REFUNDED";
    return facts.settlementPresent ? "SETTLED" : "SUCCEEDED";
  }
  if (payment.state === "UNKNOWN" || facts.hasUncertain) return "UNKNOWN";
  return payment.state;
}
