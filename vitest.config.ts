import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "apps/*/src/**/*.test.mjs", "tools/**/*.test.mjs"],
    environment: "node",
    // Tests that start real processes can be slow on a busy CI machine. The limit only matters when
    // something is stuck, so it is generous.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
