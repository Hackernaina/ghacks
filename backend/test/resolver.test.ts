import { describe, expect, it } from "vitest";
import { resolve } from "../src/resolver/index.js";
import { at, ev, input, payment } from "./helpers/builders.js";

const caseTypes = (r: ReturnType<typeof resolve>) => r.cases.map((c) => c.caseType).sort();
const postings = (r: ReturnType<typeof resolve>) => r.ledgerPostings.map((p) => `${p.entryType}:${p.pspRef}:${p.amount}`);

describe("resolve() scenarios", () => {
  it("happy path: sync and webhook agree → SUCCEEDED HIGH, one CAPTURE", () => {
    const r = resolve(input({ evidence: [ev("SYNC_RESPONSE", "SUCCEEDED", 1), ev("WEBHOOK", "SUCCEEDED", 2)] }));
    expect(r.state).toBe("SUCCEEDED");
    expect(r.confidence).toBe("HIGH");
    expect(r.cases).toEqual([]);
    expect(postings(r)).toEqual(["CAPTURE:pa_1:150000"]);
    expect(r.needsPoll).toBe(false);
    expect(r.nextCheckAt).toEqual(at(1 + 300));
    expect(r.reason).toContain("sync response 10:00:01 and webhook 10:00:02 agree");
  });

  it("lost sync response, status query SUCCEEDED → SUCCEEDED", () => {
    const r = resolve(
      input({ payment: payment({ state: "UNKNOWN", pspRef: null }), evidence: [ev("STATUS_QUERY", "SUCCEEDED", 5)] }),
    );
    expect(r.state).toBe("SUCCEEDED");
    expect(r.confidence).toBe("MEDIUM");
    expect(postings(r)).toEqual(["CAPTURE:pa_1:150000"]);
    expect(r.reason).toContain("no sync response recorded");
  });

  it("webhook delivered 50x → one CAPTURE, reason mentions duplicates", () => {
    const r = resolve(
      input({ evidence: [ev("SYNC_RESPONSE", "SUCCEEDED", 1), ev("WEBHOOK", "SUCCEEDED", 2, { duplicateCount: 49 })] }),
    );
    expect(postings(r)).toEqual(["CAPTURE:pa_1:150000"]);
    expect(r.reason).toContain("webhook delivered 50x, counted once");
  });

  it("late FAILED webhook after SUCCEEDED status query → SUCCEEDED + CONFLICT", () => {
    const r = resolve(
      input({
        payment: payment({ state: "UNKNOWN" }),
        evidence: [ev("STATUS_QUERY", "SUCCEEDED", 5), ev("WEBHOOK", "FAILED", 20)],
      }),
    );
    expect(r.state).toBe("SUCCEEDED");
    expect(r.confidence).toBe("MEDIUM");
    expect(caseTypes(r)).toEqual(["CONFLICT"]);
    expect(postings(r)).toEqual(["CAPTURE:pa_1:150000"]);
    expect(r.reason).toContain("webhook 10:00:20 said FAILED (outweighed)");
  });

  it("out-of-order webhooks give the same result as in-order", () => {
    const failed = ev("WEBHOOK", "FAILED", 10);
    const succeeded = ev("WEBHOOK", "SUCCEEDED", 20);
    const sync = ev("SYNC_RESPONSE", "SUCCEEDED", 1);
    const inOrder = resolve(input({ evidence: [sync, failed, succeeded] }));
    const reversed = resolve(input({ evidence: [succeeded, failed, sync] }));
    expect(reversed).toEqual(inOrder);
    expect(inOrder.state).toBe("SUCCEEDED");
  });

  it("NOT_FOUND inside the grace period → still UNKNOWN and polling", () => {
    const first = resolve(
      input({ payment: payment({ state: "UNKNOWN", pspRef: null }), evidence: [ev("STATUS_QUERY", "NOT_FOUND", 40, { pspRef: null, amount: null })], now: at(40) }),
    );
    expect(first.state).toBe("UNKNOWN");
    expect(first.markNotFoundSince).toEqual(at(40));
    expect(first.needsPoll).toBe(true);

    const within = resolve(
      input({
        payment: payment({ state: "UNKNOWN", pspRef: null, notFoundSince: at(40) }),
        evidence: [ev("STATUS_QUERY", "NOT_FOUND", 40, { pspRef: null, amount: null })],
        now: at(60),
      }),
    );
    expect(within.state).toBe("UNKNOWN");
    expect(within.needsPoll).toBe(true);
    expect(within.action).toBeUndefined();
    expect(within.cases).toEqual([]);
  });

  it("NOT_FOUND past the grace period → RESEND_SAME_KEY, never FAILED", () => {
    const r = resolve(
      input({
        payment: payment({ state: "UNKNOWN", pspRef: null, notFoundSince: at(40) }),
        evidence: [ev("STATUS_QUERY", "NOT_FOUND", 40, { pspRef: null, amount: null })],
        now: at(71),
      }),
    );
    expect(r.state).toBe("UNKNOWN");
    expect(r.action).toBe("RESEND_SAME_KEY");
    expect(r.markNotFoundSince).toEqual(at(71));
  });

  it("polling backs off exponentially up to POLL_MAX_MS", () => {
    const r = resolve(input({ payment: payment({ state: "UNKNOWN", pollCount: 3 }), now: at(10) }));
    expect(r.nextCheckAt).toEqual(at(10 + 16));
    const capped = resolve(input({ payment: payment({ state: "UNKNOWN", pollCount: 20 }), now: at(10) }));
    expect(capped.nextCheckAt).toEqual(at(10 + 60));
  });

  it("deadline passed with no terminal evidence → UNRESOLVED case, polling stops", () => {
    const r = resolve(
      input({ payment: payment({ state: "UNKNOWN" }), evidence: [ev("STATUS_QUERY", "PROCESSING", 30)], now: at(601) }),
    );
    expect(r.state).toBe("UNKNOWN");
    expect(caseTypes(r)).toEqual(["UNRESOLVED"]);
    expect(r.needsPoll).toBe(false);
    expect(r.nextCheckAt).toBeNull();
  });

  it("settlement present while payment FAILED → SETTLED_BUT_FAILED", () => {
    const r = resolve(
      input({
        payment: payment({ state: "FAILED" }),
        evidence: [ev("SYNC_RESPONSE", "FAILED", 1), ev("SETTLEMENT", "SETTLED", 100)],
        now: at(120),
      }),
    );
    expect(r.state).toBe("SETTLED");
    expect(caseTypes(r)).toEqual(["SETTLED_BUT_FAILED"]);
    expect(postings(r)).toEqual(["CAPTURE:pa_1:150000"]);
  });

  it("amount mismatch in settlement → AMOUNT_MISMATCH, LOW, no CAPTURE", () => {
    const r = resolve(
      input({ evidence: [ev("SYNC_RESPONSE", "SUCCEEDED", 1), ev("SETTLEMENT", "SETTLED", 100, { amount: 150100 })], now: at(120) }),
    );
    expect(caseTypes(r)).toEqual(["AMOUNT_MISMATCH"]);
    expect(r.confidence).toBe("LOW");
    expect(r.ledgerPostings).toEqual([]);
  });

  it("two distinct successful pspRefs (idempotency bypassed) → two CAPTUREs + DOUBLE_CHARGE", () => {
    const r = resolve(
      input({
        evidence: [
          ev("SYNC_RESPONSE", "SUCCEEDED", 1),
          ev("WEBHOOK", "SUCCEEDED", 2),
          ev("SYNC_RESPONSE", "SUCCEEDED", 40, { pspRef: "pa_2" }),
        ],
      }),
    );
    expect(postings(r)).toEqual(["CAPTURE:pa_1:150000", "CAPTURE:pa_2:150000"]);
    expect(caseTypes(r)).toEqual(["DOUBLE_CHARGE"]);
    expect(r.cases[0]?.targetPspRef).toBe("pa_2");
  });

  it("failover: attempt on PSP A succeeds after sibling on PSP B succeeded → DOUBLE_CHARGE on the later payment", () => {
    const r = resolve(
      input({
        payment: payment({ state: "UNKNOWN", pspRef: null }),
        evidence: [ev("STATUS_QUERY", "SUCCEEDED", 50)],
        siblingsForOrder: [{ id: "pay-2", attempt: 2, state: "SUCCEEDED", pspRef: "pb_1" }],
      }),
    );
    expect(r.state).toBe("SUCCEEDED");
    expect(caseTypes(r)).toEqual(["DOUBLE_CHARGE"]);
    expect(r.cases[0]).toMatchObject({ paymentId: "pay-2", dedupeKey: "DOUBLE_CHARGE:pay-2", targetPspRef: "pb_1" });
  });

  it("manual MARK_FAILED on a captured payment → REVERSAL posting, no new CONFLICT", () => {
    const r = resolve(
      input({
        payment: payment({ state: "SUCCEEDED" }),
        evidence: [ev("SYNC_RESPONSE", "SUCCEEDED", 1), ev("WEBHOOK", "SUCCEEDED", 2), ev("MANUAL", "FAILED", 100)],
        postedLedger: [{ pspRef: "pa_1", entryType: "CAPTURE" }],
        now: at(120),
      }),
    );
    expect(r.state).toBe("FAILED");
    expect(r.confidence).toBe("HIGH");
    expect(postings(r)).toEqual(["REVERSAL:pa_1:-150000"]);
    expect(r.cases).toEqual([]);
  });

  it("succeeded but no settlement after the window → SETTLEMENT_MISSING", () => {
    const r = resolve(input({ evidence: [ev("SYNC_RESPONSE", "SUCCEEDED", 0)], now: at(301) }));
    expect(caseTypes(r)).toEqual(["SETTLEMENT_MISSING"]);
    expect(r.nextCheckAt).toBeNull();
  });

  it("settled but no bank credit after the window → BANK_NOT_CREDITED", () => {
    const evidence = [ev("SYNC_RESPONSE", "SUCCEEDED", 0), ev("SETTLEMENT", "SETTLED", 10)];
    const inside = resolve(input({ evidence, now: at(100) }));
    expect(inside.state).toBe("SETTLED");
    expect(inside.cases).toEqual([]);
    expect(inside.nextCheckAt).toEqual(at(310));

    const after = resolve(input({ evidence, now: at(311) }));
    expect(caseTypes(after)).toEqual(["BANK_NOT_CREDITED"]);
  });

  it("bank credit closes the settlement chain with HIGH confidence", () => {
    const r = resolve(
      input({
        evidence: [ev("SYNC_RESPONSE", "SUCCEEDED", 0), ev("SETTLEMENT", "SETTLED", 10), ev("BANK_STATEMENT", "CREDITED", 20)],
        now: at(1000),
      }),
    );
    expect(r.state).toBe("SETTLED");
    expect(r.confidence).toBe("HIGH");
    expect(r.cases).toEqual([]);
    expect(r.nextCheckAt).toBeNull();
  });

  it("full refund → REFUNDED with a CAPTURE and a REFUND", () => {
    const r = resolve(
      input({ evidence: [ev("SYNC_RESPONSE", "SUCCEEDED", 1), ev("WEBHOOK", "SUCCEEDED", 2), ev("WEBHOOK", "REFUNDED", 30)] }),
    );
    expect(r.state).toBe("REFUNDED");
    expect(postings(r)).toEqual(["CAPTURE:pa_1:150000", "REFUND:pa_1:-150000"]);
  });

  it("refunding the duplicate charge clears the DOUBLE_CHARGE", () => {
    const r = resolve(
      input({
        evidence: [
          ev("SYNC_RESPONSE", "SUCCEEDED", 1),
          ev("SYNC_RESPONSE", "SUCCEEDED", 40, { pspRef: "pa_2" }),
          ev("WEBHOOK", "REFUNDED", 50, { pspRef: "pa_2" }),
        ],
      }),
    );
    expect(r.state).toBe("SUCCEEDED");
    expect(r.cases).toEqual([]);
    expect(postings(r)).toEqual(["CAPTURE:pa_1:150000", "CAPTURE:pa_2:150000", "REFUND:pa_2:-150000"]);
  });

  it("same customer and amount on another order within the window → SUSPECTED_DUPLICATE", () => {
    const r = resolve(
      input({
        evidence: [ev("SYNC_RESPONSE", "SUCCEEDED", 1)],
        suspects: [{ id: "pay-9", orderId: "order-9", successAt: at(60) }],
      }),
    );
    expect(caseTypes(r)).toEqual(["SUSPECTED_DUPLICATE"]);
    expect(postings(r)).toEqual(["CAPTURE:pa_1:150000"]);
  });

  it("PROCESSING from the PSP keeps the payment UNKNOWN and polling", () => {
    const r = resolve(input({ evidence: [ev("SYNC_RESPONSE", "PROCESSING", 1)] }));
    expect(r.state).toBe("UNKNOWN");
    expect(r.confidence).toBe("LOW");
    expect(r.needsPoll).toBe(true);
    expect(r.ledgerPostings).toEqual([]);
  });

  it("422 rejection alone → FAILED, no postings", () => {
    const r = resolve(input({ evidence: [ev("SYNC_RESPONSE", "FAILED", 1, { pspRef: null, amount: null })] }));
    expect(r.state).toBe("FAILED");
    expect(r.ledgerPostings).toEqual([]);
    expect(r.nextCheckAt).toBeNull();
  });
});
