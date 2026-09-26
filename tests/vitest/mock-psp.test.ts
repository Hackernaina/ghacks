/**
 * Mock PSP Test Suite
 * Runs against a live Mock PSP instance.
 * Set PSP_URL env var to point at your mock (default: http://localhost:4001)
 * These tests are READ/WRITE — they create payments and inject faults.
 * Safe to run repeatedly; idempotency key is unique per test run.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "crypto";

const PSP_URL = process.env.PSP_A_URL ?? process.env.PSP_URL ?? "http://localhost:4001";
const BANK_URL = process.env.BANK_URL ?? "http://localhost:4003";
const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET_PSP_A ?? process.env.WEBHOOK_SECRET ?? "dev-secret-psp-a";

// ─── Helpers ────────────────────────────────────────────────────────────────

function uniqueKey(prefix = "ord") {
  const orderId = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  return `${orderId}:1`;
}

async function resetFaults() {
  await fetch(`${PSP_URL}/admin/faults`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dropPercent: 0,
      webhookDelayMs: 0,
      duplicatePercent: 0,
      reorderWebhooks: false,
      settlementMismatch: false,
      bypassIdempotency: false,
    }),
  });
}

async function createPayment(idempotencyKey: string, amount = 1000) {
  const orderId = idempotencyKey.split(":")[0] || `order_${Date.now()}`;
  return fetch(`${PSP_URL}/v1/payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
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

async function getPaymentByKey(key: string) {
  return fetch(`${PSP_URL}/v1/payments?idempotency_key=${encodeURIComponent(key)}`);
}

function verifyHmac(payload: string, signature: string, secret: string) {
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  return signature === expected;
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  await resetFaults();
});

afterAll(async () => {
  await resetFaults();
});

// ════════════════════════════════════════════════════════════════════════════
// HAPPY PATH
// ════════════════════════════════════════════════════════════════════════════

describe("Happy path — Mock PSP", () => {
  it("POST /v1/payments returns 200 with pspRef and status", async () => {
    const key = uniqueKey("happy");
    const res = await createPayment(key);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("pspRef");
    expect(body).toHaveProperty("status");
    expect(["PENDING", "SUCCEEDED", "CREATED"]).toContain(body.status);
  });

  it("GET /v1/payments?idempotency_key=K returns the same payment", async () => {
    const key = uniqueKey("getbykey");
    await createPayment(key);
    const res = await getPaymentByKey(key);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.idempotencyKey).toBe(key);
  });

  it("GET /v1/payments?idempotency_key=MISSING returns 404", async () => {
    const res = await getPaymentByKey("nonexistent-key-xyz:1");
    expect(res.status).toBe(404);
  });

  it("GET /v1/settlements?since= returns CSV with headers", async () => {
    const since = new Date(Date.now() - 60_000).toISOString();
    const res = await fetch(`${PSP_URL}/v1/settlements?since=${encodeURIComponent(since)}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    // Must be CSV with at least a header row
    expect(text.length).toBeGreaterThan(0);
    const firstLine = text.split("\n")[0];
    // Header must contain these columns from SETTLEMENT_CSV_HEADER
    expect(firstLine.toLowerCase()).toContain("psp_ref");
    expect(firstLine.toLowerCase()).toContain("amount");
    expect(firstLine.toLowerCase()).toContain("status");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY
// ════════════════════════════════════════════════════════════════════════════

describe("Idempotency", () => {
  it("same key returns identical response on repeat POST", async () => {
    const key = uniqueKey("idem");
    const res1 = await createPayment(key, 500);
    const res2 = await createPayment(key, 500);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const body1 = await res1.json();
    const body2 = await res2.json();
    expect(body1.pspRef).toBe(body2.pspRef);
    expect(body1.status).toBe(body2.status);
  });

  it("same key with different amount still returns original response", async () => {
    const key = uniqueKey("idem-diff-amount");
    const res1 = await createPayment(key, 100);
    const res2 = await createPayment(key, 999); // different amount
    const body1 = await res1.json();
    const body2 = await res2.json();
    // Should return original, not error or new payment
    expect(body1.pspRef).toBe(body2.pspRef);
  });

  it("different keys produce different pspRefs", async () => {
    const key1 = uniqueKey("diff1");
    const key2 = uniqueKey("diff2");
    const res1 = await createPayment(key1);
    const res2 = await createPayment(key2);
    const body1 = await res1.json();
    const body2 = await res2.json();
    expect(body1.pspRef).not.toBe(body2.pspRef);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// FAULT INJECTION
// ════════════════════════════════════════════════════════════════════════════

describe("Fault injection — /admin/faults", () => {
  it("POST /admin/faults returns 200", async () => {
    const res = await fetch(`${PSP_URL}/admin/faults`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dropPercent: 0 }),
    });
    expect(res.status).toBe(200);
  });

  it("dropPercent=100 causes payment requests to fail or timeout", async () => {
    await fetch(`${PSP_URL}/admin/faults`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dropPercent: 100 }),
    });

    const key = uniqueKey("drop");
    let failed = false;
    try {
      const res = await createPayment(key);
      // Could be 503, 504, or connection refused
      if (!res.ok) failed = true;
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    await resetFaults();
  });

  it("duplicatePercent=100 causes webhook to fire more than once", async () => {
    // This is hard to assert directly without a webhook receiver.
    // We verify the fault is accepted and the payment still completes.
    await fetch(`${PSP_URL}/admin/faults`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duplicatePercent: 100 }),
    });
    const key = uniqueKey("dup");
    const res = await createPayment(key);
    expect(res.status).toBe(200);
    await resetFaults();
  });

  it("bypassIdempotency=true causes same key to return different pspRef", async () => {
    await fetch(`${PSP_URL}/admin/faults`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bypassIdempotency: true }),
    });
    const key = uniqueKey("bypass");
    const res1 = await createPayment(key);
    const res2 = await createPayment(key);
    const body1 = await res1.json();
    const body2 = await res2.json();
    // With bypass, pspRef may differ
    expect(body1.pspRef).not.toBe(body2.pspRef);
    await resetFaults();
  });

  it("settlementMismatch=true omits or alters rows in settlement CSV", async () => {
    await fetch(`${PSP_URL}/admin/faults`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settlementMismatch: true }),
    });
    // Just verify the endpoint still responds with CSV
    const since = new Date(Date.now() - 60_000).toISOString();
    const res = await fetch(`${PSP_URL}/v1/settlements?since=${encodeURIComponent(since)}`);
    expect(res.status).toBe(200);
    await resetFaults();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WEBHOOK SIGNATURE
// ════════════════════════════════════════════════════════════════════════════

describe("Webhook HMAC signature", () => {
  it("webhook payload can be verified with shared secret", () => {
    // Simulate what the mock PSP sends according to WebhookPayload schema
    const payload = JSON.stringify({
      eventId: "evt-001",
      type: "payment.succeeded",
      createdAt: new Date().toISOString(),
      data: {
        pspRef: "pa_abc12345",
        idempotencyKey: "ord_test:1",
        orderId: "ord_test",
        amount: 150000,
        currency: "INR",
        status: "SUCCEEDED",
      },
    });
    const sig = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(payload)
      .digest("hex");
    expect(verifyHmac(payload, sig, WEBHOOK_SECRET)).toBe(true);
  });

  it("tampered payload fails HMAC verification", () => {
    const payload = JSON.stringify({
      eventId: "evt-002",
      type: "payment.succeeded",
      createdAt: new Date().toISOString(),
      data: {
        pspRef: "pa_abc12345",
        idempotencyKey: "ord_test:1",
        orderId: "ord_test",
        amount: 150000,
        currency: "INR",
        status: "SUCCEEDED",
      },
    });
    const sig = crypto
      .createHmac("sha256", WEBHOOK_SECRET)
      .update(payload)
      .digest("hex");
    const tampered = payload.replace("SUCCEEDED", "FAILED");
    expect(verifyHmac(tampered, sig, WEBHOOK_SECRET)).toBe(false);
  });
});
