import { expect, test } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

const projectRoot = process.cwd();

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not determine a free port.")));
        return;
      }
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

test("a second server on the same DATA_DIR exits with a lock error", async () => {
  test.skip(
    !existsSync(join(projectRoot, ".next", "BUILD_ID")),
    "requires a production build (npm run build)",
  );
  const dataDir = process.env.DATA_DIR;
  test.skip(!dataDir, "requires the isolated E2E DATA_DIR");
  if (!dataDir) return;

  const port = await freePort();
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/run-next.ts", "start"],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        APP_ORIGIN: `http://127.0.0.1:${port}`,
        DATA_DIR: dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  const capture = (chunk: Buffer | string) => {
    output += chunk.toString();
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);

  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const [code] = await once(child, "exit");
    expect(code).not.toBe(0);
    expect(output).toContain("cannot start");
    expect(output).toContain(".server.lock");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
});


test("health requires the on-disk server lock", async ({ request }) => {
  const dataDir = process.env.DATA_DIR;
  test.skip(!dataDir, "requires the isolated E2E DATA_DIR");
  if (!dataDir) return;

  const lockPath = join(dataDir, ".server.lock");
  const original = await readFile(lockPath, "utf8");
  try {
    expect((await request.get("/api/health")).status()).toBe(200);
    const replaced = {
      ...(JSON.parse(original) as Record<string, unknown>),
      ownerId: "replacement-owner",
    };
    await writeFile(lockPath, `${JSON.stringify(replaced, null, 2)}\n`);

    const response = await request.get("/api/health");
    expect(response.status()).toBe(503);
    expect(await response.json()).toEqual({ ok: false });
  } finally {
    await writeFile(lockPath, original);
  }

  expect((await request.get("/api/health")).status()).toBe(200);
});
