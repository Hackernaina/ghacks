import type { SettlementLine } from "@reconcile/shared";

/**
 * Pays a settled charge out to the merchant's bank (the mock bank's POST /debit),
 * so it appears as a CREDIT on the bank statement feed. BANK_URL="" disables it.
 */
export function payOutToBank(line: SettlementLine): void {
  const bankUrl = process.env.BANK_URL ?? "http://localhost:4003";
  if (!bankUrl) return;
  fetch(`${bankUrl}/debit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount: line.amount, currency: line.currency, psp_ref: line.psp_ref }),
  })
    .then((res) => {
      if (!res.ok) console.warn(`[payout] bank rejected payout for ${line.psp_ref}: ${res.status}`);
    })
    .catch((err) => console.warn(`[payout] bank unreachable for ${line.psp_ref}:`, (err as Error).message));
}
