import { EVIDENCE_SOURCE_TRUST, SUCCESS_CLASS_STATUSES, type ReportedStatus } from "@reconcile/shared";
import type { ResolverEvidence } from "./types.js";

export type ClaimClass = "success" | "failed";

export function trustOf(e: ResolverEvidence): number {
  return EVIDENCE_SOURCE_TRUST[e.source];
}

export function classOf(status: ReportedStatus): ClaimClass | null {
  if (SUCCESS_CLASS_STATUSES.has(status)) return "success";
  if (status === "FAILED") return "failed";
  return null;
}

function evidenceKey(e: ResolverEvidence): string {
  return `${e.source}|${e.sourceEventId}`;
}

function compareChronological(a: ResolverEvidence, b: ResolverEvidence): number {
  return (
    a.observedAt.getTime() - b.observedAt.getTime() ||
    a.sourceEventId.localeCompare(b.sourceEventId) ||
    a.source.localeCompare(b.source)
  );
}

/** Drops repeated rows for the same (source, sourceEventId) and sorts by time, so input order never matters. */
export function normalizeEvidence(evidence: ResolverEvidence[]): ResolverEvidence[] {
  const byKey = new Map<string, ResolverEvidence>();
  for (const e of evidence) {
    if (!byKey.has(evidenceKey(e))) byKey.set(evidenceKey(e), e);
  }
  return [...byKey.values()].sort(compareChronological);
}

/** Positive when `a` beats `b`: higher trust, then later observedAt, then sourceEventId. */
export function compareStrength(a: ResolverEvidence, b: ResolverEvidence): number {
  return (
    trustOf(a) - trustOf(b) ||
    a.observedAt.getTime() - b.observedAt.getTime() ||
    a.sourceEventId.localeCompare(b.sourceEventId) ||
    a.source.localeCompare(b.source)
  );
}

function strongest(claims: ResolverEvidence[]): ResolverEvidence | null {
  let best: ResolverEvidence | null = null;
  for (const c of claims) {
    if (!best || compareStrength(c, best) > 0) best = c;
  }
  return best;
}

export interface ClaimAnalysis {
  /** Success/failed claims (terminal claims other than REFUNDED). */
  classClaims: ResolverEvidence[];
  refundClaims: ResolverEvidence[];
  winner: ResolverEvidence | null;
  winnerClass: ClaimClass | null;
}

export function analyzeClaims(evidence: ResolverEvidence[]): ClaimAnalysis {
  const classClaims = evidence.filter((e) => classOf(e.reportedStatus) !== null);
  const refundClaims = evidence.filter((e) => e.reportedStatus === "REFUNDED");

  const classWinner = strongest(classClaims);
  if (classWinner) {
    return { classClaims, refundClaims, winner: classWinner, winnerClass: classOf(classWinner.reportedStatus) };
  }
  // A refund with no other terminal claim still implies the charge happened.
  const refundWinner = strongest(refundClaims);
  return { classClaims, refundClaims, winner: refundWinner, winnerClass: refundWinner ? "success" : null };
}
