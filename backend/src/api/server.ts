import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type pg from "pg";
import type { Config } from "../config/index.js";
import { logger } from "../logger.js";
import { migrationsUpToDate } from "../db/migration-status.js";

export function buildServer(config: Config, pool: pg.Pool): FastifyInstance {
  const app = Fastify({ logger: { level: logger.level } });

  app.register(cors, { origin: config.CORS_ORIGIN });

  app.get("/healthz", async () => ({ ok: true }));

  app.get("/readyz", async (_req, reply) => {
    try {
      await pool.query("SELECT 1");
      const migrated = await migrationsUpToDate(pool);
      if (!migrated) {
        return reply.code(503).send({ ok: false, reason: "migrations pending" });
      }
      return { ok: true };
    } catch (err) {
      logger.error({ err }, "readyz check failed");
      return reply.code(503).send({ ok: false, reason: "db unreachable" });
    }
  });

  return app;
}
