import type pg from "pg";
import { BankStatementLine, type PspId, SettlementLine } from "@reconcile/shared";
import { type Config, pspUrlFor } from "../config/index.js";
import { logger } from "../logger.js";
import { parseCsv } from "./csv.js";
import { findPaymentId, recordEvidence } from "./evidence-store.js";

const EPOCH = "1970-01-01T00:00:00.000Z";
/** Re-read this much before the newest line seen; dedup keys make re-reading harmless. */
const OVERLAP_MS = 60_000;

async function getCursor(pool: pg.Pool, name: string): Promise<string> {
  const { rows } = await pool.query<{ cursor: string }>("SELECT cursor FROM ingest_cursors WHERE name = $1", [name]);
  return rows[0]?.cursor ?? EPOCH;
}

async function advanceCursor(pool: pg.Pool, name: string, previous: string, maxSeen: Date | null): Promise<void> {
  if (!maxSeen) return;
  const candidate = new Date(maxSeen.getTime() - OVERLAP_MS);
  if (candidate.getTime() <= new Date(previous).getTime()) return;
  await pool.query(
    `INSERT INTO ingest_cursors (name, cursor, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (name) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()`,
    [name, candidate.toISOString()],
  );
}

async function fetchCsv(url: string, timeoutMs: number): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "CSV feed returned an error");
      return null;
    }
    return await res.text();
  } catch (err) {
    logger.warn({ err, url }, "CSV feed fetch failed");
    return null;
  }
}

export interface PollSummary {
  lines: number;
  inserted: number;
  duplicates: number;
}

export async function pollSettlements(pool: pg.Pool, config: Config, psp: PspId): Promise<PollSummary> {
  const cursorName = `settlement:${psp}`;
  const since = await getCursor(pool, cursorName);
  const text = await fetchCsv(`${pspUrlFor(config, psp)}/v1/settlements?since=${encodeURIComponent(since)}`, config.PSP_TIMEOUT_MS);
  const summary: PollSummary = { lines: 0, inserted: 0, duplicates: 0 };
  if (text === null) return summary;

  let maxSeen: Date | null = null;
  for (const row of parseCsv(text)) {
    const parsed = SettlementLine.safeParse(row);
    if (!parsed.success) {
      logger.warn({ psp, row, issues: parsed.error.issues }, "skipping invalid settlement line");
      continue;
    }
    const line = parsed.data;
    const settledAt = new Date(line.settled_at);
    if (Number.isNaN(settledAt.getTime())) {
      logger.warn({ psp, row }, "skipping settlement line with invalid settled_at");
      continue;
    }
    const paymentId = await findPaymentId(pool, line.idempotency_key, line.psp_ref);
    const result = await recordEvidence(pool, {
      source: "SETTLEMENT",
      sourceEventId: `${line.batch_id}:${line.line_no}`,
      paymentId,
      psp,
      pspRef: line.psp_ref,
      idemKey: line.idempotency_key,
      orderId: line.order_id,
      reportedStatus: "SETTLED",
      amount: line.amount,
      currency: line.currency,
      observedAt: settledAt,
      raw: line,
    });
    summary.lines += 1;
    if (result.inserted) summary.inserted += 1;
    else summary.duplicates += 1;
    if (!maxSeen || settledAt > maxSeen) maxSeen = settledAt;
  }
  await advanceCursor(pool, cursorName, since, maxSeen);
  if (summary.lines) logger.info({ psp, ...summary }, "settlement feed ingested");
  return summary;
}

export async function pollBankStatements(pool: pg.Pool, config: Config): Promise<PollSummary> {
  const cursorName = "bank";
  const since = await getCursor(pool, cursorName);
  const text = await fetchCsv(`${config.BANK_URL}/statements?since=${encodeURIComponent(since)}`, config.PSP_TIMEOUT_MS);
  const summary: PollSummary = { lines: 0, inserted: 0, duplicates: 0 };
  if (text === null) return summary;

  let maxSeen: Date | null = null;
  for (const row of parseCsv(text)) {
    const parsed = BankStatementLine.safeParse(row);
    if (!parsed.success) {
      logger.warn({ row, issues: parsed.error.issues }, "skipping invalid bank statement line");
      continue;
    }
    const line = parsed.data;
    const creditedAt = new Date(line.credited_at);
    if (Number.isNaN(creditedAt.getTime())) {
      logger.warn({ row }, "skipping bank line with invalid credited_at");
      continue;
    }
    const paymentId = await findPaymentId(pool, null, line.psp_ref);
    const result = await recordEvidence(pool, {
      source: "BANK_STATEMENT",
      sourceEventId: `${line.statement_id}:${line.line_no}`,
      paymentId,
      psp: null,
      pspRef: line.psp_ref,
      idemKey: null,
      orderId: null,
      reportedStatus: "CREDITED",
      amount: line.amount,
      currency: line.currency,
      observedAt: creditedAt,
      raw: line,
    });
    summary.lines += 1;
    if (result.inserted) summary.inserted += 1;
    else summary.duplicates += 1;
    if (!maxSeen || creditedAt > maxSeen) maxSeen = creditedAt;
  }
  await advanceCursor(pool, cursorName, since, maxSeen);
  if (summary.lines) logger.info({ ...summary }, "bank statement feed ingested");
  return summary;
}

export async function pollAllFeeds(pool: pg.Pool, config: Config): Promise<void> {
  const jobs: Array<[string, () => Promise<unknown>]> = [
    ["settlement:psp_a", () => pollSettlements(pool, config, "psp_a")],
    ["settlement:psp_b", () => pollSettlements(pool, config, "psp_b")],
    ["bank", () => pollBankStatements(pool, config)],
  ];
  for (const [name, job] of jobs) {
    try {
      await job();
    } catch (err) {
      logger.error({ err, feed: name }, "CSV poller failed; continuing");
    }
  }
}
