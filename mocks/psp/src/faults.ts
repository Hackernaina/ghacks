import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { idempotencyStore, type FaultConfig } from "./store.js";

// ---------------------------------------------------------------------------
// Type for the getFaultConfig injected dependency
// ---------------------------------------------------------------------------
type GetFaultConfig = () => FaultConfig;

// ---------------------------------------------------------------------------
// Individual fault handlers
// (each receives request + reply and returns true if the request was dropped)
// ---------------------------------------------------------------------------

/**
 * dropPercent — randomly drop the request with a 503 before the route runs.
 * Returns true if the request was dropped (caller must return immediately).
 */
async function applyDropPercent(
  faults: FaultConfig,
  _req: FastifyRequest,
  reply: FastifyReply
): Promise<boolean> {
  const pct = faults.dropPercent ?? 0;
  if (pct > 0 && Math.random() * 100 < pct) {
    await reply.code(503).send({ error: "dropped" });
    return true;
  }
  return false;
}

/**
 * bypassIdempotency — delete the stored key before the handler runs so it
 * processes the request as if it has never been seen before.
 * Uses the global idempotencyStore singleton directly.
 */
function applyBypassIdempotency(
  faults: FaultConfig,
  req: FastifyRequest
): void {
  if (!faults.bypassIdempotency) return;

  const key = (req.headers["idempotency-key"] as string | undefined)?.trim();
  if (key) {
    idempotencyStore.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Registers a Fastify preHandler hook that applies fault injection logic
 * BEFORE any route handler runs.
 *
 * Faults applied per route:
 *   POST /v1/payments  → dropPercent, bypassIdempotency
 *   GET  /v1/settlements → settlementMismatch (row-drop variant, ~30% of rows)
 *
 * @param fastify        - The Fastify instance to decorate.
 * @param getFaultConfig - Function returning current fault state (from store).
 */
export function applyFaultMiddleware(
  fastify: FastifyInstance,
  getFaultConfig: GetFaultConfig
): void {
  fastify.addHook(
    "preHandler",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const faults = getFaultConfig();

      // ── POST /v1/payments ────────────────────────────────────────────────
      if (req.method === "POST" && req.url === "/v1/payments") {
        // 1. dropPercent — must check first; if dropped, skip everything else
        const dropped = await applyDropPercent(faults, req, reply);
        if (dropped) return;

        // 2. bypassIdempotency — wipe the stored key so handler sees a fresh req
        applyBypassIdempotency(faults, req);
      }

      // ── GET /v1/settlements ──────────────────────────────────────────────
      // settlementMismatch row-drop is handled inside the route handler
      // (because the hook runs before the CSV is built). Nothing extra needed here.
    }
  );
}
