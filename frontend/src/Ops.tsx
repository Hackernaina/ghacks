import { useEffect, useState } from "react";
import type { PaymentDetailView, PaymentState, ReviewCaseView, InvariantsView, StatsView } from "@reconcile/shared";
import { SUCCESS_CLASS_STATUSES } from "@reconcile/shared";
import { api, mocks } from "./api";

const STATES: PaymentState[] = ["CREATED", "PENDING", "UNKNOWN", "SUCCEEDED", "FAILED", "SETTLED", "REFUNDED"];
const SUCCESS_PAYMENT_STATES = new Set<PaymentState>(["SUCCEEDED", "SETTLED", "REFUNDED"]);

export default function Ops() {
  const [stateFilter, setStateFilter] = useState<PaymentState | "">("");
  const [payments, setPayments] = useState<PaymentDetailView["payment"][]>([]);
  const [cases, setCases] = useState<ReviewCaseView[]>([]);
  const [detail, setDetail] = useState<PaymentDetailView | null>(null);
  const [stats, setStats] = useState<StatsView | null>(null);
  const [invariants, setInvariants] = useState<InvariantsView | null>(null);
  const [note, setNote] = useState("");
  // These calls run from the poll timer and click handlers, so failures are
  // shown here instead of escaping as unhandled promise rejections.
  const [pollError, setPollError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function refresh() {
    try {
      const list = await api.listPayments(stateFilter ? { state: stateFilter } : {});
      setPayments(list.items);
      setCases(await api.listReviewCases("OPEN"));
      setStats(await api.stats());
      setInvariants(await api.invariants());
      setPollError(null);
    } catch (e) {
      setPollError(String(e));
    }
  }

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateFilter]);

  async function openPayment(id: string) {
    try {
      setDetail(await api.getPaymentDetail(id));
      setActionError(null);
    } catch (e) {
      setActionError(String(e));
    }
  }

  async function resolve(caseId: string, resolution: Parameters<typeof api.resolveCase>[1]) {
    try {
      await api.resolveCase(caseId, resolution, note || undefined);
      setNote("");
      setActionError(null);
    } catch (e) {
      setActionError(String(e));
      return;
    }
    await refresh();
  }

  return (
    <div className="page">
      {pollError && <p className="pill bad">{pollError}</p>}
      {actionError && <p className="pill bad">{actionError}</p>}
      <div className="card">
        <h2>Stats</h2>
        {stats && (
          <div className="row">
            {Object.entries(stats.byState).map(([s, n]) => (
              <span key={s} className="pill">
                {s}: {n}
              </span>
            ))}
            <span className="pill warn">duplicates suppressed: {stats.duplicatesSuppressed}</span>
            <span className="pill">evidence: {stats.totalEvidence}</span>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Invariants</h2>
        {!invariants && <p className="muted">loading…</p>}
        {invariants?.checks.map((c) => (
          <div key={c.name} className="row" style={{ marginBottom: 6 }}>
            <span className={`pill ${c.ok ? "ok" : "bad"}`}>{c.ok ? "OK" : "FAIL"}</span>
            <span>{c.name}</span>
            {!c.ok && <span className="muted">{JSON.stringify(c.details)}</span>}
          </div>
        ))}
      </div>

      <FaultPanel />

      <div className="card">
        <h2>Review queue</h2>
        <div className="row" style={{ marginBottom: 10 }}>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="resolution note (optional)" style={{ minWidth: 260 }} />
        </div>
        {cases.length === 0 && <p className="muted">No open cases.</p>}
        {cases.map((c) => (
          <div key={c.id} className="row" style={{ marginBottom: 8 }}>
            <span className="pill warn">{c.caseType}</span>
            <span className="muted">
              {c.summary}
              {c.suggestedAction ? ` — ${c.suggestedAction}` : ""}
            </span>
            <button className="ghost" onClick={() => resolve(c.id, "MARK_SUCCEEDED")}>
              Mark succeeded
            </button>
            <button className="ghost" onClick={() => resolve(c.id, "MARK_FAILED")}>
              Mark failed
            </button>
            <button className="ghost" onClick={() => resolve(c.id, "REFUND")}>
              Refund
            </button>
            <button className="ghost" onClick={() => resolve(c.id, "DISMISS")}>
              Dismiss
            </button>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Payments</h2>
        <div className="row" style={{ marginBottom: 10 }}>
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value as PaymentState | "")}>
            <option value="">all states</option>
            {STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <table>
          <thead>
            <tr>
              <th>state</th>
              <th>confidence</th>
              <th>amount</th>
              <th>psp</th>
              <th>pspRef</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((p) => (
              <tr key={p.id} onClick={() => openPayment(p.id)} style={{ cursor: "pointer" }}>
                <td>
                  <span className="pill">{p.state}</span>
                </td>
                <td>{p.confidence ?? "—"}</td>
                <td>
                  {(p.amount / 100).toFixed(2)} {p.currency}
                </td>
                <td>{p.psp}</td>
                <td>{p.pspRef ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail && (
        <div className="card">
          <h2>Evidence timeline</h2>
          <p className="muted">
            <span className={`pill ${detail.payment.state === "FAILED" ? "bad" : "ok"}`}>{detail.payment.state}</span>{" "}
            {detail.payment.id} · {detail.payment.reason}
          </p>
          <div className="timeline">
            {detail.evidence.map((e) => {
              const paymentIsSuccess = SUCCESS_PAYMENT_STATES.has(detail.payment.state);
              const paymentIsFailure = detail.payment.state === "FAILED";
              const disagrees =
                (SUCCESS_CLASS_STATUSES.has(e.reportedStatus) && paymentIsFailure) ||
                (e.reportedStatus === "FAILED" && paymentIsSuccess);
              return (
                <div className={`item${disagrees ? " disagree" : ""}`} key={e.id}>
                  <strong>
                    {e.source} (trust {e.trust}) → {e.reportedStatus}
                  </strong>
                  <div className="muted">
                    observed {e.observedAt} · received {e.receivedAt}
                    {e.duplicateCount > 0 ? ` · delivered ${e.duplicateCount + 1}×, counted once` : ""}
                    {e.pspRef ? ` · ${e.pspRef}` : ""}
                  </div>
                </div>
              );
            })}
          </div>

          <h3>Ledger</h3>
          {detail.ledger.length === 0 && <p className="muted">No postings.</p>}
          {detail.ledger.map((l) => (
            <div key={l.id} className="row">
              <span className="pill">{l.entryType}</span>
              <span>
                {(l.amount / 100).toFixed(2)} · {l.pspRef}
              </span>
            </div>
          ))}

          <h3>Cases</h3>
          {detail.cases.length === 0 && <p className="muted">No cases.</p>}
          {detail.cases.map((c) => (
            <div key={c.id} className="row">
              <span className={`pill ${c.status === "OPEN" ? "warn" : "ok"}`}>{c.caseType}</span>
              <span className="muted">{c.summary}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Fault injection on Person A's PSP mocks (flag names from mocks/README.md). */
function FaultPanel() {
  const [target, setTarget] = useState<"mock-a" | "mock-b">("mock-a");
  const [dropPercent, setDropPercent] = useState(0);
  const [duplicatePercent, setDuplicatePercent] = useState(0);
  const [webhookDelayMs, setWebhookDelayMs] = useState(0);
  const [bypassIdempotency, setBypassIdempotency] = useState(false);
  const [settlementMismatch, setSettlementMismatch] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function run(label: string, call: () => Promise<unknown>) {
    setStatus(null);
    try {
      await call();
      setStatus(label);
    } catch (e) {
      setStatus(`mock unreachable: ${String(e)}`);
    }
  }

  const apply = () =>
    run("applied", () =>
      mocks.setFaults(target, { dropPercent, duplicatePercent, webhookDelayMs, bypassIdempotency, settlementMismatch }),
    );

  return (
    <div className="card">
      <h2>Fault injection (mocks)</h2>
      <p className="muted">Posts to the PSP mock's /admin/faults (proxied via /mock-a, /mock-b in dev).</p>
      <div className="row">
        <select value={target} onChange={(e) => setTarget(e.target.value as "mock-a" | "mock-b")}>
          <option value="mock-a">psp_a</option>
          <option value="mock-b">psp_b</option>
        </select>
        <label>
          drop %{" "}
          <input type="number" min={0} max={100} style={{ width: 70 }} value={dropPercent} onChange={(e) => setDropPercent(Number(e.target.value))} />
        </label>
        <label>
          duplicate webhook %{" "}
          <input type="number" min={0} max={100} style={{ width: 70 }} value={duplicatePercent} onChange={(e) => setDuplicatePercent(Number(e.target.value))} />
        </label>
        <label>
          webhook delay ms{" "}
          <input type="number" min={0} style={{ width: 90 }} value={webhookDelayMs} onChange={(e) => setWebhookDelayMs(Number(e.target.value))} />
        </label>
        <label>
          <input type="checkbox" checked={bypassIdempotency} onChange={(e) => setBypassIdempotency(e.target.checked)} /> bypass idempotency
        </label>
        <label>
          <input type="checkbox" checked={settlementMismatch} onChange={(e) => setSettlementMismatch(e.target.checked)} /> settlement mismatch
        </label>
        <button onClick={apply}>Apply</button>
        <button className="ghost" onClick={() => run("mock reset", () => mocks.reset(target))}>
          Reset mock
        </button>
      </div>
      {status && <p className="muted">{status}</p>}
    </div>
  );
}
