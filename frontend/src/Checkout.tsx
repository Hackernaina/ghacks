import { useEffect, useRef, useState } from "react";
import type { PaymentView, PspId } from "@reconcile/shared";
import { api, subscribeToPayment } from "./api";

const CONFIRMING_STATES = new Set(["CREATED", "PENDING", "UNKNOWN"]);

export default function Checkout() {
  const [customerId, setCustomerId] = useState("cust_1");
  const [amount, setAmount] = useState(1500); // rupees, converted to paise on submit
  const [psp, setPsp] = useState<PspId | "">("");
  const [orderId, setOrderId] = useState<string | null>(null);
  const [payment, setPayment] = useState<PaymentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const unsubscribe = useRef<(() => void) | null>(null);

  useEffect(() => () => unsubscribe.current?.(), []);

  function watch(p: PaymentView) {
    unsubscribe.current?.();
    setPayment(p);
    unsubscribe.current = subscribeToPayment(p.id, setPayment);
  }

  async function payNewOrder() {
    setError(null);
    setBusy(true);
    try {
      const order = await api.createOrder({ customerId, amount: Math.round(amount * 100), currency: "INR" });
      setOrderId(order.id);
      const p = await api.pay(order.id, psp || undefined);
      watch(p);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (!orderId) return;
    setError(null);
    setBusy(true);
    try {
      const p = await api.pay(orderId, psp || undefined);
      watch(p);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const confirming = payment ? CONFIRMING_STATES.has(payment.state) : false;

  return (
    <div className="page">
      <div className="card">
        <h2>Checkout</h2>
        <p className="muted">
          Creates an order, pays it, then watches live status over SSE. "Confirming…" covers
          CREATED/PENDING/UNKNOWN — none of those are a failure.
        </p>
        <div className="row">
          <input value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="customerId" />
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            placeholder="amount (INR)"
          />
          <select value={psp} onChange={(e) => setPsp(e.target.value as PspId | "")}>
            <option value="">auto PSP</option>
            <option value="psp_a">psp_a</option>
            <option value="psp_b">psp_b</option>
          </select>
          <button disabled={busy} onClick={payNewOrder}>
            Pay
          </button>
          {payment?.state === "FAILED" && (
            <button className="ghost" disabled={busy} onClick={retry}>
              Retry (new attempt)
            </button>
          )}
        </div>
        {error && <p className="pill bad">{error}</p>}
        {payment && (
          <div style={{ marginTop: 16 }}>
            <div>
              Status{" "}
              <span className={`pill ${stateClass(payment.state)}`}>
                {confirming ? "Confirming…" : payment.state}
              </span>{" "}
              {payment.confidence && <span className="pill">{payment.confidence}</span>}
            </div>
            <p className="muted">
              {payment.id} · attempt {payment.attempt} · {payment.psp} · pspRef={payment.pspRef ?? "—"}
            </p>
            {payment.reason && <p className="muted">{payment.reason}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

function stateClass(s: PaymentView["state"]): string {
  if (s === "SUCCEEDED" || s === "SETTLED" || s === "REFUNDED") return "ok";
  if (s === "UNKNOWN" || s === "PENDING" || s === "CREATED") return "warn";
  if (s === "FAILED") return "bad";
  return "";
}
