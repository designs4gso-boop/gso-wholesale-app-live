import { defineConfig } from "vitest/config";

// Standalone test config on purpose: the app's vite.config.ts carries the
// React Router plugin, which must not run for pure server-lib unit tests.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
