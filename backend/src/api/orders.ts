import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { CreateOrderRequest, PayOrderRequest, type PspId } from "@reconcile/shared";
import type { Config } from "../config/index.js";
import { isUuid } from "../db/pool.js";
import { type OrderRow, type PaymentRow, loadPayment, orderView, paymentView } from "../db/rows.js";
import { recordCreateOutcome } from "../ingestion/outbound.js";
import { logger } from "../logger.js";
import type { PspClient } from "../psp-client/client.js";

export interface ApiDeps {
  config: Config;
  pool: pg.Pool;
  psp: PspClient;
}

const DEFAULT_PSP: PspId = "psp_a";

type StartResult = { kind: "not_found" } | { kind: "existing"; payment: PaymentRow } | { kind: "created"; payment: PaymentRow };

/**
 * Commits the CREATED row before any network call, so no webhook can arrive
 * for a payment we don't know about. A second click returns the active payment.
 */
async function startPayment(deps: ApiDeps, orderId: string, psp: PspId): Promise<StartResult> {
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const order = await client.query<OrderRow>("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
    const o = order.rows[0];
    if (!o) {
      await client.query("ROLLBACK");
      return { kind: "not_found" };
    }
    const active = await client.query<PaymentRow>(
      "SELECT * FROM payments WHERE order_id = $1 AND state <> 'FAILED' LIMIT 1",
      [orderId],
    );
    if (active.rows[0]) {
      await client.query("COMMIT");
      return { kind: "existing", payment: active.rows[0] };
    }
    const { rows } = await client.query<{ attempt: number }>(
      "SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM payments WHERE order_id = $1 AND state = 'FAILED'",
      [orderId],
    );
    const attempt = rows[0]!.attempt;
    // next_check_at lets the sweep recover a payment if this process dies before the PSP call.
    const inserted = await client.query<PaymentRow>(
      `INSERT INTO payments
         (order_id, attempt, psp, idem_key, amount, currency, state, deadline_at, next_check_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'CREATED',
               now() + ($7::double precision * interval '1 millisecond'),
               now() + ($8::double precision * interval '1 millisecond'))
       RETURNING *`,
      [
        orderId,
        attempt,
        psp,
        `${orderId}:${attempt}`,
        o.amount,
        o.currency,
        deps.config.PAYMENT_DEADLINE_MS,
        deps.config.PSP_TIMEOUT_MS + deps.config.POLL_BASE_MS,
      ],
    );
    await client.query("COMMIT");
    return { kind: "created", payment: inserted.rows[0]! };
  } catch (err) {
    await client.query("ROLLBACK");
    if ((err as { code?: string }).code === "23505") {
      const again = await deps.pool.query<PaymentRow>(
        "SELECT * FROM payments WHERE order_id = $1 AND state <> 'FAILED' LIMIT 1",
        [orderId],
      );
      if (again.rows[0]) return { kind: "existing", payment: again.rows[0] };
    }
    throw err;
  } finally {
    client.release();
  }
}

async function sendPayment(deps: ApiDeps, payment: PaymentRow, customerId: string): Promise<void> {
  await deps.pool.query(
    "UPDATE payments SET state = 'PENDING', version = version + 1, updated_at = now() WHERE id = $1 AND state = 'CREATED'",
    [payment.id],
  );
  const outcome = await deps.psp.createPayment(payment.psp, payment.idem_key, {
    amount: payment.amount,
    currency: payment.currency,
    orderId: payment.order_id,
    merchantPaymentId: payment.id,
    customerId,
  });
  await recordCreateOutcome(deps.pool, deps.config, payment, outcome, { markUnknownOnFailure: true });
}

export function registerOrderRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.post("/orders", async (req, reply) => {
    const body = CreateOrderRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "INVALID_REQUEST", issues: body.error.issues });
    const { rows } = await deps.pool.query<OrderRow>(
      "INSERT INTO orders (customer_id, amount, currency) VALUES ($1, $2, $3) RETURNING *",
      [body.data.customerId, body.data.amount, body.data.currency],
    );
    return reply.code(201).send(orderView(rows[0]!));
  });

  app.get<{ Params: { orderId: string } }>("/orders/:orderId", async (req, reply) => {
    if (!isUuid(req.params.orderId)) return reply.code(404).send({ error: "NOT_FOUND" });
    const order = await deps.pool.query<OrderRow>("SELECT * FROM orders WHERE id = $1", [req.params.orderId]);
    if (!order.rows[0]) return reply.code(404).send({ error: "NOT_FOUND" });
    const payments = await deps.pool.query<PaymentRow>(
      "SELECT * FROM payments WHERE order_id = $1 ORDER BY attempt",
      [req.params.orderId],
    );
    return { order: orderView(order.rows[0]), payments: payments.rows.map(paymentView) };
  });

  app.post<{ Params: { orderId: string } }>("/orders/:orderId/pay", async (req, reply) => {
    if (!isUuid(req.params.orderId)) return reply.code(404).send({ error: "NOT_FOUND" });
    const body = PayOrderRequest.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "INVALID_REQUEST", issues: body.error.issues });

    const started = await startPayment(deps, req.params.orderId, body.data.psp ?? DEFAULT_PSP);
    if (started.kind === "not_found") return reply.code(404).send({ error: "NOT_FOUND" });
    if (started.kind === "existing") return paymentView(started.payment);

    const customer = await deps.pool.query<{ customer_id: string }>("SELECT customer_id FROM orders WHERE id = $1", [
      started.payment.order_id,
    ]);
    try {
      await sendPayment(deps, started.payment, customer.rows[0]!.customer_id);
    } catch (err) {
      logger.error({ err, paymentId: started.payment.id }, "recording the PSP outcome failed; sweep will recover");
    }
    const view = await loadPayment(deps.pool, started.payment.id);
    return paymentView(view!);
  });

  app.get<{ Params: { id: string } }>("/payments/:id", async (req, reply) => {
    if (!isUuid(req.params.id)) return reply.code(404).send({ error: "NOT_FOUND" });
    const row = await loadPayment(deps.pool, req.params.id);
    if (!row) return reply.code(404).send({ error: "NOT_FOUND" });
    return paymentView(row);
  });
}
