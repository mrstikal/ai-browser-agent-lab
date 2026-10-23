import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as startRoute from "@/app/api/images/job/start/route";
import * as stopRoute from "@/app/api/images/job/stop/route";
import {
  loadImageJob,
  saveImageJob,
} from "@/server/image-state";
import {
  admittedImageJobId,
  PAID_JOB_LOCK_SEGMENTS,
  releaseAdmittedImageJob,
  resetAdmittedImageJobsForTests,
} from "@/server/image-job";
import { prepareImageQuote } from "@/server/image-quote";
import { readLockMetadata } from "@/server/lock";
import { DEFAULT_IMAGE_MODEL_ID } from "@/server/model-settings";
import {
  beginPaidOperation,
  endPaidOperation,
  resetPaidOperationsForTests,
} from "@/server/paid-operation";
import {
  deleteOpenRouterKey,
  resetCredentialHolderForTests,
  setOpenRouterKey,
} from "@/server/credentials";
import { Storage } from "@/server/storage";
import { attemptId } from "./helpers/image-fixtures";

const tempDirs: string[] = [];
const servers: Server[] = [];
const requests: Array<{ method: string; path: string }> = [];
let catalogStatus = 200;
const originalEnv = { ...process.env };

async function makeDataDir(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-job-routes-"));
  tempDirs.push(base);
  return join(base, "data");
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function startCatalog(): Promise<string> {
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    requests.push({ method: request.method ?? "", path });
    if (path === "/api/v1/images/models") {
      if (catalogStatus !== 200) {
        json(response, catalogStatus, { error: { message: "provider down" } });
        return;
      }
      json(response, 200, {
        data: [
          {
            id: DEFAULT_IMAGE_MODEL_ID,
            architecture: { output_modalities: ["image"] },
          },
        ],
      });
      return;
    }
    if (path.includes("/images/models/") && path.endsWith("/endpoints")) {
      json(response, 200, {
        id: DEFAULT_IMAGE_MODEL_ID,
        endpoints: [
          {
            provider_slug: "cheap",
            provider_tag: "cheap",
            supported_parameters: {
              resolution: { type: "enum", values: ["768"] },
              aspect_ratio: { type: "enum", values: ["1:1"] },
              output_format: { type: "enum", values: ["png", "jpeg", "webp"] },
              n: { type: "range", min: 1, max: 1 },
            },
            pricing: [
              { billable: "output_image", unit: "image", cost_usd: 0.008, variant: "768" },
            ],
          },
        ],
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

function makeRequest(
  method: string,
  path: string,
  body?: unknown,
  options: { readonly origin?: string | null } = {},
): Request {
  const headers = new Headers();
  headers.set("host", "127.0.0.1:3000");
  if (options.origin !== null) {
    headers.set("origin", options.origin ?? "http://127.0.0.1:3000");
  }
  headers.set("content-type", "application/json");
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://127.0.0.1:3000${path}`, init);
}

async function fingerprint(storage: Storage): Promise<string> {
  const quote = await prepareImageQuote({
    storage,
    apiKey: "sk-or-v1-job-route-key",
  });
  return quote.fingerprint;
}

beforeEach(async () => {
  await resetAdmittedImageJobsForTests();
  resetPaidOperationsForTests();
  resetCredentialHolderForTests();
  requests.length = 0;
  const dataDir = await makeDataDir();
  const baseUrl = await startCatalog();
  process.env.DATA_DIR = dataDir;
  process.env.LAB_TEST_MODE = "1";
  process.env.OPENROUTER_BASE_URL = baseUrl;
  process.env.APP_ORIGIN = "http://127.0.0.1:3000";
  catalogStatus = 200;
  await setOpenRouterKey("sk-or-v1-job-route-key", {
    remember: false,
    env: { DATA_DIR: dataDir },
  });
});

afterEach(async () => {
  await resetAdmittedImageJobsForTests();
  resetPaidOperationsForTests();
  resetCredentialHolderForTests();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  process.env = { ...originalEnv };
});

describe("image job start route", () => {
  it("starts one job, shares duplicates, and never echoes the key", async () => {
    const storage = new Storage(process.env.DATA_DIR ?? "");
    const accepted = await fingerprint(storage);

    const started = await startRoute.POST(
      makeRequest("POST", "/api/images/job/start", {
        confirm: true,
        fingerprint: accepted,
      }),
    );
    expect(started.status).toBe(200);
    const startedBody = (await started.json()) as {
      ok: boolean;
      existing: boolean;
      job: { jobId: string; status: string; quote: { fingerprint: string } };
    };
    expect(startedBody.ok).toBe(true);
    expect(startedBody.existing).toBe(false);
    expect(startedBody.job.status).toBe("queued");
    expect(startedBody.job.quote.fingerprint).toBe(accepted);
    expect(JSON.stringify(startedBody)).not.toContain("sk-or-v1-job-route-key");
    expect(admittedImageJobId(storage)).toBe(startedBody.job.jobId);

    const lock = await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS));
    expect(lock).toMatchObject({
      kind: "paid-job",
      ownerId: startedBody.job.jobId,
    });

    const requestsAfterStart = requests.length;
    const duplicate = await startRoute.POST(
      makeRequest("POST", "/api/images/job/start", {
        confirm: true,
        fingerprint: accepted,
      }),
    );
    expect(duplicate.status).toBe(200);
    const duplicateBody = (await duplicate.json()) as {
      existing: boolean;
      job: { jobId: string };
    };
    expect(duplicateBody.existing).toBe(true);
    expect(duplicateBody.job.jobId).toBe(startedBody.job.jobId);
    expect(requests.length).toBe(requestsAfterStart);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("releases the lock on a stale fingerprint and persists no job", async () => {
    const storage = new Storage(process.env.DATA_DIR ?? "");
    const response = await startRoute.POST(
      makeRequest("POST", "/api/images/job/start", {
        confirm: true,
        fingerprint: "a".repeat(64),
      }),
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: { code: string };
      quote: { fingerprint: string };
    };
    expect(body.error.code).toBe("quote-changed");
    expect(body.quote.fingerprint).not.toBe("a".repeat(64));
    expect(await loadImageJob(storage)).toBeUndefined();
    expect(
      await readLockMetadata(storage.path(PAID_JOB_LOCK_SEGMENTS)),
    ).toBeUndefined();
  });

  it("requires a key and refuses while another paid operation is active", async () => {
    await deleteOpenRouterKey({ env: process.env });
    const noKey = await startRoute.POST(
      makeRequest("POST", "/api/images/job/start", {
        confirm: true,
        fingerprint: "a".repeat(64),
      }),
    );
    expect(noKey.status).toBe(409);
    expect(await noKey.json()).toMatchObject({ error: { code: "key-required" } });

    await setOpenRouterKey("sk-or-v1-job-route-key", {
      remember: false,
      env: process.env,
    });
    beginPaidOperation("agent-run-1", "agent");
    const blocked = await startRoute.POST(
      makeRequest("POST", "/api/images/job/start", {
        confirm: true,
        fingerprint: "a".repeat(64),
      }),
    );
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: { code: "paid-operation-active" },
    });
    endPaidOperation("agent-run-1");
  });

  it("maps active-job, rejected-quote, unavailable, and corrupt-state outcomes", async () => {
    const storage = new Storage(process.env.DATA_DIR ?? "");
    const accepted = await fingerprint(storage);
    const started = await startRoute.POST(
      makeRequest("POST", "/api/images/job/start", {
        confirm: true,
        fingerprint: accepted,
      }),
    );
    expect(started.status).toBe(200);

    const competing = await startRoute.POST(
      makeRequest("POST", "/api/images/job/start", {
        confirm: true,
        fingerprint: "b".repeat(64),
      }),
    );
    expect(competing.status).toBe(409);
    expect(await competing.json()).toMatchObject({
      error: { code: "job-active" },
    });

    await releaseAdmittedImageJob({
      storage,
      jobId: admittedImageJobId(storage) ?? "",
    });
    const releasedJob = await loadImageJob(storage);
    await saveImageJob(storage, {
      ...(releasedJob as NonNullable<typeof releasedJob>),
      status: "failed",
      updatedAt: new Date().toISOString(),
    });
    const rejected = await startRoute.POST(
      makeRequest("POST", "/api/images/job/start", {
        confirm: true,
        fingerprint: "c".repeat(64),
        selection: {
          modelId: "missing/model",
          resolution: "768",
          aspectRatio: "1:1",
          format: "png",
          n: 1,
        },
      }),
    );
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      error: { code: "stale-model" },
    });

    catalogStatus = 500;
    const unavailable = await startRoute.POST(
      makeRequest("POST", "/api/images/job/start", {
        confirm: true,
        fingerprint: "d".repeat(64),
      }),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({
      error: { code: "unavailable" },
    });
    catalogStatus = 200;

    await storage.writeFile(["image-job.json"], "{bad json");
    const corruptStart = await startRoute.POST(
      makeRequest("POST", "/api/images/job/start", {
        confirm: true,
        fingerprint: "e".repeat(64),
      }),
    );
    expect(corruptStart.status).toBe(500);
    expect(await corruptStart.json()).toMatchObject({
      error: { code: "state-corrupt" },
    });

    const corruptStop = await stopRoute.POST(
      makeRequest("POST", "/api/images/job/stop", { jobId: attemptId(806) }),
    );
    expect(corruptStop.status).toBe(500);
    expect(await corruptStop.json()).toMatchObject({
      error: { code: "state-corrupt" },
    });
  });

  it("enforces the mutation guard before admission", async () => {
    const crossOrigin = await startRoute.POST(
      makeRequest(
        "POST",
        "/api/images/job/start",
        { confirm: true, fingerprint: "a".repeat(64) },
        { origin: "http://evil.example:3000" },
      ),
    );
    expect(crossOrigin.status).toBe(403);
    expect(requests).toEqual([]);
  });
});

describe("image job stop route", () => {
  it("applies only the matching active job and is idempotent", async () => {
    const storage = new Storage(process.env.DATA_DIR ?? "");
    const accepted = await fingerprint(storage);
    const started = await startRoute.POST(
      makeRequest("POST", "/api/images/job/start", {
        confirm: true,
        fingerprint: accepted,
      }),
    );
    const jobId = ((await started.json()) as { job: { jobId: string } }).job.jobId;

    const wrong = await stopRoute.POST(
      makeRequest("POST", "/api/images/job/stop", { jobId: attemptId(800) }),
    );
    expect(wrong.status).toBe(200);
    expect(await wrong.json()).toMatchObject({
      applied: false,
      reason: "wrong-job",
    });
    expect((await loadImageJob(storage))?.stopRequest).toBeNull();

    const applied = await stopRoute.POST(
      makeRequest("POST", "/api/images/job/stop", { jobId }),
    );
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      applied: true,
      status: "stopping",
    });

    const duplicate = await stopRoute.POST(
      makeRequest("POST", "/api/images/job/stop", { jobId }),
    );
    expect(await duplicate.json()).toMatchObject({
      applied: false,
      reason: "duplicate",
      status: "stopping",
    });

    expect(await releaseAdmittedImageJob({ storage, jobId })).toBe(true);
    const stored = await loadImageJob(storage);
    await saveImageJob(storage, {
      ...(stored as NonNullable<typeof stored>),
      status: "stopped_by_user",
      updatedAt: new Date().toISOString(),
    });
    const finished = await stopRoute.POST(
      makeRequest("POST", "/api/images/job/stop", { jobId }),
    );
    expect(await finished.json()).toMatchObject({
      applied: false,
      reason: "finished",
      status: "stopped_by_user",
    });
  });

  it("enforces the mutation guard", async () => {
    const response = await stopRoute.POST(
      makeRequest(
        "POST",
        "/api/images/job/stop",
        { jobId: attemptId(801) },
        { origin: "http://evil.example:3000" },
      ),
    );
    expect(response.status).toBe(403);
  });
});
