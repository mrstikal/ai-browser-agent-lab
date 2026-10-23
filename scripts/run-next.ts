import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolveAppConfig } from "../src/server/config";
import { buildNextArgs, nextLaunchTarget, type NextMode } from "./next-args";

const MODES = ["dev", "build", "start"] as const;
type Mode = NextMode;

function isMode(value: string | undefined): value is Mode {
  return value !== undefined && (MODES as readonly string[]).includes(value);
}

const mode = process.argv[2];
if (!isMode(mode)) {
  console.error("Usage: tsx scripts/run-next.ts <dev|build|start>");
  process.exit(1);
}

const config = (() => {
  try {
    return resolveAppConfig(process.env);
  } catch (error) {
    console.error(
      `[ai-browser-agent-lab] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
})();

const nextBin = createRequire(import.meta.url).resolve("next/dist/bin/next");
const args = [nextBin, ...buildNextArgs(mode, config)];

console.log(`[ai-browser-agent-lab] next ${mode}${nextLaunchTarget(mode, config)}`);

const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
});

const forwardSigint = () => child.kill("SIGINT");
const forwardSigterm = () => child.kill("SIGTERM");
process.on("SIGINT", forwardSigint);
process.on("SIGTERM", forwardSigterm);

child.on("error", (error) => {
  console.error(`[ai-browser-agent-lab] Failed to start Next.js: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  process.off("SIGINT", forwardSigint);
  process.off("SIGTERM", forwardSigterm);
  if (signal === "SIGINT") process.exit(130);
  if (signal === "SIGTERM") process.exit(143);
  process.exit(code ?? 1);
});
