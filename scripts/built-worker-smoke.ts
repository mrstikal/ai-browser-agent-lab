import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Deterministic smoke for the built `npm run start` path: the built server
 * resolves and supervises src/worker/agent-runner.ts, the mocked SDK child
 * completes one run, and the key stays out of persisted state and logs.
 * Run `npm run build` first. No provider request is made.
 */

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DUMMY_KEY = "sk-or-v1-built-smoke-dummy-key";
const MODEL_ID = "openrouter/openai/gpt-5.6-luna";
const SERVER_START_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 30_000;

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not determine a free port.")));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isProcessGroupAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

/**
 * `run-next.ts` spawns `next start` as a grandchild. Signalling only the
 * wrapper PID leaves the server orphaned if the wrapper is killed hard, so the
 * smoke runs the wrapper as a process-group leader and terminates the group.
 */
async function stopServer(child: ReturnType<typeof spawn>): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (!(await waitForProcessGroupExit(pid, 0))) {
    signalProcessGroup(pid, "SIGTERM");
    if (!(await waitForProcessGroupExit(pid, 10_000))) {
      signalProcessGroup(pid, "SIGKILL");
      if (!(await waitForProcessGroupExit(pid, 5_000))) {
        throw new Error("The built server process group did not exit.");
      }
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    await Promise.race([once(child, "exit"), sleep(1_000)]).catch(() => undefined);
  }
}

const cleanupState: { child?: ReturnType<typeof spawn>; base?: string } = {};
let cleanupPromise: Promise<void> | null = null;
let signalHandled = false;

function cleanup(): Promise<void> {
  cleanupPromise ??= (async () => {
    try {
      if (cleanupState.child) await stopServer(cleanupState.child);
    } catch (error) {
      console.error(
        `BUILT_SMOKE_CLEANUP_ERROR ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exitCode = 1;
    }
    try {
      if (cleanupState.base) {
        await rm(cleanupState.base, { recursive: true, force: true });
      }
    } catch (error) {
      console.error(
        `BUILT_SMOKE_CLEANUP_ERROR ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      process.exitCode = 1;
    }
  })();
  return cleanupPromise;
}

async function handleSignal(signal: NodeJS.Signals): Promise<void> {
  if (signalHandled) return;
  signalHandled = true;
  await cleanup();
  process.exit(signal === "SIGINT" ? 130 : 143);
}

function installSignalHandlers(): void {
  // Keep listening during cleanup: a second Ctrl+C must not abort the group
  // kill and orphan the server. A forced exit still requires SIGKILL.
  process.on("SIGINT", () => void handleSignal("SIGINT"));
  process.on("SIGTERM", () => void handleSignal("SIGTERM"));
  process.on("SIGHUP", () => void handleSignal("SIGHUP"));
}

function requirePosixProcessGroups(): void {
  if (process.platform === "win32") {
    throw new Error(
      "The built worker smoke requires POSIX process-group cleanup; run it on Linux or WSL.",
    );
  }
}

async function installedSdkVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(
      join(projectRoot, "node_modules", "@browser_use", "pi", "package.json"),
      "utf8",
    ),
  ) as { version?: unknown };
  if (typeof manifest.version !== "string") {
    throw new Error("Could not read the installed @browser_use/pi version.");
  }
  return manifest.version;
}

async function walkFiles(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function filesContaining(
  directory: string,
  needle: string,
  ignorePath: string,
): Promise<string[]> {
  const needleBytes = Buffer.from(needle);
  const matches: string[] = [];
  for (const file of await walkFiles(directory)) {
    if (file === ignorePath) continue;
    const bytes = await readFile(file);
    if (bytes.includes(needleBytes)) matches.push(file);
  }
  return matches;
}

async function waitForHealth(
  origin: string,
  child: ReturnType<typeof spawn>,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`The built server exited before becoming healthy.\n${output()}`);
    }
    try {
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status === 200) {
        const body = (await response.json()) as { app?: unknown };
        if (body.app === "ai-browser-agent-lab") return;
      }
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  throw new Error(`The built server did not become healthy.\n${output()}`);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, `Unexpected status ${response.status} for ${url}`);
  return (await response.json()) as T;
}

async function main(): Promise<void> {
  requirePosixProcessGroups();
  installSignalHandlers();

  if (!existsSync(join(projectRoot, ".next", "BUILD_ID"))) {
    throw new Error("A production build is required. Run `npm run build` first.");
  }

  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-built-smoke-"));
  cleanupState.base = base;
  const dataDir = join(base, "data");
  const markersDir = join(base, "agent-test-markers");
  let child: ReturnType<typeof spawn> | undefined;
  let output = "";

  const capture = (chunk: Buffer | string) => {
    output += chunk.toString();
    if (output.length > 200_000) output = output.slice(-200_000);
  };

  try {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const sdkVersion = await installedSdkVersion();
    await mkdir(join(dataDir, "secrets"), { recursive: true, mode: 0o700 });
    await writeFile(join(dataDir, "secrets", "openrouter-key"), `${DUMMY_KEY}\n`, {
      mode: 0o600,
    });
    await writeFile(
      join(dataDir, "agent-compatibility.json"),
      `${JSON.stringify(
        {
          version: 1,
          modelId: MODEL_ID,
          sdkVersion,
          origin,
          verifiedAt: new Date().toISOString(),
          vision: "unverified",
        },
        null,
        2,
      )}\n`,
    );

    const serverEnv: NodeJS.ProcessEnv = {
      ...process.env,
      APP_ORIGIN: origin,
      DATA_DIR: dataDir,
      LAB_TEST_MODE: "1",
      AGENT_WORKER_TEST_SDK: pathToFileURL(
        join(projectRoot, "tests", "fixtures", "fake-agent-worker-sdk.mjs"),
      ).href,
      AGENT_WORKER_FAKE_MODE: "success",
      AGENT_WORKER_TEST_MARKERS: markersDir,
      NEXT_TELEMETRY_DISABLED: "1",
    };
    delete serverEnv.OPENROUTER_BASE_URL;

    child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/run-next.ts", "start"],
      {
        cwd: projectRoot,
        env: serverEnv,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    cleanupState.child = child;
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    await waitForHealth(origin, child, () => output);

    const status = await fetchJson<{
      activeRunId: string | null;
      gate: { keyAvailable: boolean; verified: boolean; reason: string };
    }>(`${origin}/api/agent/status`);
    assert.equal(status.gate.keyAvailable, true, "The seeded key was not available.");
    assert.equal(status.gate.verified, true, `Agent gate is ${status.gate.reason}.`);
    assert.equal(status.activeRunId, null, "A run was already active.");

    const startedResponse = await fetch(`${origin}/api/agent/runs`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ task: "Read the main heading." }),
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(startedResponse.status, 200, "The built server refused the run.");
    const started = (await startedResponse.json()) as {
      run: { runId: string; status: string; worker: { pid: number; groupId: number } | null };
    };
    assert.equal(started.run.status, "running");
    assert.ok(started.run.worker && started.run.worker.pid > 0, "No worker identity.");
    assert.equal(started.run.worker?.groupId, started.run.worker?.pid);

    const deadline = Date.now() + RUN_TIMEOUT_MS;
    let run:
      | {
          runId: string;
          status: string;
          stopReason: string | null;
          outputText: string | null;
          steps: number | null;
        }
      | undefined;
    let settled = false;
    while (Date.now() < deadline) {
      const snapshot = await fetchJson<{
        activeRunId: string | null;
        runs: Array<{
          runId: string;
          status: string;
          stopReason: string | null;
          outputText: string | null;
          steps: number | null;
        }>;
      }>(`${origin}/api/agent/status`);
      run = snapshot.runs.find((candidate) => candidate.runId === started.run.runId);
      if (run && run.status !== "running" && snapshot.activeRunId === null) {
        settled = true;
        break;
      }
      await sleep(100);
    }
    assert.ok(settled, "The built supervisor never settled the run and its lock.");
    assert.ok(run, "The run never appeared in status.");
    assert.equal(run?.status, "completed");
    assert.equal(run?.stopReason, "completed");
    assert.equal(run?.outputText, '{"heading":"Shop"}');

    const createMarker = JSON.parse(
      await readFile(join(markersDir, "create.json"), "utf8"),
    ) as {
      telemetry?: boolean;
      researchTools?: boolean;
      log?: boolean;
      redactedSecretMatches?: boolean;
      profileDir?: string | null;
      allowedDomains?: string[];
    };
    assert.equal(createMarker.telemetry, false);
    assert.equal(createMarker.researchTools, false);
    assert.equal(createMarker.log, false);
    assert.equal(createMarker.redactedSecretMatches, true);
    assert.ok(
      createMarker.allowedDomains?.includes("127.0.0.1"),
      "The worker did not restrict domains to the local origin.",
    );
    assert.ok(createMarker.profileDir, "The worker did not use a dedicated profile.");
    assert.equal(
      existsSync(createMarker.profileDir),
      false,
      "The disposable browser profile was not removed.",
    );

    const closeMarker = JSON.parse(
      await readFile(join(markersDir, "close.json"), "utf8"),
    ) as { count?: number; profileExistsAtClose?: boolean };
    assert.equal(closeMarker.count, 1);
    assert.equal(closeMarker.profileExistsAtClose, true);

    const keyPath = join(dataDir, "secrets", "openrouter-key");
    assert.equal((await stat(keyPath)).mode & 0o777, 0o600);
    assert.equal((await readFile(keyPath, "utf8")).trim(), DUMMY_KEY);
    assert.deepEqual(await filesContaining(dataDir, DUMMY_KEY, keyPath), []);
    assert.equal(output.includes(DUMMY_KEY), false, "The server log leaked the key.");

    console.log(
      `BUILT_SMOKE_RESULT ${JSON.stringify({
        status: "passed",
        origin,
        runId: started.run.runId,
        workerPid: started.run.worker?.pid,
        sdkVersion,
        sdk: "mocked",
      })}`,
    );
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(
    `BUILT_SMOKE_ERROR ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
