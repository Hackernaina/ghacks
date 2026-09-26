import { analyzeClaims, normalizeEvidence } from "./claims.js";
import { amountMismatchCase, conflictCase } from "./checks.js";
import { deriveConfidence } from "./confidence.js";
import { duplicateCases } from "./duplicates.js";
import { collectFacts } from "./facts.js";
import { ledgerPostings } from "./ledger.js";
import { pollingSchedule } from "./polling.js";
import { buildReason } from "./reason.js";
import { settlementChecks } from "./settlement.js";
import { deriveState } from "./state.js";
import type { CaseDraft, Resolution, ResolveInput } from "./types.js";

export type * from "./types.js";

function uniqueCases(cases: CaseDraft[]): CaseDraft[] {
  const seen = new Set<string>();
  return cases.filter((c) => (seen.has(c.dedupeKey) ? false : (seen.add(c.dedupeKey), true)));
}

/** Pure: derives a payment's state from its evidence. No I/O, no clock reads. */
export function resolve(input: ResolveInput): Resolution {
  const { payment, now, config } = input;
  const evidence = normalizeEvidence(input.evidence);
  const analysis = analyzeClaims(evidence);
  const facts = collectFacts(payment, evidence);

  const state = deriveState(payment, analysis, facts);
  const conflict = conflictCase(payment, analysis, evidence);
  const amount = amountMismatchCase(payment, evidence);
  const confidence = deriveConfidence(analysis, { conflict: conflict !== null, amountMismatch: amount !== null });

  const terminal = analysis.winner !== null;
  const settlement = terminal
    ? settlementChecks(payment, state, analysis, facts, evidence, now, config)
    : { cases: [], windowCheckAt: null };
  const polling = terminal ? null : pollingSchedule(payment, facts, evidence, now, config);
  const duplicates = duplicateCases(payment, state, facts, evidence, input.siblingsForOrder, input.suspects, config);

  const cases = uniqueCases([
    ...(conflict ? [conflict] : []),
    ...(amount ? [amount] : []),
    ...settlement.cases,
    ...(polling?.cases ?? []),
    ...duplicates,
  ]);

  const resolution: Resolution = {
    state,
    confidence,
    reason: buildReason({ payment, state, confidence, analysis, facts, evidence, polling }),
    ledgerPostings: ledgerPostings(payment, state, confidence, facts, input.postedLedger),
    cases,
    nextCheckAt: polling ? polling.nextCheckAt : settlement.windowCheckAt,
    needsPoll: polling?.needsPoll ?? false,
    markNotFoundSince: polling ? polling.markNotFoundSince : null,
  };
  if (polling?.action) resolution.action = polling.action;
  return resolution;
}
