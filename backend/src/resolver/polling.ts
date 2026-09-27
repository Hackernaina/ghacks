import type { EvidenceFacts } from "./facts.js";
import { snapshotOf } from "./facts.js";
import type { CaseDraft, ResolverAction, ResolverConfig, ResolverEvidence, ResolverPayment } from "./types.js";

export interface PollingOutcome {
  cases: CaseDraft[];
  needsPoll: boolean;
  nextCheckAt: Date | null;
  markNotFoundSince: Date | null | undefined;
  action?: ResolverAction;
  pastDeadline: boolean;
  notFoundSince: Date | null;
}

function backoff(payment: ResolverPayment, now: Date, config: ResolverConfig): Date {
  const delay = Math.min(config.POLL_BASE_MS * 2 ** payment.pollCount, config.POLL_MAX_MS);
  return new Date(now.getTime() + delay);
}

/** Scheduling for a payment with no terminal claims yet. */
export function pollingSchedule(
  payment: ResolverPayment,
  facts: EvidenceFacts,
  evidence: ResolverEvidence[],
  now: Date,
  config: ResolverConfig,
): PollingOutcome {
  if (now.getTime() > payment.deadlineAt.getTime()) {
    return {
      cases: [
        {
          caseType: "UNRESOLVED",
          paymentId: payment.id,
          orderId: payment.orderId,
          dedupeKey: `UNRESOLVED:${payment.id}`,
          summary: `No terminal evidence before the deadline (${payment.deadlineAt.toISOString()})`,
          suggestedAction: "Confirm the outcome with the PSP and mark the payment succeeded or failed",
          targetPspRef: null,
          evidenceSnapshot: snapshotOf(evidence),
        },
      ],
      needsPoll: false,
      nextCheckAt: null,
      markNotFoundSince: null,
      pastDeadline: true,
      notFoundSince: null,
    };
  }

  const next = backoff(payment, now, config);
  if (facts.latestStatusQuery?.reportedStatus !== "NOT_FOUND") {
    return { cases: [], needsPoll: true, nextCheckAt: next, markNotFoundSince: null, pastDeadline: false, notFoundSince: null };
  }

  if (!payment.notFoundSince) {
    return { cases: [], needsPoll: true, nextCheckAt: next, markNotFoundSince: now, pastDeadline: false, notFoundSince: now };
  }

  if (now.getTime() - payment.notFoundSince.getTime() > config.NOT_FOUND_GRACE_MS) {
    // Restarting the clock limits resends to one per grace period.
    return {
      cases: [],
      needsPoll: false,
      nextCheckAt: next,
      markNotFoundSince: now,
      action: "RESEND_SAME_KEY",
      pastDeadline: false,
      notFoundSince: payment.notFoundSince,
    };
  }

  return {
    cases: [],
    needsPoll: true,
    nextCheckAt: next,
    markNotFoundSince: undefined,
    pastDeadline: false,
    notFoundSince: payment.notFoundSince,
  };
}
