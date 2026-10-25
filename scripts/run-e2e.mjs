import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockOpenRouter } from "./mock-openrouter.mjs";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const playwrightBin = join(projectRoot, "node_modules", ".bin", "playwright");

const args = process.argv.slice(2);
const uiModeArg = args.find((arg) => arg.startsWith("--ui-mode="));
const uiMode = uiModeArg?.slice("--ui-mode=".length);
if (uiMode !== undefined && uiMode !== "classic" && uiMode !== "alternate") {
  console.error("--ui-mode must be classic or alternate.");
  process.exit(1);
}
const playwrightArgs = args.filter((arg) => !arg.startsWith("--ui-mode="));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not determine a free loopback port.")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

const port = await freePort();
const dataDir = await mkdtemp(join(tmpdir(), "ai-browser-lab-e2e-data-"));
if (uiMode !== undefined) {
  await writeFile(
    join(dataDir, "ui-settings.json"),
    `${JSON.stringify(
      {
        version: 1,
        mode: uiMode,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  console.log(`[ai-browser-agent-lab] UI mode: ${uiMode}`);
}
// A production build and the dev server share `.next`; a stale `.next/dev`
// after `npm run build` can make Turbopack emit HMR hash-mismatch reloads that
// race deterministic navigations. Reset only the dev cache.
await rm(join(projectRoot, ".next", "dev"), { recursive: true, force: true });
console.log(`[ai-browser-agent-lab] Playwright base URL: http://127.0.0.1:${port}`);
console.log(`[ai-browser-agent-lab] E2E DATA_DIR: ${dataDir}`);

let mock;
try {
  mock = await startMockOpenRouter();
} catch (error) {
  await rm(dataDir, { recursive: true, force: true });
  console.error(
    `[ai-browser-agent-lab] Failed to start the mock OpenRouter: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
}
console.log(`[ai-browser-agent-lab] mock OpenRouter: ${mock.baseUrl}`);

const child = spawn(playwrightBin, ["test", ...playwrightArgs], {
  stdio: "inherit",
  env: {
    ...process.env,
    E2E_PORT: String(port),
    DATA_DIR: dataDir,
    LAB_TEST_MODE: "1",
    OPENROUTER_BASE_URL: mock.baseUrl,
    MOCK_OPENROUTER_KEY: mock.key,
    MOCK_OPENROUTER_ORIGIN: mock.origin,
    MOCK_OPENROUTER_STATS_URL: mock.statsUrl,
    MOCK_OPENROUTER_RESET_URL: mock.resetUrl,
  },
});

const forwardSigint = () => child.kill("SIGINT");
const forwardSigterm = () => child.kill("SIGTERM");
process.on("SIGINT", forwardSigint);
process.on("SIGTERM", forwardSigterm);

let cleanedUp = false;
async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  await mock.close().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
}

child.on("error", async (error) => {
  console.error(`[ai-browser-agent-lab] Failed to start Playwright: ${error.message}`);
  await cleanup();
  process.exit(1);
});

child.on("exit", async (code, signal) => {
  process.off("SIGINT", forwardSigint);
  process.off("SIGTERM", forwardSigterm);
  await cleanup();
  if (signal === "SIGINT") process.exit(130);
  if (signal === "SIGTERM") process.exit(143);
  process.exit(code ?? 1);
});
