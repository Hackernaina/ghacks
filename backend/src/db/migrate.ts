import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { loadConfig } from "../config/index.js";
import { logger } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");
const MIGRATION_LOCK_ID = 727_274_001;

async function ensureMigrationsTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function runMigrations(connectionString: string): Promise<string[]> {
  const pool = new pg.Pool({ connectionString });
  const applied: string[] = [];
  try {
    const client = await pool.connect();
    try {
      // Serializes concurrent runners (e.g. api and worker containers starting together).
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
      await ensureMigrationsTable(client);
      const { rows } = await client.query<{ name: string }>(
        "SELECT name FROM schema_migrations",
      );
      const already = new Set(rows.map((r) => r.name));

      const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();

      for (const file of files) {
        if (already.has(file)) continue;
        const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
        logger.info({ migration: file }, "applying migration");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
          await client.query("COMMIT");
          applied.push(file);
        } catch (err) {
          await client.query("ROLLBACK");
          throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
      client.release();
    }
  } finally {
    await pool.end();
  }
  return applied;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const applied = await runMigrations(config.DATABASE_URL);
  if (applied.length === 0) {
    logger.info("no pending migrations");
  } else {
    logger.info({ applied }, "migrations applied");
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    logger.error({ err }, "migration failed");
    process.exit(1);
  });
}
