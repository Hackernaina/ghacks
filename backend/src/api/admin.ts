import type { FastifyInstance } from "fastify";
import { AdminPaymentsQuery, CaseStatus, ResolveCaseRequest } from "@reconcile/shared";
import { isUuid, withTransaction } from "../db/pool.js";
import {
  type CaseRow,
  type EvidenceRow,
  type LedgerRow,
  type PaymentRow,
  caseView,
  evidenceView,
  ledgerView,
  loadPayment,
  paymentView,
  targetPspRefOf,
} from "../db/rows.js";
import { insertEvidence, notifyEvidence } from "../ingestion/evidence-store.js";
import { issueRefund } from "../ingestion/outbound.js";
import { logger } from "../logger.js";
import { loadStats, runInvariants } from "./admin-queries.js";
import type { ApiDeps } from "./orders.js";

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString("base64url");
}

function decodeCursor(cursor: string): [string, string] | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && isUuid(parsed[1])) return [parsed[0], parsed[1]];
  } catch {
    // An unreadable cursor is a client error, handled by the caller.
  }
  return null;
}

export function registerAdminRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const { pool } = deps;

  app.get("/admin/payments", async (req, reply) => {
    const q = AdminPaymentsQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "INVALID_QUERY", issues: q.error.issues });
    const cursor = q.data.cursor ? decodeCursor(q.data.cursor) : null;
    if (q.data.cursor && !cursor) return reply.code(400).send({ error: "INVALID_CURSOR" });

    const { rows } = await pool.query<PaymentRow & { cursor_ts: string }>(
      `SELECT *, created_at::text AS cursor_ts FROM payments
        WHERE ($1::text IS NULL OR state = $1)
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [q.data.state ?? null, cursor?.[0] ?? null, cursor?.[1] ?? null, q.data.limit + 1],
    );
    const page = rows.slice(0, q.data.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(paymentView),
      nextCursor: rows.length > q.data.limit && last ? encodeCursor(last.cursor_ts, last.id) : null,
    };
  });

  app.get<{ Params: { id: string } }>("/admin/payments/:id", async (req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "NOT_FOUND" });
    // One snapshot, so the state, ledger and cases shown always belong together.
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const payment = await loadPayment(client, req.params.id);
      if (!payment) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "NOT_FOUND" });
      }
      const evidence = await client.query<EvidenceRow>(
        "SELECT * FROM evidence WHERE payment_id = $1 ORDER BY observed_at, source_event_id",
        [payment.id],
      );
      const ledger = await client.query<LedgerRow>(
        "SELECT * FROM ledger_entries WHERE payment_id = $1 ORDER BY created_at, entry_type",
        [payment.id],
      );
      const cases = await client.query<CaseRow>("SELECT * FROM review_cases WHERE payment_id = $1 ORDER BY created_at", [
        payment.id,
      ]);
      await client.query("COMMIT");
      return {
        payment: paymentView(payment),
        evidence: evidence.rows.map(evidenceView),
        ledger: ledger.rows.map(ledgerView),
        cases: cases.rows.map(caseView),
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  app.get<{ Querystring: { status?: string } }>("/admin/review", async (req, reply) => {
    const status = req.query.status === undefined ? null : CaseStatus.safeParse(req.query.status);
    if (status && !status.success) return reply.code(400).send({ error: "INVALID_STATUS" });
    const { rows } = await pool.query<CaseRow>(
      "SELECT * FROM review_cases WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT 500",
      [status?.data ?? null],
    );
    return rows.map(caseView);
  });

  app.post<{ Params: { id: string } }>("/admin/review/:id/resolve", async (req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "NOT_FOUND" });
    const body = ResolveCaseRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_REQUEST", issues: body.error.issues });
    const { resolution, note } = body.data;

    const found = await pool.query<CaseRow>("SELECT * FROM review_cases WHERE id = $1", [req.params.id]);
    const theCase = found.rows[0];
    if (!theCase) return reply.code(404).send({ error: "NOT_FOUND" });
    if (theCase.status !== "OPEN") return reply.code(409).send({ error: "CASE_NOT_OPEN" });
    const payment = theCase.payment_id ? await loadPayment(pool, theCase.payment_id) : null;
    if (resolution !== "DISMISS" && !payment) {
      return reply.code(400).send({ error: "CASE_HAS_NO_PAYMENT", message: "Only DISMISS applies to a case without a payment" });
    }

    // The refund call happens before any transaction; failure leaves the case open to retry.
    if (resolution === "REFUND") {
      const pspRef = targetPspRefOf(theCase) ?? payment!.psp_ref;
      if (!pspRef) return reply.code(400).send({ error: "NO_CHARGE_TO_REFUND" });
      const outcome = await issueRefund(pool, deps.psp, payment!, pspRef);
      if (outcome.kind !== "ok") {
        logger.warn({ caseId: theCase.id, pspRef, outcome }, "refund not confirmed; case left open");
        return reply.code(502).send({ error: "REFUND_NOT_CONFIRMED", outcome: outcome.kind });
      }
    }

    const updated = await withTransaction(pool, async (client) => {
      if (resolution === "MARK_SUCCEEDED" || resolution === "MARK_FAILED") {
        await insertEvidence(client, {
          source: "MANUAL",
          sourceEventId: `manual:${theCase.id}`,
          paymentId: payment!.id,
          psp: payment!.psp,
          pspRef: payment!.psp_ref,
          idemKey: payment!.idem_key,
          orderId: payment!.order_id,
          reportedStatus: resolution === "MARK_SUCCEEDED" ? "SUCCEEDED" : "FAILED",
          amount: null,
          currency: null,
          observedAt: new Date(),
          raw: { caseId: theCase.id, resolution, note: note ?? null },
        });
      }
      const res = await client.query<CaseRow>(
        `UPDATE review_cases SET status = 'RESOLVED', resolution = $2, note = $3, resolved_at = now()
          WHERE id = $1 AND status = 'OPEN' RETURNING *`,
        [theCase.id, resolution, note ?? null],
      );
      if (payment) await notifyEvidence(client, payment.id);
      return res.rows[0];
    });

    if (!updated) return reply.code(409).send({ error: "CASE_NOT_OPEN" });
    logger.info({ caseId: updated.id, resolution, paymentId: updated.payment_id }, "review case resolved");
    return caseView(updated);
  });

  app.get("/admin/invariants", async () => runInvariants(pool));
  app.get("/admin/stats", async () => loadStats(pool));
}
