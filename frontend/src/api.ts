import type {
  OrderView,
  OrderWithPaymentsView,
  PaymentView,
  PaymentDetailView,
  PagedPaymentsView,
  ReviewCaseView,
  InvariantsView,
  StatsView,
  CaseResolution,
  PaymentState,
  PspId,
} from "@reconcile/shared";

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  createOrder: (body: { customerId: string; amount: number; currency: string }) =>
    json<OrderView>("/orders", { method: "POST", body: JSON.stringify(body) }),

  getOrder: (orderId: string) => json<OrderWithPaymentsView>(`/orders/${orderId}`),

  pay: (orderId: string, psp?: PspId) =>
    json<PaymentView>(`/orders/${orderId}/pay`, {
      method: "POST",
      body: JSON.stringify(psp ? { psp } : {}),
    }),

  getPayment: (id: string) => json<PaymentView>(`/payments/${id}`),

  listPayments: (params: { state?: PaymentState; limit?: number; cursor?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.state) q.set("state", params.state);
    if (params.limit) q.set("limit", String(params.limit));
    if (params.cursor) q.set("cursor", params.cursor);
    const qs = q.toString();
    return json<PagedPaymentsView>(`/admin/payments${qs ? `?${qs}` : ""}`);
  },

  getPaymentDetail: (id: string) => json<PaymentDetailView>(`/admin/payments/${id}`),

  listReviewCases: (status: "OPEN" | "RESOLVED" = "OPEN") =>
    json<ReviewCaseView[]>(`/admin/review?status=${status}`),

  resolveCase: (id: string, resolution: CaseResolution, note?: string) =>
    json<ReviewCaseView>(`/admin/review/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolution, note }),
    }),

  invariants: () => json<InvariantsView>("/admin/invariants"),

  stats: () => json<StatsView>("/admin/stats"),
};

/** Subscribes to a payment's SSE stream (Section 3.4: `payment` event, `PaymentView` payload). */
export function subscribeToPayment(id: string, onUpdate: (p: PaymentView) => void): () => void {
  const es = new EventSource(`/payments/${id}/stream`);
  es.addEventListener("payment", (ev) => {
    onUpdate(JSON.parse((ev as MessageEvent).data) as PaymentView);
  });
  return () => es.close();
}

/** Direct calls to Person A's PSP/bank mocks (Section "Fault injection" in mocks/README.md),
 *  proxied in dev by vite.config.ts under /mock-a, /mock-b, /mock-bank. */
export const mocks = {
  setFaults: (target: "mock-a" | "mock-b" | "mock-bank", faults: Record<string, unknown>) =>
    json<unknown>(`/${target}/admin/faults`, { method: "POST", body: JSON.stringify(faults) }),
};
