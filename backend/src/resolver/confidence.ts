import type { Confidence } from "@reconcile/shared";
import { type ClaimAnalysis, classOf, trustOf } from "./claims.js";

const RANK: Record<Confidence, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

function atMost(value: Confidence, cap: Confidence): Confidence {
  return RANK[value] <= RANK[cap] ? value : cap;
}

function agreeingSources(analysis: ClaimAnalysis): number {
  const { winner, winnerClass } = analysis;
  if (!winner) return 0;
  const sources = new Set<string>([winner.source]);
  for (const c of analysis.classClaims) {
    if (classOf(c.reportedStatus) === winnerClass) sources.add(c.source);
  }
  return sources.size;
}

export function deriveConfidence(
  analysis: ClaimAnalysis,
  flags: { conflict: boolean; amountMismatch: boolean },
): Confidence {
  const { winner } = analysis;
  let confidence: Confidence;
  if (!winner) confidence = "LOW";
  else if (trustOf(winner) >= 90 || agreeingSources(analysis) >= 2) confidence = "HIGH";
  else if (trustOf(winner) >= 50) confidence = "MEDIUM";
  else confidence = "LOW";

  if (flags.conflict) confidence = atMost(confidence, "MEDIUM");
  if (flags.amountMismatch) confidence = "LOW";
  return confidence;
}
