import type { EvidenceSource } from "@reconcile/shared";

const SOURCE_LABELS: Record<EvidenceSource, string> = {
  MANUAL: "manual decision",
  BANK_STATEMENT: "bank statement",
  SETTLEMENT: "settlement",
  STATUS_QUERY: "status query",
  WEBHOOK: "webhook",
  SYNC_RESPONSE: "sync response",
};

export function sourceLabel(source: EvidenceSource): string {
  return SOURCE_LABELS[source];
}

export function clock(d: Date): string {
  return d.toISOString().slice(11, 19);
}
