import type { FastifyInstance } from "fastify";
import { listenUrlFor, loadConfig } from "./config/index.js";
import { PAYMENT_UPDATED, PgListener } from "./db/notify.js";
import { closePool, getPool } from "./db/pool.js";
import { buildServer } from "./api/server.js";
import { PaymentStreamHub } from "./api/sse.js";
import { logger } from "./logger.js";
import { createPspClient } from "./psp-client/client.js";
import { startWorker, type Worker } from "./worker/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = getPool(config);
  const psp = createPspClient(config);

  let app: FastifyInstance | null = null;
  let apiListener: PgListener | null = null;
  let worker: Worker | null = null;

  if (config.ROLE === "api" || config.ROLE === "all") {
    apiListener = new PgListener(listenUrlFor(config), [PAYMENT_UPDATED]);
    await apiListener.start();
    const hub = new PaymentStreamHub(pool, apiListener);
    app = await buildServer({ config, pool, psp, hub });
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
    logger.info({ port: config.PORT, role: config.ROLE }, "api listening");
  }

  if (config.ROLE === "worker" || config.ROLE === "all") {
    worker = await startWorker({ config, pool, psp });
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    try {
      await worker?.stop();
      await app?.close();
      await apiListener?.stop();
      await closePool();
    } catch (err) {
      logger.error({ err }, "error during shutdown");
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
