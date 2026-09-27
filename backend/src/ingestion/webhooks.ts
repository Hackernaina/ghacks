import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import { PspId, WebhookPayload } from "@reconcile/shared";
import { type Config, webhookSecretFor } from "../config/index.js";
import { findPaymentId, recordEvidence } from "./evidence-store.js";

export function signatureFor(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifySignature(secret: string, rawBody: string, header: string | string[] | undefined): boolean {
  if (typeof header !== "string") return false;
  const expected = Buffer.from(signatureFor(secret, rawBody), "utf8");
  const given = Buffer.from(header.trim().toLowerCase(), "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Verify, store evidence, notify, 200. No business logic here. */
export function webhookRoutes(deps: { config: Config; pool: pg.Pool }): FastifyPluginAsync {
  return async (app) => {
    // The signature covers the exact bytes sent, so keep the body as a string.
    app.removeContentTypeParser("application/json");
    app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));

    app.post<{ Params: { psp: string } }>("/webhooks/:psp", async (req, reply) => {
      const psp = PspId.safeParse(req.params.psp);
      if (!psp.success) return reply.code(404).send({ error: "UNKNOWN_PSP" });

      const rawBody = typeof req.body === "string" ? req.body : "";
      if (!verifySignature(webhookSecretFor(deps.config, psp.data), rawBody, req.headers["x-signature"])) {
        req.log.warn({ psp: psp.data }, "webhook signature rejected");
        return reply.code(401).send({ error: "INVALID_SIGNATURE" });
      }

      let json: unknown;
      try {
        json = JSON.parse(rawBody);
      } catch {
        return reply.code(400).send({ error: "INVALID_JSON" });
      }
      const parsed = WebhookPayload.safeParse(json);
      if (!parsed.success) return reply.code(400).send({ error: "INVALID_PAYLOAD", issues: parsed.error.issues });

      const { eventId, createdAt, data } = parsed.data;
      try {
        const paymentId = await findPaymentId(deps.pool, data.idempotencyKey, data.pspRef);
        const result = await recordEvidence(deps.pool, {
          source: "WEBHOOK",
          sourceEventId: eventId,
          paymentId,
          psp: psp.data,
          pspRef: data.pspRef,
          idemKey: data.idempotencyKey,
          orderId: data.orderId,
          reportedStatus: data.status,
          amount: data.amount,
          currency: data.currency,
          observedAt: new Date(createdAt),
          raw: parsed.data,
        });
        return { ok: true, duplicate: !result.inserted };
      } catch (err) {
        req.log.error({ err, eventId, psp: psp.data }, "webhook evidence write failed");
        return reply.code(500).send({ error: "STORE_FAILED" });
      }
    });
  };
}
