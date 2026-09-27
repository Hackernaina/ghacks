import type { PspPaymentResponse, PspRefundResponse, SettlementLine } from "@reconcile/shared";

export interface FaultConfig {
  dropPercent?: number;
  webhookDelayMs?: number;
  duplicatePercent?: number;
  reorderWebhooks?: boolean;
  settlementMismatch?: boolean;
  bypassIdempotency?: boolean;
  [key: string]: unknown;
}

// In-memory idempotency store: idempotencyKey -> PspPaymentResponse
export const idempotencyStore = new Map<string, PspPaymentResponse>();

// In-memory settlement log: lineKey -> SettlementLine
export const settlementLog = new Map<string, SettlementLine>();

// In-memory refunds: refund Idempotency-Key -> PspRefundResponse
export const refundStore = new Map<string, PspRefundResponse>();

// In-memory fault config
let faultConfig: FaultConfig = {};

export function addPayment(key: string, response: PspPaymentResponse): void {
  idempotencyStore.set(key, response);
}

export function getPayment(key: string): PspPaymentResponse | undefined {
  return idempotencyStore.get(key);
}

export function addSettlement(entry: SettlementLine): void {
  const lineKey = `${entry.batch_id}:${entry.line_no}`;
  settlementLog.set(lineKey, entry);
}

export function getSettlements(since?: string): SettlementLine[] {
  const entries = Array.from(settlementLog.values());
  if (!since) {
    return entries;
  }

  const sinceTime = new Date(since).getTime();
  if (isNaN(sinceTime)) {
    return entries;
  }

  return entries.filter((entry) => {
    const entryTime = new Date(entry.settled_at).getTime();
    return !isNaN(entryTime) && entryTime >= sinceTime;
  });
}

export function getFaultConfig(): FaultConfig {
  return { ...faultConfig };
}

export function setFaultConfig(config: Partial<FaultConfig>): void {
  faultConfig = {
    ...faultConfig,
    ...config,
  };
}

export function clearStore(): void {
  idempotencyStore.clear();
  settlementLog.clear();
  refundStore.clear();
  faultConfig = {};
}
