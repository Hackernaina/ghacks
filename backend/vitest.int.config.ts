import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.int.test.ts"],
    hookTimeout: 30000,
    testTimeout: 30000,
  },
});
