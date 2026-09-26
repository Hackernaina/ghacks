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

export function addDebit(entry: DebitEntry): void {
  debitLog.set(entry.bankRef, entry);
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
  faultConfig = {};
}
