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

// Empty = same origin (the dev server proxies to the backend). Set for a static deploy.
const API_URL: string = import.meta.env.VITE_API_URL ?? "";
const MOCK_URLS = {
  "mock-a": import.meta.env.VITE_MOCK_A_URL || "/mock-a",
  "mock-b": import.meta.env.VITE_MOCK_B_URL || "/mock-b",
  "mock-bank": import.meta.env.VITE_MOCK_BANK_URL || "/mock-bank",
} as const;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(await describeFailure(res));
  return res.json() as Promise<T>;
}

/**
 * A short, readable message for a failed response. The backend answers with
 * `{ error, message? }`; anything else (a proxy or host error page) is HTML and
 * is reduced to the status line instead of being dumped into the UI.
 */
async function describeFailure(res: Response): Promise<string> {
  const status = `${res.status} ${res.statusText}`.trim();
  const body = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(body) as { error?: string; message?: string };
    const detail = [parsed.error, parsed.message].filter(Boolean).join(": ");
    if (detail) return `${status}: ${detail}`;
  } catch {
    // not JSON
  }
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    return `${status}: service unreachable. Check that it is running and that the frontend's proxy target / API URL points at it.`;
  }
  if (!body || body.trimStart().startsWith("<")) return status;
  return `${status}: ${body.slice(0, 200)}`;
}

const json = <T,>(path: string, init?: RequestInit) => request<T>(`${API_URL}${path}`, init);

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
  const es = new EventSource(`${API_URL}/payments/${id}/stream`);
  es.addEventListener("payment", (ev) => {
    onUpdate(JSON.parse((ev as MessageEvent).data) as PaymentView);
  });
  return () => es.close();
}

/** Fault injection on the PSP/bank mocks (mocks/README.md). Proxied in dev; set VITE_MOCK_*_URL when deployed. */
export const mocks = {
  setFaults: (target: keyof typeof MOCK_URLS, faults: Record<string, unknown>) =>
    request<unknown>(`${MOCK_URLS[target]}/admin/faults`, { method: "POST", body: JSON.stringify(faults) }),
  reset: (target: keyof typeof MOCK_URLS) => request<unknown>(`${MOCK_URLS[target]}/admin/reset`, { method: "POST", body: "{}" }),
};
