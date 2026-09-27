import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Bank mock in-memory store
// ---------------------------------------------------------------------------

/** One entry recorded when POST /debit is called. */
export interface DebitEntry {
  bankRef: string;
  psp_ref: string;   // the pspRef passed in as ref / psp_ref
  amount: number;
  currency: string;
  credited_at: string; // ISO timestamp
  /** Assigned once at insert so (statement_id, line_no) never changes between requests. */
  statement_id: string;
  line_no: number;
}

/** Fault configuration for the bank mock. */
export interface BankFaultConfig {
  dropPercent?: number;
  delayMs?: number;
  [key: string]: unknown;
}

// In-memory debit log: bankRef -> DebitEntry
export const debitLog = new Map<string, DebitEntry>();

// In-memory fault config
let faultConfig: BankFaultConfig = {};

// ---------------------------------------------------------------------------
// Debit store helpers
// ---------------------------------------------------------------------------

// A new id per process start: in-memory line numbers restart at 1, and
// (statement_id, line_no) must never repeat for a different line.
const BOOT_ID = randomUUID().slice(0, 6);
const linesPerStatement = new Map<string, number>();

export function addDebit(entry: Omit<DebitEntry, "statement_id" | "line_no">): DebitEntry {
  const statement_id = `stmt_${entry.credited_at.slice(0, 10).replace(/-/g, "")}_${BOOT_ID}`;
  const line_no = (linesPerStatement.get(statement_id) ?? 0) + 1;
  linesPerStatement.set(statement_id, line_no);
  const stored = { ...entry, statement_id, line_no };
  debitLog.set(entry.bankRef, stored);
  return stored;
}

/** Return all debits credited at or after `since` (inclusive). */
export function getDebits(since?: string): DebitEntry[] {
  const entries = Array.from(debitLog.values());
  if (!since) return entries;

  const sinceTime = new Date(since).getTime();
  if (isNaN(sinceTime)) return entries;

  return entries.filter((e) => {
    const t = new Date(e.credited_at).getTime();
    return !isNaN(t) && t >= sinceTime;
  });
}

// ---------------------------------------------------------------------------
// Fault config helpers
// ---------------------------------------------------------------------------

export function getFaultConfig(): BankFaultConfig {
  return { ...faultConfig };
}

export function setFaultConfig(config: Partial<BankFaultConfig>): void {
  faultConfig = { ...faultConfig, ...config };
}

export function clearStore(): void {
  debitLog.clear();
  linesPerStatement.clear();
  faultConfig = {};
}
