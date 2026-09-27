import type { PaymentState } from "@reconcile/shared";
import { type EvidenceFacts, snapshotOf } from "./facts.js";
import { CHARGED_STATES } from "./state.js";
import type { CaseDraft, ResolverConfig, ResolverEvidence, ResolverPayment, SiblingPayment, SuspectPayment } from "./types.js";

/** The charge first seen last is the one to refund. */
function laterCharge(refs: string[], facts: EvidenceFacts): string {
  return [...refs].sort((a, b) => {
    const ta = facts.firstSuccessByPspRef.get(a)?.getTime() ?? 0;
    const tb = facts.firstSuccessByPspRef.get(b)?.getTime() ?? 0;
    return tb - ta || b.localeCompare(a);
  })[0]!;
}

export function duplicateCases(
  payment: ResolverPayment,
  state: PaymentState,
  facts: EvidenceFacts,
  evidence: ResolverEvidence[],
  siblings: SiblingPayment[],
  suspects: SuspectPayment[],
  config: ResolverConfig,
): CaseDraft[] {
  const cases: CaseDraft[] = [];
  const snapshot = snapshotOf(evidence);

  const liveCharges = facts.successPspRefs.filter((ref) => !facts.fullyRefunded.has(ref));
  if (liveCharges.length > 1) {
    const target = laterCharge(liveCharges, facts);
    cases.push({
      caseType: "DOUBLE_CHARGE",
      paymentId: payment.id,
      orderId: payment.orderId,
      dedupeKey: `DOUBLE_CHARGE:${payment.id}`,
      summary: `${liveCharges.length} successful charges for one payment: ${liveCharges.join(", ")}`,
      suggestedAction: `Refund the later charge ${target}`,
      targetPspRef: target,
      evidenceSnapshot: snapshot,
    });
  }

  if (!CHARGED_STATES.has(state)) return cases;

  const ownRef = payment.pspRef ?? (liveCharges.length ? laterCharge(liveCharges, facts) : null);
  const chargedSiblings = [...siblings]
    .filter((s) => CHARGED_STATES.has(s.state))
    .sort((a, b) => a.attempt - b.attempt || a.id.localeCompare(b.id));
  for (const sibling of chargedSiblings) {
    const later = sibling.attempt > payment.attempt ? sibling : { id: payment.id, attempt: payment.attempt, pspRef: ownRef };
    const earlier = later.id === payment.id ? sibling : { attempt: payment.attempt };
    cases.push({
      caseType: "DOUBLE_CHARGE",
      paymentId: later.id,
      orderId: payment.orderId,
      dedupeKey: `DOUBLE_CHARGE:${later.id}`,
      summary: `Order charged by attempt ${earlier.attempt} and attempt ${later.attempt}`,
      suggestedAction: `Refund attempt ${later.attempt}${later.pspRef ? ` (${later.pspRef})` : ""}`,
      targetPspRef: later.pspRef,
      evidenceSnapshot: snapshot,
    });
  }

  if (facts.successAt) {
    const successAt = facts.successAt.getTime();
    const close = suspects
      .filter((s) => Math.abs(s.successAt.getTime() - successAt) <= config.SUSPECT_WINDOW_MS)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (close.length > 0) {
      cases.push({
        caseType: "SUSPECTED_DUPLICATE",
        paymentId: payment.id,
        orderId: payment.orderId,
        dedupeKey: `SUSPECTED_DUPLICATE:${payment.id}`,
        summary: `Same customer and amount also succeeded on order ${close.map((s) => s.orderId).join(", ")} within ${Math.round(config.SUSPECT_WINDOW_MS / 1000)}s`,
        suggestedAction: "Check with the customer; no automatic action is taken",
        targetPspRef: null,
        evidenceSnapshot: snapshot,
      });
    }
  }

  return cases;
}
