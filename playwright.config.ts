import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? "4310");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("E2E_PORT must be an integer from 1 to 65535.");
}

const baseURL = `http://127.0.0.1:${port}`;
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
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
