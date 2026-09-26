import type { Confidence, PaymentState } from "@reconcile/shared";
import { type ClaimAnalysis, classOf } from "./claims.js";
import { conflictingClaims, mismatchedAmounts } from "./checks.js";
import type { EvidenceFacts } from "./facts.js";
import { clock, sourceLabel } from "./labels.js";
import type { PollingOutcome } from "./polling.js";
import type { ResolverEvidence, ResolverPayment } from "./types.js";

interface ReasonInput {
  payment: ResolverPayment;
  state: PaymentState;
  confidence: Confidence;
  analysis: ClaimAnalysis;
  facts: EvidenceFacts;
  evidence: ResolverEvidence[];
  polling: PollingOutcome | null;
}

function describe(e: ResolverEvidence): string {
  return `${sourceLabel(e.source)} ${clock(e.observedAt)}`;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function verdict({ analysis }: ReasonInput): string {
  const { winner, winnerClass } = analysis;
  if (!winner) return "";
  const supporting = new Map<string, ResolverEvidence>();
  for (const c of [...analysis.classClaims, ...analysis.refundClaims]) {
    const cls = c.reportedStatus === "REFUNDED" ? "success" : classOf(c.reportedStatus);
    if (cls === winnerClass && !supporting.has(c.source)) supporting.set(c.source, c);
  }
  const list = [...supporting.values()].map(describe);
  return list.length >= 2 ? `${joinList(list)} agree` : `${describe(winner)} reported ${winner.reportedStatus}`;
}

function pendingNote({ polling }: ReasonInput): string {
  if (!polling) return "";
  if (polling.pastDeadline) return "no terminal evidence before the deadline; needs manual review";
  if (polling.action === "RESEND_SAME_KEY") return "PSP still has no record after the grace period; resending with the same idempotency key";
  if (polling.notFoundSince) return `PSP has no record yet (NOT_FOUND since ${clock(polling.notFoundSince)}); polling`;
  return `awaiting a terminal answer from the PSP${polling.nextCheckAt ? `; next check ${clock(polling.nextCheckAt)}` : ""}`;
}

export function buildReason(input: ReasonInput): string {
  const { state, confidence, analysis, facts, evidence, payment } = input;
  const parts: string[] = [];

  const main = verdict(input) || pendingNote(input);
  parts.push(`${state} (${confidence}): ${main}`);

  for (const d of conflictingClaims(analysis)) {
    parts.push(`${describe(d)} said ${d.reportedStatus} (outweighed)`);
  }
  for (const m of mismatchedAmounts(payment, evidence)) {
    parts.push(`${sourceLabel(m.source)} amount ${m.amount} differs from ${payment.amount}`);
  }
  if (analysis.winner && !facts.hasSyncResponse) {
    parts.push("no sync response recorded (lost or timed out)");
  }
  for (const e of evidence) {
    if (e.duplicateCount > 0) parts.push(`${sourceLabel(e.source)} delivered ${e.duplicateCount + 1}x, counted once`);
  }

  return `${parts.join("; ")}.`;
}
