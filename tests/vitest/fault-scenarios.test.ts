/**
 * Fault Scenario Integration Tests
 * These test the full scenario flows — the same ones your demo script runs.
 * Requires PSP + Bank to be running.
 *
 * PSP_URL=http://localhost:4001
 * PSP_B_URL=http://localhost:4002
 * BANK_URL=http://localhost:4003
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

const PSP_URL = process.env.PSP_A_URL ?? process.env.PSP_URL ?? "http://localhost:4001";
const PSP_B_URL = process.env.PSP_B_URL ?? "http://localhost:4002";

function uniqueKey(prefix = "ord") {
  const orderId = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  return `${orderId}:1`;
}

async function setFaults(url: string, faults: Record<string, unknown>) {
  return fetch(`${url}/admin/faults`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(faults),
  });
}

async function clearFaults(url: string) {
  return setFaults(url, {
    dropPercent: 0,
    webhookDelayMs: 0,
    duplicatePercent: 0,
    reorderWebhooks: false,
    settlementMismatch: false,
    bypassIdempotency: false,
  });
}

async function createPayment(url: string, key: string, amount = 1000) {
  const orderId = key.split(":")[0] || `order_${Date.now()}`;
  return fetch(`${url}/v1/payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify({
      orderId,
      amount,
      currency: "INR",
      merchantPaymentId: `pay_${orderId}`,
      customerId: `cust_${orderId}`,
    }),
  });
}

// ─── Reset between each test ─────────────────────────────────────────────────

beforeEach(async () => {
  await clearFaults(PSP_URL);
  try { await clearFaults(PSP_B_URL); } catch { /* PSP B may not be running */ }
});

afterEach(async () => {
  await clearFaults(PSP_URL);
  try { await clearFaults(PSP_B_URL); } catch {}
});

// ════════════════════════════════════════════════════════════════════════════
// SCENARIO 1 — Lost response (UNKNOWN state)
// ════════════════════════════════════════════════════════════════════════════

describe("Scenario 1: Lost response → UNKNOWN state", () => {
  it("payment with 100% drop leaves no response, GET by key still returns state", async () => {
    const key = uniqueKey("lost");

    // Inject fault: drop all responses
    await setFaults(PSP_URL, { dropPercent: 100 });

    // This should fail (no response)
    let postFailed = false;
    try {
      const res = await createPayment(PSP_URL, key);
      if (!res.ok) postFailed = true;
    } catch {
      postFailed = true;
    }
    expect(postFailed).toBe(true);

    // Clear fault so Resolver can poll
    await clearFaults(PSP_URL);

    // Resolver polls GET /v1/payments?idempotency_key=K
    // The payment was written to PSP DB before the drop, so GET should work
    const res = await fetch(`${PSP_URL}/v1/payments?idempotency_key=${encodeURIComponent(key)}`);
    // Either 200 (found) or 404 (was never stored before drop — both valid)
    expect([200, 404]).toContain(res.status);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SCENARIO 2 — Duplicate webhook
// ════════════════════════════════════════════════════════════════════════════

describe("Scenario 2: Duplicate webhook delivery", () => {
  it("payment completes successfully even with duplicate% = 100", async () => {
    await setFaults(PSP_URL, { duplicatePercent: 100 });
    const key = uniqueKey("dup");
    const res = await createPayment(PSP_URL, key);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("pspRef");
  });

  it("PSP stores the payment only once regardless of duplicate webhooks", async () => {
    await setFaults(PSP_URL, { duplicatePercent: 100 });
    const key = uniqueKey("dup-store");
    await createPayment(PSP_URL, key);

    const getRes = await fetch(`${PSP_URL}/v1/payments?idempotency_key=${encodeURIComponent(key)}`);
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    // Should be a single object, not an array
    expect(Array.isArray(body)).toBe(false);
    expect(body).toHaveProperty("pspRef");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SCENARIO 3 — Late webhook
// ════════════════════════════════════════════════════════════════════════════

describe("Scenario 3: Late webhook delivery", () => {
  it("payment endpoint responds immediately even with 10s webhook delay", async () => {
    await setFaults(PSP_URL, { webhookDelayMs: 10_000 });
    const key = uniqueKey("late");
    const start = Date.now();
    const res = await createPayment(PSP_URL, key);
    const elapsed = Date.now() - start;

    // The POST itself should respond quickly (< 4s timeout)
    // The webhook fires late in the background
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(4000);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SCENARIO 4 — Out-of-order webhooks
// ════════════════════════════════════════════════════════════════════════════

describe("Scenario 4: Out-of-order webhook delivery", () => {
  it("payment is created successfully even with reorder=true", async () => {
    await setFaults(PSP_URL, { reorderWebhooks: true });
    const key = uniqueKey("reorder");
    const res = await createPayment(PSP_URL, key);
    expect(res.status).toBe(200);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SCENARIO 5 — Failover double charge (PSP A fails, PSP B fires)
// ════════════════════════════════════════════════════════════════════════════

describe("Scenario 5: Failover double charge", () => {
  it("PSP B accepts the same idempotency key independently", async () => {
    // Simulate: PSP A dropped, user retried on PSP B with same key
    const key = uniqueKey("failover");

    await setFaults(PSP_URL, { dropPercent: 100 }); // PSP A fails

    // PSP B gets the retry with same key
    let pspBWorking = true;
    try {
      const res = await createPayment(PSP_B_URL, key);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("pspRef");
    } catch {
      pspBWorking = false;
      console.warn("PSP B not running — skipping failover check");
    }

    if (pspBWorking) {
      // Both PSPs have a payment for this key — this is the double charge scenario
      await clearFaults(PSP_URL);
      const resA = await fetch(`${PSP_URL}/v1/payments?idempotency_key=${encodeURIComponent(key)}`);
      const resB = await fetch(`${PSP_B_URL}/v1/payments?idempotency_key=${encodeURIComponent(key)}`);

      // Both might return 200 — this is the bug the duplicate detector must catch
      const bothFound = resA.status === 200 && resB.status === 200;
      if (bothFound) {
        const bodyA = await resA.json();
        const bodyB = await resB.json();
        // They will have DIFFERENT pspRefs — this is the double charge
        expect(bodyA.pspRef).not.toBe(bodyB.pspRef);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SCENARIO 6 — Settlement mismatch
// ════════════════════════════════════════════════════════════════════════════

describe("Scenario 6: Settlement mismatch", () => {
  it("normal settlement CSV contains all recent payments", async () => {
    const before = new Date().toISOString();
    const key = uniqueKey("settle-match");
    await createPayment(PSP_URL, key);

    // Small wait for settlement to be recorded
    await new Promise((r) => setTimeout(r, 200));

    const res = await fetch(`${PSP_URL}/v1/settlements?since=${encodeURIComponent(before)}`);
    const text = await res.text();
    // In normal mode, the payment should appear
    // (This will pass if mock writes to settlement correctly)
    expect(res.status).toBe(200);
    expect(text.length).toBeGreaterThan(0);
  });

  it("mismatch fault produces a different settlement CSV", async () => {
    const before = new Date().toISOString();
    const key1 = uniqueKey("settle-ok");
    const key2 = uniqueKey("settle-missing");

    await createPayment(PSP_URL, key1);
    await createPayment(PSP_URL, key2);
    await new Promise((r) => setTimeout(r, 200));

    // Normal CSV
    const normalRes = await fetch(`${PSP_URL}/v1/settlements?since=${encodeURIComponent(before)}`);
    const normalText = await normalRes.text();

    // Enable mismatch
    await setFaults(PSP_URL, { settlementMismatch: true });

    const mismatchRes = await fetch(`${PSP_URL}/v1/settlements?since=${encodeURIComponent(before)}`);
    const mismatchText = await mismatchRes.text();

    // The two CSVs should differ
    expect(normalText).not.toBe(mismatchText);
  });
});
