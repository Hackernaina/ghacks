import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

export async function migrationsUpToDate(pool: pg.Pool): Promise<boolean> {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  const { rows } = await pool.query<{ name: string }>(
    "SELECT name FROM schema_migrations",
  );
  const applied = new Set(rows.map((r) => r.name));
  return files.every((f) => applied.has(f));
}
