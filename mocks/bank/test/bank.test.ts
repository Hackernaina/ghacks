/**
 * In-process tests for Mock Bank
 * Uses Fastify's inject() — no live port required.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { buildBankServer, BANK_STATEMENT_CSV_HEADER } from "../src/index.js";

const app = buildBankServer();

beforeEach(async () => {
  await app.inject({ method: "POST", url: "/admin/reset" });
});

// ── Health check ─────────────────────────────────────────────────────────────

describe("Health check", () => {
  it("GET /healthz returns ok", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.service).toBe("mock-bank");
  });
});

// ── POST /debit ───────────────────────────────────────────────────────────────

describe("POST /debit", () => {
  it("returns 200 with bankRef for valid payload (psp_ref field)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/debit",
      payload: { amount: 1000, currency: "INR", psp_ref: "pa_abc12345" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("bankRef");
    expect(body.bankRef).toMatch(/^bnk_/);
  });

  it("returns 200 with bankRef for valid payload (ref alias field)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/debit",
      payload: { amount: 500, currency: "INR", ref: "pa_xyz99999" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bankRef).toMatch(/^bnk_/);
  });

  it("returns 400 when amount is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/debit",
      payload: { currency: "INR", psp_ref: "pa_abc" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when currency is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/debit",
      payload: { amount: 100, psp_ref: "pa_abc" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when both psp_ref and ref are missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/debit",
      payload: { amount: 100, currency: "INR" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("each debit gets a unique bankRef", async () => {
    const r1 = await app.inject({
      method: "POST",
      url: "/debit",
      payload: { amount: 100, currency: "INR", psp_ref: "pa_ref1" },
    });
    const r2 = await app.inject({
      method: "POST",
      url: "/debit",
      payload: { amount: 200, currency: "INR", psp_ref: "pa_ref2" },
    });
    expect(r1.json().bankRef).not.toBe(r2.json().bankRef);
  });
});

// ── GET /statements ───────────────────────────────────────────────────────────

describe("GET /statements", () => {
  it("returns CSV with correct header", async () => {
    const res = await app.inject({ method: "GET", url: "/statements" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const firstLine = res.body.split("\n")[0];
    expect(firstLine).toBe(BANK_STATEMENT_CSV_HEADER);
  });

  it("returns recorded debit in statement", async () => {
    await app.inject({
      method: "POST",
      url: "/debit",
      payload: { amount: 750, currency: "INR", psp_ref: "pa_stmt_test" },
    });
    const res = await app.inject({ method: "GET", url: "/statements" });
    expect(res.body).toContain("pa_stmt_test");
    expect(res.body).toContain("CREDIT");
  });

  it("type column is always CREDIT", async () => {
    await app.inject({
      method: "POST",
      url: "/debit",
      payload: { amount: 100, currency: "INR", psp_ref: "pa_type_test" },
    });
    const res = await app.inject({ method: "GET", url: "/statements" });
    const dataLines = res.body.split("\n").slice(1).filter(Boolean);
    for (const line of dataLines) {
      const cols = line.split(",");
      expect(cols[5]).toBe("CREDIT"); // type is 6th column (0-indexed: 5)
    }
  });

  it("since filter excludes entries before timestamp", async () => {
    await app.inject({
      method: "POST",
      url: "/debit",
      payload: { amount: 100, currency: "INR", psp_ref: "pa_old" },
    });
    const futureTs = new Date(Date.now() + 60_000).toISOString();
    const res = await app.inject({
      method: "GET",
      url: `/statements?since=${encodeURIComponent(futureTs)}`,
    });
    const lines = res.body.split("\n").filter(Boolean);
    // Only header row — no data rows
    expect(lines.length).toBeLessThanOrEqual(1);
  });

  it("multiple debits are all present in statement", async () => {
    for (const ref of ["pa_multi1", "pa_multi2", "pa_multi3"]) {
      await app.inject({
        method: "POST",
        url: "/debit",
        payload: { amount: 100, currency: "INR", psp_ref: ref },
      });
    }
    const res = await app.inject({ method: "GET", url: "/statements" });
    expect(res.body).toContain("pa_multi1");
    expect(res.body).toContain("pa_multi2");
    expect(res.body).toContain("pa_multi3");
  });

  it("statement_id starts with stmt_", async () => {
    await app.inject({
      method: "POST",
      url: "/debit",
      payload: { amount: 100, currency: "INR", psp_ref: "pa_id_test" },
    });
    const res = await app.inject({ method: "GET", url: "/statements" });
    const dataLine = res.body.split("\n")[1];
    expect(dataLine).toMatch(/^stmt_\d{8},/);
  });
});

// ── /admin/faults ─────────────────────────────────────────────────────────────

describe("POST /admin/faults", () => {
  it("returns 200 and echoes fault config", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/admin/faults",
      payload: { dropPercent: 50, delayMs: 200 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.faults.dropPercent).toBe(50);
    expect(body.faults.delayMs).toBe(200);
  });

  it("GET /admin/faults reflects stored config", async () => {
    await app.inject({
      method: "POST",
      url: "/admin/faults",
      payload: { dropPercent: 75 },
    });
    const res = await app.inject({ method: "GET", url: "/admin/faults" });
    expect(res.json().faults.dropPercent).toBe(75);
  });
});
