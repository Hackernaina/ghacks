import type { ResolverEvidence, ResolverPayment } from "./types.js";
import { classOf } from "./claims.js";

/** Order-independent facts derived once from normalized (deduped, sorted) evidence. */
export interface EvidenceFacts {
  /** Distinct pspRefs with success-class evidence, sorted. */
  successPspRefs: string[];
  /** Earliest success-class observation per pspRef. */
  firstSuccessByPspRef: Map<string, Date>;
  /** pspRefs with a REFUNDED claim covering the full payment amount. */
  fullyRefunded: Set<string>;
  /** Largest refunded amount per pspRef (null amount → payment amount). */
  refundAmountByPspRef: Map<string, number>;
  successAt: Date | null;
  settlementPresent: boolean;
  settledAt: Date | null;
  bankCredited: boolean;
  latestStatusQuery: ResolverEvidence | null;
  hasSyncResponse: boolean;
  hasUncertain: boolean;
}

export function collectFacts(payment: ResolverPayment, evidence: ResolverEvidence[]): EvidenceFacts {
  const firstSuccessByPspRef = new Map<string, Date>();
  const fullyRefunded = new Set<string>();
  const refundAmountByPspRef = new Map<string, number>();
  let successAt: Date | null = null;
  let settledAt: Date | null = null;
  let settlementPresent = false;
  let bankCredited = false;
  let latestStatusQuery: ResolverEvidence | null = null;

  for (const e of evidence) {
    if (classOf(e.reportedStatus) === "success") {
      successAt ??= e.observedAt;
      if (e.pspRef && !firstSuccessByPspRef.has(e.pspRef)) firstSuccessByPspRef.set(e.pspRef, e.observedAt);
    }
    if (e.reportedStatus === "REFUNDED" && e.pspRef) {
      const amount = e.amount ?? payment.amount;
      refundAmountByPspRef.set(e.pspRef, Math.max(refundAmountByPspRef.get(e.pspRef) ?? 0, amount));
      if (e.amount !== null && e.amount >= payment.amount) fullyRefunded.add(e.pspRef);
    }
    if (e.source === "SETTLEMENT") {
      settlementPresent = true;
      settledAt ??= e.observedAt;
    }
    if (e.source === "BANK_STATEMENT") {
      settlementPresent = true;
      bankCredited = true;
    }
    if (e.source === "STATUS_QUERY") latestStatusQuery = e;
  }

  return {
    successPspRefs: [...firstSuccessByPspRef.keys()].sort(),
    firstSuccessByPspRef,
    fullyRefunded,
    refundAmountByPspRef,
    successAt,
    settlementPresent,
    settledAt,
    bankCredited,
    latestStatusQuery,
    hasSyncResponse: evidence.some((e) => e.source === "SYNC_RESPONSE"),
    hasUncertain: evidence.some((e) => e.reportedStatus === "PROCESSING" || e.reportedStatus === "NOT_FOUND"),
  };
}

export function snapshotOf(evidence: ResolverEvidence[]) {
  return evidence.map((e) => ({
    source: e.source,
    sourceEventId: e.sourceEventId,
    reportedStatus: e.reportedStatus,
    pspRef: e.pspRef,
    amount: e.amount,
    observedAt: e.observedAt.toISOString(),
  }));
}
