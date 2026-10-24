import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Several suites spawn real child processes (browser/agent workers). On
    // small machines the default worker fan-out starves timing-sensitive tests.
    maxWorkers: 2,
  },
});
