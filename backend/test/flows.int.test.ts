import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { InvariantsView, PaymentDetailView, PaymentView, ReviewCaseView } from "@reconcile/shared";
import { pollSettlements } from "../src/ingestion/pollers.js";
import { signatureFor } from "../src/ingestion/webhooks.js";
import { type Harness, startHarness, waitFor } from "./helpers/harness.js";

let h: Harness;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${h.baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function setFaults(faults: Record<string, unknown>) {
  await h.stub.app.inject({ method: "POST", url: "/admin/faults", payload: faults });
}

async function pay(amount = 150000): Promise<PaymentView> {
  const order = await api<{ id: string }>("/orders", {
    method: "POST",
    body: JSON.stringify({ customerId: `cust_${Math.random()}`, amount, currency: "INR" }),
  });
  return api<PaymentView>(`/orders/${order.id}/pay`, { method: "POST", body: "{}" });
}

const detail = (id: string) => api<PaymentDetailView>(`/admin/payments/${id}`);

async function settled(id: string, predicate: (d: PaymentDetailView) => boolean): Promise<PaymentDetailView> {
  return waitFor(async () => {
    const d = await detail(id);
    return predicate(d) ? d : null;
  });
}

async function expectInvariantsOk() {
  await h.worker.idle();
  const inv = await api<InvariantsView>("/admin/invariants");
  expect(inv.checks.filter((c) => !c.ok)).toEqual([]);
  expect(inv.ok).toBe(true);
}

const captures = (d: PaymentDetailView) => d.ledger.filter((l) => l.entryType === "CAPTURE");

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.close();
});

beforeEach(async () => {
  await h.reset();
});

describe("end-to-end flows", () => {
  it("happy path: pay → SUCCEEDED with one CAPTURE", async () => {
    const p = await pay();
    const d = await settled(p.id, (d) => d.payment.state === "SUCCEEDED" && d.evidence.length === 2 && d.ledger.length === 1);
    expect(d.payment.confidence).toBe("HIGH");
    expect(d.evidence.map((e) => e.source).sort()).toEqual(["SYNC_RESPONSE", "WEBHOOK"]);
    expect(captures(d)).toHaveLength(1);
    await expectInvariantsOk();
  });

  it("double click returns the existing active payment", async () => {
    const order = await api<{ id: string }>("/orders", {
      method: "POST",
      body: JSON.stringify({ customerId: "cust_dc", amount: 5000, currency: "INR" }),
    });
    const first = await api<PaymentView>(`/orders/${order.id}/pay`, { method: "POST", body: "{}" });
    const second = await api<PaymentView>(`/orders/${order.id}/pay`, { method: "POST", body: "{}" });
    expect(second.id).toBe(first.id);
    await h.stub.webhooksDelivered();
  });

  it("50 duplicate webhooks → one evidence row with duplicate_count 49, one CAPTURE", async () => {
    await setFaults({ webhookDuplicates: 50 });
    const p = await pay();
    await h.stub.webhooksDelivered();
    const d = await settled(p.id, (d) => d.evidence.find((e) => e.source === "WEBHOOK")?.duplicateCount === 49 && d.ledger.length === 1);
    expect(d.evidence.filter((e) => e.source === "WEBHOOK")).toHaveLength(1);
    expect(captures(d)).toHaveLength(1);
    await waitFor(async () => (await detail(p.id)).payment.reason?.includes("webhook delivered 50x, counted once"));
    const stats = await api<{ duplicatesSuppressed: number }>("/admin/stats");
    expect(stats.duplicatesSuppressed).toBe(49);
    await expectInvariantsOk();
  });

  it("lost response → UNKNOWN, then the status query recovers it", async () => {
    await setFaults({ dropResponse: true, webhookDelayMs: 2000 });
    const p = await pay();
    expect(p.state).toBe("UNKNOWN");
    await setFaults({ dropResponse: false });
    const d = await settled(p.id, (d) => d.payment.state === "SUCCEEDED");
    expect(d.evidence.map((e) => e.source)).toContain("STATUS_QUERY");
    expect(d.evidence.map((e) => e.source)).not.toContain("SYNC_RESPONSE");
    expect(d.payment.pspRef).not.toBeNull();
    await h.stub.webhooksDelivered();
    await settled(p.id, (d) => d.evidence.some((e) => e.source === "WEBHOOK"));
    expect(captures(await detail(p.id))).toHaveLength(1);
    await expectInvariantsOk();
  });

  it("reordered webhooks (older FAILED arrives last) → SUCCEEDED + CONFLICT, one CAPTURE", async () => {
    await setFaults({ webhookReorder: true });
    const p = await pay();
    await h.stub.webhooksDelivered();
    const d = await settled(
      p.id,
      (d) => d.evidence.filter((e) => e.source === "WEBHOOK").length === 2 && d.cases.some((c) => c.caseType === "CONFLICT"),
    );
    expect(d.payment.state).toBe("SUCCEEDED");
    expect(captures(d)).toHaveLength(1);
    await expectInvariantsOk();
  });

  it("bypassed idempotency on a same-key resend → two CAPTUREs + DOUBLE_CHARGE", async () => {
    await setFaults({ dropResponse: true, bypassIdempotency: true, notFoundForMs: 3000, webhookDelayMs: 2500 });
    const p = await pay();
    expect(p.state).toBe("UNKNOWN");
    await setFaults({ dropResponse: false });
    await h.stub.webhooksDelivered();
    const d = await settled(p.id, (d) => d.cases.some((c) => c.caseType === "DOUBLE_CHARGE") && captures(d).length === 2);
    expect(new Set(captures(d).map((c) => c.pspRef)).size).toBe(2);
    expect(d.evidence.some((e) => e.reportedStatus === "NOT_FOUND")).toBe(true);
    await expectInvariantsOk();
  });

  it("settlement CSV re-imported twice → no new evidence, payment SETTLED", async () => {
    const p = await pay();
    await settled(p.id, (d) => d.payment.state === "SUCCEEDED" && d.ledger.length === 1);
    await h.stub.app.inject({ method: "POST", url: "/admin/settle" });

    const first = await pollSettlements(h.pool, h.config, "psp_a");
    const second = await pollSettlements(h.pool, h.config, "psp_a");
    expect(first).toEqual({ lines: 1, inserted: 1, duplicates: 0 });
    expect(second).toEqual({ lines: 1, inserted: 0, duplicates: 1 });

    const d = await settled(p.id, (d) => d.payment.state === "SETTLED");
    expect(d.evidence.filter((e) => e.source === "SETTLEMENT")).toHaveLength(1);
    await expectInvariantsOk();
  });

  it("manual MARK_FAILED on a conflicted, captured payment → REVERSAL and invariants hold", async () => {
    await setFaults({ webhookReorder: true });
    const p = await pay();
    await h.stub.webhooksDelivered();
    const d = await settled(p.id, (d) => d.cases.some((c) => c.caseType === "CONFLICT" && c.status === "OPEN") && d.ledger.length === 1);
    const conflict = d.cases.find((c) => c.caseType === "CONFLICT")!;

    const resolved = await api<ReviewCaseView>(`/admin/review/${conflict.id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolution: "MARK_FAILED", note: "customer confirmed no charge" }),
    });
    expect(resolved.status).toBe("RESOLVED");

    const after = await settled(p.id, (d) => d.payment.state === "FAILED" && d.ledger.some((l) => l.entryType === "REVERSAL"));
    expect(after.ledger.reduce((sum, l) => sum + l.amount, 0)).toBe(0);
    expect(after.cases.filter((c) => c.status === "OPEN")).toEqual([]);
    await expectInvariantsOk();
  });

  it("webhooks: bad signature → 401, bad payload → 400, unknown payment → stored as orphan", async () => {
    const body = JSON.stringify({ hello: "world" });
    const bad = await fetch(`${h.baseUrl}/webhooks/psp_a`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": "00" },
      body,
    });
    expect(bad.status).toBe(401);

    const invalid = await fetch(`${h.baseUrl}/webhooks/psp_a`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": signatureFor("test-secret-a", body) },
      body,
    });
    expect(invalid.status).toBe(400);

    const orphan = JSON.stringify({
      eventId: "evt_orphan_1",
      type: "payment.succeeded",
      createdAt: new Date().toISOString(),
      data: { pspRef: "pa_nobody", idempotencyKey: "nope:1", orderId: "nope", amount: 100, currency: "INR", status: "SUCCEEDED" },
    });
    const ok = await fetch(`${h.baseUrl}/webhooks/psp_a`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-signature": signatureFor("test-secret-a", orphan) },
      body: orphan,
    });
    expect(ok.status).toBe(200);
    const { rows } = await h.pool.query("SELECT payment_id FROM evidence WHERE source_event_id = 'evt_orphan_1'");
    expect(rows).toEqual([{ payment_id: null }]);
  });

  it("SSE stream sends the current PaymentView and then updates", async () => {
    await setFaults({ dropResponse: true, webhookDelayMs: 1500 });
    const p = await pay();
    await setFaults({ dropResponse: false });
    const res = await fetch(`${h.baseUrl}/payments/${p.id}/stream`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const states: string[] = [];
    await waitFor(async () => {
      const { value } = await reader.read();
      buffer += decoder.decode(value, { stream: true });
      for (const m of buffer.matchAll(/event: payment\ndata: (.*)\n\n/g)) states.push((JSON.parse(m[1]!) as PaymentView).state);
      buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
      return states.includes("SUCCEEDED");
    });
    await reader.cancel();
    expect(states[0]).toBe("UNKNOWN");
    await h.stub.webhooksDelivered();
  });
});
