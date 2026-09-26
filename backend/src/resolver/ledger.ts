import type { Confidence, PaymentState } from "@reconcile/shared";
import type { EvidenceFacts } from "./facts.js";
import { SUCCESS_STATES } from "./state.js";
import type { LedgerPosting, PostedLedgerEntry, ResolverPayment } from "./types.js";

/** The desired set of postings; persistence is idempotent on (psp_ref, entry_type). */
export function ledgerPostings(
  payment: ResolverPayment,
  state: PaymentState,
  confidence: Confidence,
  facts: EvidenceFacts,
  posted: PostedLedgerEntry[],
): LedgerPosting[] {
  const base = { paymentId: payment.id, orderId: payment.orderId };
  const postings: LedgerPosting[] = [];

  const captured = new Set(posted.filter((p) => p.entryType === "CAPTURE").map((p) => p.pspRef));
  if (SUCCESS_STATES.has(state) && confidence !== "LOW") {
    for (const pspRef of facts.successPspRefs) {
      postings.push({ ...base, pspRef, entryType: "CAPTURE", amount: payment.amount });
      captured.add(pspRef);
    }
  }

  for (const [pspRef, amount] of [...facts.refundAmountByPspRef].sort(([a], [b]) => a.localeCompare(b))) {
    if (captured.has(pspRef)) postings.push({ ...base, pspRef, entryType: "REFUND", amount: -amount });
  }

  if (state === "FAILED") {
    const reversible = posted.filter((p) => p.entryType === "CAPTURE").map((p) => p.pspRef).sort();
    for (const pspRef of reversible) {
      postings.push({ ...base, pspRef, entryType: "REVERSAL", amount: -payment.amount });
    }
  }

  return postings;
}
