import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EvidenceSource, ReportedStatus, SUCCESS_CLASS_STATUSES } from "@reconcile/shared";
import { resolve } from "../src/resolver/index.js";
import type { ResolverEvidence } from "../src/resolver/index.js";
import { at, input, payment } from "./helpers/builders.js";

const evidenceArb: fc.Arbitrary<ResolverEvidence> = fc
  .record({
    n: fc.integer({ min: 0, max: 10_000 }),
    source: fc.constantFrom(...EvidenceSource.options),
    reportedStatus: fc.constantFrom(...ReportedStatus.options),
    pspRef: fc.option(fc.constantFrom("pa_1", "pa_2", "pb_1"), { nil: null }),
    amount: fc.option(fc.constantFrom(150000, 150100), { nil: null }),
    t: fc.integer({ min: 0, max: 900 }),
    duplicateCount: fc.integer({ min: 0, max: 5 }),
  })
  .map((r) => ({
    id: `ev-${r.n}`,
    source: r.source,
    sourceEventId: `${r.source}-${r.n}`,
    reportedStatus: r.reportedStatus,
    pspRef: r.pspRef,
    amount: r.amount,
    currency: "INR",
    observedAt: at(r.t),
    duplicateCount: r.duplicateCount,
  }));

// Unique (source, sourceEventId), as the DB guarantees.
const evidenceSetArb = fc.uniqueArray(evidenceArb, {
  maxLength: 12,
  selector: (e) => `${e.source}|${e.sourceEventId}`,
});

const scenarioArb = fc.record({
  evidence: evidenceSetArb,
  state: fc.constantFrom("CREATED", "PENDING", "UNKNOWN", "SUCCEEDED", "FAILED"),
  now: fc.integer({ min: 0, max: 1200 }),
  captured: fc.boolean(),
});

function run(evidence: ResolverEvidence[], s: { state: string; now: number; captured: boolean }) {
  return resolve(
    input({
      payment: payment({ state: s.state as never }),
      evidence,
      now: at(s.now),
      postedLedger: s.captured ? [{ pspRef: "pa_1", entryType: "CAPTURE" }] : [],
    }),
  );
}

describe("resolve() properties", () => {
  it("is independent of evidence order", () => {
    fc.assert(
      fc.property(
        scenarioArb.chain((s) =>
          fc.tuple(fc.constant(s), fc.shuffledSubarray(s.evidence, { minLength: s.evidence.length, maxLength: s.evidence.length })),
        ),
        ([s, shuffled]) => {
          expect(run(shuffled, s)).toEqual(run(s.evidence, s));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("is unchanged when evidence rows are delivered more than once", () => {
    fc.assert(
      fc.property(scenarioArb, fc.array(fc.nat()), (s, picks) => {
        if (s.evidence.length === 0) return;
        const extra = picks.map((i) => s.evidence[i % s.evidence.length]!);
        expect(run([...s.evidence, ...extra], s)).toEqual(run(s.evidence, s));
      }),
      { numRuns: 300 },
    );
  });

  it("posts exactly one CAPTURE per distinct successful pspRef once charged with confidence ≥ MEDIUM", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const r = run(s.evidence, s);
        const captures = r.ledgerPostings.filter((p) => p.entryType === "CAPTURE");
        expect(new Set(captures.map((c) => c.pspRef)).size).toBe(captures.length);
        if (["SUCCEEDED", "SETTLED", "REFUNDED"].includes(r.state) && r.confidence !== "LOW") {
          const successRefs = new Set(
            s.evidence.filter((e) => SUCCESS_CLASS_STATUSES.has(e.reportedStatus) && e.pspRef).map((e) => e.pspRef),
          );
          expect(captures.length).toBe(successRefs.size);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("never reports FAILED without a FAILED claim", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const r = run(s.evidence, s);
        if (r.state === "FAILED") {
          expect(s.evidence.some((e) => e.reportedStatus === "FAILED") || s.state === "FAILED").toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("never leaves a FAILED payment with a net positive ledger", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const r = run(s.evidence, s);
        if (r.state !== "FAILED") return;
        const net = r.ledgerPostings.reduce((sum, p) => sum + p.amount, 0) + (s.captured ? 150000 : 0);
        expect(net).toBeLessThanOrEqual(0);
      }),
      { numRuns: 300 },
    );
  });
});
