import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
const PSP_A_URL = process.env.PSP_A_URL ?? "http://localhost:4001";
const PSP_B_URL = process.env.PSP_B_URL ?? "http://localhost:4002";
const BANK_URL = process.env.BANK_URL ?? "http://localhost:4003";

// changeOrigin rewrites the Host header to the target's. Without it a hosted
// target (Render, Fly, any virtual-hosted HTTPS) receives this server's own
// Host, routes the request straight back here, and the loop ends in a 502.
const to = (target: string) => ({ target, changeOrigin: true });
const strip = (prefix: string, target: string) => ({
  ...to(target),
  rewrite: (path: string) => path.slice(prefix.length),
});

// Backend routes (Section 3.4/3.5 of shared/README.md) proxy straight through.
// The /mock-* prefixes proxy to Person A's PSP/bank mocks directly, so the ops
// dashboard's fault-injection panel can reach them in dev without needing CORS
// configured on the mocks. The trailing slash keeps "/mock-b/" from also
// matching "/mock-bank/" (vite matches proxy keys by string prefix).
const proxy = {
  "/orders": to(BACKEND_URL),
  "/payments": to(BACKEND_URL),
  "/admin": to(BACKEND_URL),
  "/webhooks": to(BACKEND_URL),
  "/healthz": to(BACKEND_URL),
  "/readyz": to(BACKEND_URL),
  "/mock-a/": strip("/mock-a", PSP_A_URL),
  "/mock-b/": strip("/mock-b", PSP_B_URL),
  "/mock-bank/": strip("/mock-bank", BANK_URL),
};

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173, proxy, allowedHosts: true },
  preview: { host: true, port: 5173, proxy, allowedHosts: true },
});
