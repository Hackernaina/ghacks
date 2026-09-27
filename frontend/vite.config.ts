import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
const PSP_A_URL = process.env.PSP_A_URL ?? "http://localhost:4001";
const PSP_B_URL = process.env.PSP_B_URL ?? "http://localhost:4002";
const BANK_URL = process.env.BANK_URL ?? "http://localhost:4003";

// Backend routes (Section 3.4/3.5 of shared/README.md) proxy straight through.
// The /mock-* prefixes proxy to Person A's PSP/bank mocks directly, so the ops
// dashboard's fault-injection panel can reach them in dev without needing CORS
// configured on the mocks.
const proxy = {
  "/orders": BACKEND_URL,
  "/payments": BACKEND_URL,
  "/admin": BACKEND_URL,
  "/webhooks": BACKEND_URL,
  "/healthz": BACKEND_URL,
  "/readyz": BACKEND_URL,
  "/mock-a": { target: PSP_A_URL, rewrite: (path: string) => path.replace(/^\/mock-a/, "") },
  "/mock-b": { target: PSP_B_URL, rewrite: (path: string) => path.replace(/^\/mock-b/, "") },
  "/mock-bank": { target: BANK_URL, rewrite: (path: string) => path.replace(/^\/mock-bank/, "") },
};

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173, proxy, allowedHosts: true },
  preview: { host: true, port: 5173, proxy, allowedHosts: true },
});
