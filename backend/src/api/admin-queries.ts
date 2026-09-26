import type pg from "pg";
import { CaseType, type InvariantCheck, type InvariantsView, PaymentState, type StatsView } from "@reconcile/shared";

async function check(pool: pg.Pool, name: string, sql: string): Promise<InvariantCheck> {
  const { rows } = await pool.query(sql);
  return { name, ok: rows.length === 0, details: rows };
}

export async function runInvariants(pool: pg.Pool): Promise<InvariantsView> {
  const checks = await Promise.all([
    check(
      pool,
      "no psp_ref has more than one CAPTURE",
      `SELECT psp_ref, count(*) AS captures FROM ledger_entries
        WHERE entry_type = 'CAPTURE' GROUP BY psp_ref HAVING count(*) > 1`,
    ),
    check(
      pool,
      "every settlement line has a matching CAPTURE",
      `SELECT e.id AS evidence_id, e.psp_ref, e.amount AS settled_amount, l.amount AS captured_amount
         FROM evidence e
         LEFT JOIN ledger_entries l ON l.psp_ref = e.psp_ref AND l.entry_type = 'CAPTURE'
        WHERE e.source = 'SETTLEMENT' AND (l.id IS NULL OR l.amount <> e.amount)`,
    ),
    check(
      pool,
      "no order is over-captured without a DOUBLE_CHARGE case",
      `SELECT o.id AS order_id, o.amount AS order_amount, SUM(l.amount)::bigint AS net_captured
         FROM orders o JOIN ledger_entries l ON l.order_id = o.id
        GROUP BY o.id, o.amount
       HAVING SUM(l.amount) > o.amount
          AND NOT EXISTS (SELECT 1 FROM review_cases c WHERE c.order_id = o.id AND c.case_type = 'DOUBLE_CHARGE')`,
    ),
    check(
      pool,
      "no FAILED payment has a positive ledger balance",
      `SELECT p.id AS payment_id, SUM(l.amount)::bigint AS balance
         FROM payments p JOIN ledger_entries l ON l.payment_id = p.id
        WHERE p.state = 'FAILED'
        GROUP BY p.id HAVING SUM(l.amount) > 0`,
    ),
    check(
      pool,
      "every UNKNOWN/PENDING payment past its deadline has an open UNRESOLVED case",
      `SELECT p.id AS payment_id, p.state, p.deadline_at FROM payments p
        WHERE p.state IN ('UNKNOWN', 'PENDING') AND p.deadline_at < now()
          AND NOT EXISTS (SELECT 1 FROM review_cases c
                           WHERE c.payment_id = p.id AND c.case_type = 'UNRESOLVED' AND c.status = 'OPEN')`,
    ),
  ]);
  return { ok: checks.every((c) => c.ok), checks };
}

export async function loadStats(pool: pg.Pool): Promise<StatsView> {
  const [states, cases, evidence] = await Promise.all([
    pool.query<{ state: PaymentState; n: number }>("SELECT state, count(*) AS n FROM payments GROUP BY state"),
    pool.query<{ case_type: CaseType; n: number }>(
      "SELECT case_type, count(*) AS n FROM review_cases WHERE status = 'OPEN' GROUP BY case_type",
    ),
    pool.query<{ total: number; duplicates: number }>(
      "SELECT count(*) AS total, COALESCE(SUM(duplicate_count), 0)::bigint AS duplicates FROM evidence",
    ),
  ]);

  const byState = Object.fromEntries(PaymentState.options.map((s) => [s, 0])) as Record<PaymentState, number>;
  for (const r of states.rows) byState[r.state] = r.n;
  const openCasesByType = Object.fromEntries(CaseType.options.map((c) => [c, 0])) as Record<CaseType, number>;
  for (const r of cases.rows) openCasesByType[r.case_type] = r.n;

  return {
    byState,
    openCasesByType,
    totalEvidence: evidence.rows[0]!.total,
    duplicatesSuppressed: evidence.rows[0]!.duplicates,
  };
}
