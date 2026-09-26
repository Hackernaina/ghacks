import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 15000, // 15s — fault tests can be slow
    hookTimeout: 5000,
    reporter: "verbose",
  },
});
