import { defineConfig } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.E2E_PORT ?? "4310");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("E2E_PORT must be an integer from 1 to 65535.");
}

const baseURL = `http://127.0.0.1:${port}`;
const projectRoot = dirname(fileURLToPath(import.meta.url));
const e2eDataDir = process.env.DATA_DIR;

const channel = process.env.PLAYWRIGHT_CHANNEL?.trim() || "chrome";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    channel,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `APP_ORIGIN=${baseURL} npm run dev`,
    // The mocked agent worker SDK is only honored together with LAB_TEST_MODE
    // and a temporary DATA_DIR; paid agent calls never run in E2E.
    env: {
      ...process.env,
      LAB_TEST_MODE: "1",
      AGENT_WORKER_TEST_SDK: `file://${join(projectRoot, "tests", "fixtures", "fake-agent-worker-sdk.mjs")}`,
      AGENT_WORKER_FAKE_MODE: "success",
      ...(e2eDataDir
        ? { AGENT_WORKER_TEST_MARKERS: join(e2eDataDir, "agent-test-markers") }
        : {}),
    },
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
