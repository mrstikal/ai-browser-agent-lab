import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resetCredentialHolderForTests,
  setOpenRouterKey,
} from "../src/server/credentials";
import { generateOneImage } from "../src/server/image-generator";
import { resetPaidOperationsForTests } from "../src/server/paid-operation";
import { Storage } from "../src/server/storage";
import { attemptId, pngBytes } from "./helpers/image-fixtures";
import type { ImageModelSelection } from "../src/lib/schemas";

const tempDirs: string[] = [];
const servers: Server[] = [];
const originalEnv = { ...process.env };
const DUMMY_KEY = "sk-or-v1-security-scan-dummy-key";
const selection: ImageModelSelection = {
  modelId: "black-forest-labs/flux-3-image-klein",
  resolution: "768",
  aspectRatio: "1:1",
  format: "png",
  n: 1,
};

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startMock(): Promise<string> {
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/api/v1/images") {
      json(response, 200, {
        provider: "mock-provider",
        data: [
          {
            b64_json: pngBytes(32, 32).toString("base64"),
            media_type: "image/png",
          },
        ],
        usage: { cost: 0.008 },
      });
      return;
    }
    json(response, 404, { error: { message: "not found" } });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/api/v1`;
}

async function walkFiles(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-security-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

afterEach(async () => {
  resetCredentialHolderForTests();
  resetPaidOperationsForTests();
  process.env = { ...originalEnv };
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("secret and file exclusions", () => {
  it("keeps runtime data, secrets, and local environment files out of Git", async () => {
    const gitignore = await readFile(join(process.cwd(), ".gitignore"), "utf8");
    const lines = gitignore.split(/\r?\n/).map((line) => line.trim());
    for (const pattern of [
      "/data/",
      ".env*",
      "/test-results/",
      "/playwright-report/",
      "/coverage/",
      "/.next/",
      "/node_modules/",
      "/agent-memory",
      "/AGENTS.md",
      "/AI_BROWSER_LAB_IMPLEMENTATION_PLAN_base.md",
    ]) {
      expect(lines).toContain(pattern);
    }

    if (!existsSync(join(process.cwd(), ".git"))) return;
    const tracked = execFileSync("git", ["ls-files", "-z"], {
      cwd: process.cwd(),
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean);
    const forbidden = tracked.filter(
      (file) =>
        file === ".env" ||
        file.startsWith(".env.") ||
        file.startsWith("data/") ||
        file.startsWith("secrets/") ||
        file.startsWith("test-results/") ||
        file.startsWith("playwright-report/") ||
        file.endsWith("/openrouter-key"),
    );
    expect(forbidden).toEqual([]);
  });

  it("persists a remembered key only in the private secret file", async () => {
    const storage = await makeStorage();
    const baseUrl = await startMock();
    const env = {
      LAB_TEST_MODE: "1",
      OPENROUTER_BASE_URL: baseUrl,
      DATA_DIR: storage.root,
    };

    resetCredentialHolderForTests();
    await setOpenRouterKey(DUMMY_KEY, { remember: true, storage });

    const result = await generateOneImage({
      storage,
      productId: "P01",
      prompt: "A red panda astronaut, studio product shot",
      apiKey: DUMMY_KEY,
      selection,
      providerOnly: ["mock-provider"],
      env,
      attemptId: attemptId(900),
    });
    expect(result.status).toBe("succeeded");

    const keyPath = storage.path(["secrets", "openrouter-key"]);
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
    expect((await readFile(keyPath, "utf8")).trim()).toBe(DUMMY_KEY);
    expect(await storage.listFiles(["secrets"])).toEqual(["openrouter-key"]);

    const needle = Buffer.from(DUMMY_KEY);
    const leaked: string[] = [];
    for (const file of await walkFiles(storage.root)) {
      if (file === keyPath) continue;
      if ((await readFile(file)).includes(needle)) leaked.push(file);
    }
    expect(leaked).toEqual([]);
  });
});
