/**
 * Mock Bank Test Suite
 * Runs against a live Mock Bank instance.
 * Set BANK_URL env var (default: http://localhost:4003)
 */

import { describe, it, expect } from "vitest";

const BANK_URL = process.env.BANK_URL ?? "http://localhost:4003";

function uniqueRef(prefix = "ref") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

// ════════════════════════════════════════════════════════════════════════════
// HAPPY PATH
// ════════════════════════════════════════════════════════════════════════════

describe("Happy path — Mock Bank", () => {
  it("POST /debit returns 200 with bankRef", async () => {
    const pspRef = uniqueRef("pa");
    const res = await fetch(`${BANK_URL}/debit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: 1000,
        currency: "INR",
        psp_ref: pspRef,
        ref: pspRef,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("bankRef");
    expect(typeof body.bankRef).toBe("string");
    expect(body.bankRef.length).toBeGreaterThan(0);
  });

  it("GET /statements?since= returns CSV with headers", async () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    const res = await fetch(`${BANK_URL}/statements?since=${encodeURIComponent(since)}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
    const firstLine = text.split("\n")[0].toLowerCase();
    // Headers must match BANK_STATEMENT_CSV_HEADER (statement_id,line_no,psp_ref,amount,currency,type,credited_at)
    expect(firstLine).toContain("psp_ref");
    expect(firstLine).toContain("amount");
  });

  it("GET /statements?since= only returns entries after since timestamp", async () => {
    // Debit now, then query from 1 min in future — should be empty
    const pspRef = uniqueRef("pa");
    await fetch(`${BANK_URL}/debit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 50, currency: "INR", psp_ref: pspRef, ref: pspRef }),
    });
    const futureTs = new Date(Date.now() + 60_000).toISOString();
    const res = await fetch(`${BANK_URL}/statements?since=${encodeURIComponent(futureTs)}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    // Only header row, no data rows
    expect(lines.length).toBeLessThanOrEqual(1);
  });

  it("POST /debit with missing fields returns 400", async () => {
    const res = await fetch(`${BANK_URL}/debit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 100 }), // missing currency + psp_ref
    });
    expect(res.status).toBe(400);
  });

  it("multiple debits appear in statement feed", async () => {
    const before = new Date(Date.now() - 1000).toISOString();
    const ref1 = uniqueRef("multi1");
    const ref2 = uniqueRef("multi2");

    await fetch(`${BANK_URL}/debit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 200, currency: "INR", psp_ref: ref1, ref: ref1 }),
    });
    await fetch(`${BANK_URL}/debit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 300, currency: "INR", psp_ref: ref2, ref: ref2 }),
    });

    const res = await fetch(`${BANK_URL}/statements?since=${encodeURIComponent(before)}`);
    const text = await res.text();
    expect(text).toContain(ref1);
    expect(text).toContain(ref2);
  });
});
