import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().int().default(3000),
  ROLE: z.enum(["api", "worker", "all"]).default("all"),

  DATABASE_URL: z.string(),
  DATABASE_LISTEN_URL: z.string().optional(),

  PSP_A_URL: z.string().default("http://localhost:4001"),
  PSP_B_URL: z.string().default("http://localhost:4002"),
  BANK_URL: z.string().default("http://localhost:4003"),

  WEBHOOK_SECRET_PSP_A: z.string().default("dev-secret-psp-a"),
  WEBHOOK_SECRET_PSP_B: z.string().default("dev-secret-psp-b"),

  PSP_TIMEOUT_MS: z.coerce.number().int().default(3000),
  POLL_BASE_MS: z.coerce.number().int().default(2000),
  POLL_MAX_MS: z.coerce.number().int().default(60000),
  NOT_FOUND_GRACE_MS: z.coerce.number().int().default(30000),
  PAYMENT_DEADLINE_MS: z.coerce.number().int().default(600000),
  SETTLEMENT_WINDOW_MS: z.coerce.number().int().default(300000),
  BANK_WINDOW_MS: z.coerce.number().int().default(300000),
  CSV_POLL_MS: z.coerce.number().int().default(30000),
  SWEEP_MS: z.coerce.number().int().default(15000),
  SUSPECT_WINDOW_MS: z.coerce.number().int().default(120000),
  AUTO_REFUND_DUPLICATES: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  CORS_ORIGIN: z.string().default("*"),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}

function webhookSecretFor(config: Config, psp: "psp_a" | "psp_b"): string {
  return psp === "psp_a" ? config.WEBHOOK_SECRET_PSP_A : config.WEBHOOK_SECRET_PSP_B;
}

function pspUrlFor(config: Config, psp: "psp_a" | "psp_b"): string {
  return psp === "psp_a" ? config.PSP_A_URL : config.PSP_B_URL;
}

export { webhookSecretFor, pspUrlFor };
