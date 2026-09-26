import { createHmac, randomUUID } from "node:crypto";
import type { WebhookPayload, WebhookType } from "@reconcile/shared";
import type { PspPaymentResponse } from "@reconcile/shared";
import { getFaultConfig } from "./store.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Compute HMAC-SHA256 over `rawBody` using `secret`; returns a plain hex string. */
function sign(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempt to deliver `rawBody` to `url` with the correct `X-Signature` header.
 * Retries up to `maxRetries` times with `backoffMs` between attempts on non-2xx.
 */
async function deliverOnce(
  url: string,
  rawBody: string,
  signature: string,
  maxRetries = 3,
  backoffMs = 1000
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature": signature,
        },
        body: rawBody,
      });

      if (res.ok) {
        console.log(`[webhook] delivered to ${url} (attempt ${attempt})`);
        return;
      }

      console.warn(
        `[webhook] non-2xx (${res.status}) from ${url} — attempt ${attempt}/${maxRetries}`
      );
    } catch (err) {
      console.warn(
        `[webhook] network error on attempt ${attempt}/${maxRetries}:`,
        (err as Error).message
      );
    }

    if (attempt < maxRetries) {
      await sleep(backoffMs);
    }
  }

  console.error(`[webhook] giving up after ${maxRetries} attempts to ${url}`);
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface FireWebhookOptions {
  pspId: "psp_a" | "psp_b";
  webhookSecret: string;
  payment: PspPaymentResponse & { orderId: string };
  type?: WebhookType;
}

/**
 * Builds the webhook payload, signs it, and fires it to the backend.
 *
 * Fault flags honoured:
 *   - `webhookDelayMs`   — wait this many ms before the first delivery attempt
 *   - `duplicatePercent` — if Math.random()*100 < duplicatePercent, resend the
 *                          SAME eventId after an additional 2 s
 */
export function fireWebhook(opts: FireWebhookOptions): void {
  const { pspId, webhookSecret, payment, type = "payment.succeeded" } = opts;

  const backendUrl = process.env.BACKEND_URL ?? "http://localhost:3000";
  const targetUrl = `${backendUrl}/webhooks/${pspId}`;

  // Build payload exactly as specified in the README / WebhookPayload schema
  const eventId = `evt_${randomUUID()}`;
  const payload: WebhookPayload = {
    eventId,
    type,
    createdAt: new Date().toISOString(),
    data: {
      pspRef: payment.pspRef,
      idempotencyKey: payment.idempotencyKey,
      orderId: payment.orderId,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status, // ReportedStatus — "SUCCEEDED" | "FAILED" | ...
    },
  };

  // Serialise ONCE — the same string is signed and sent
  const rawBody = JSON.stringify(payload);
  const signature = sign(webhookSecret, rawBody);

  const faults = getFaultConfig();
  const delayMs = faults.webhookDelayMs ?? 0;
  const duplicatePercent = faults.duplicatePercent ?? 0;

  // Fire asynchronously — caller (route handler) does NOT await
  (async () => {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    await deliverOnce(targetUrl, rawBody, signature);

    // Duplicate delivery fault
    if (duplicatePercent > 0 && Math.random() * 100 < duplicatePercent) {
      console.log(
        `[webhook] duplicate fault triggered (${duplicatePercent}%) — resending eventId ${eventId} in 2 s`
      );
      await sleep(2000);
      // Re-sign the SAME rawBody (same eventId) — intentional duplicate
      await deliverOnce(targetUrl, rawBody, signature);
    }
  })().catch((err) => {
    console.error("[webhook] unexpected error:", err);
  });
}
