import { type ClaimAnalysis, classOf, trustOf } from "./claims.js";
import { snapshotOf } from "./facts.js";
import { clock, sourceLabel } from "./labels.js";
import type { CaseDraft, ResolverEvidence, ResolverPayment } from "./types.js";

export function conflictingClaims(analysis: ClaimAnalysis): ResolverEvidence[] {
  const { winner, winnerClass } = analysis;
  // An operator's decision is the adjudication of the conflict, so it does not raise a new one.
  if (!winner || winner.source === "MANUAL") return [];
  return analysis.classClaims.filter((c) => trustOf(c) >= 60 && classOf(c.reportedStatus) !== winnerClass);
}

export function conflictCase(
  payment: ResolverPayment,
  analysis: ClaimAnalysis,
  evidence: ResolverEvidence[],
): CaseDraft | null {
  const disagreeing = conflictingClaims(analysis);
  const winner = analysis.winner;
  if (!winner || disagreeing.length === 0) return null;
  const others = disagreeing.map((d) => `${sourceLabel(d.source)} ${clock(d.observedAt)} (${d.reportedStatus})`);
  return {
    caseType: "CONFLICT",
    paymentId: payment.id,
    orderId: payment.orderId,
    dedupeKey: `CONFLICT:${payment.id}`,
    summary: `${sourceLabel(winner.source)} reports ${winner.reportedStatus} but ${others.join(", ")} disagree`,
    suggestedAction: "Review the evidence and mark the payment succeeded or failed",
    targetPspRef: null,
    evidenceSnapshot: snapshotOf(evidence),
  };
}

/** Refund amounts can legitimately be partial, so they are not compared against the charge. */
export function mismatchedAmounts(payment: ResolverPayment, evidence: ResolverEvidence[]): ResolverEvidence[] {
  return evidence.filter((e) => e.amount !== null && e.reportedStatus !== "REFUNDED" && e.amount !== payment.amount);
}

export function amountMismatchCase(payment: ResolverPayment, evidence: ResolverEvidence[]): CaseDraft | null {
  const mismatched = mismatchedAmounts(payment, evidence);
  if (mismatched.length === 0) return null;
  const details = mismatched.map((e) => `${sourceLabel(e.source)} reported ${e.amount}`);
  return {
    caseType: "AMOUNT_MISMATCH",
    paymentId: payment.id,
    orderId: payment.orderId,
    dedupeKey: `AMOUNT_MISMATCH:${payment.id}`,
    summary: `${details.join(", ")}; payment amount is ${payment.amount}`,
    suggestedAction: "Investigate the amount difference with the PSP before fulfilling the order",
    targetPspRef: null,
    evidenceSnapshot: snapshotOf(evidence),
  };
}
