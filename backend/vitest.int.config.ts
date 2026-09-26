import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.int.test.ts"],
    exclude: ["**/node_modules/**"],
    fileParallelism: false,
    hookTimeout: 30000,
    testTimeout: 30000,
    env: { LOG_LEVEL: "silent" },
  },
});
