import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { migrationsUpToDate } from "../db/migration-status.js";
import { webhookRoutes } from "../ingestion/webhooks.js";
import { logger } from "../logger.js";
import { registerAdminRoutes } from "./admin.js";
import { type ApiDeps, registerOrderRoutes } from "./orders.js";
import { type PaymentStreamHub, registerStreamRoutes } from "./sse.js";

export async function buildServer(deps: ApiDeps & { hub: PaymentStreamHub }): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: logger.level } });
  await app.register(cors, { origin: deps.config.CORS_ORIGIN });

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/readyz", async (_req, reply) => {
    try {
      await deps.pool.query("SELECT 1");
      if (!(await migrationsUpToDate(deps.pool))) {
        return reply.code(503).send({ ok: false, reason: "migrations pending" });
      }
      return { ok: true };
    } catch (err) {
      logger.error({ err }, "readyz check failed");
      return reply.code(503).send({ ok: false, reason: "db unreachable" });
    }
  });

  registerOrderRoutes(app, deps);
  registerStreamRoutes(app, deps.pool, deps.hub);
  registerAdminRoutes(app, deps);
  await app.register(webhookRoutes(deps));

  return app;
}
