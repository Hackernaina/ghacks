import { loadConfig } from "./config/index.js";
import { getPool, closePool } from "./db/pool.js";
import { buildServer } from "./api/server.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = getPool(config);

  if (config.ROLE === "api" || config.ROLE === "all") {
    const app = buildServer(config, pool);
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
    logger.info({ port: config.PORT, role: config.ROLE }, "api listening");
  }

  if (config.ROLE === "worker" || config.ROLE === "all") {
    logger.info("worker role starting (no-op until Phase 3)");
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logger.info({ signal }, "shutting down");
      closePool().finally(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
