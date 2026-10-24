import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as supportRoute from "@/app/api/forms/support/route";
import {
  listSupportSubmissionIds,
  loadSupportSubmission,
} from "@/server/support-form";
import { Storage } from "@/server/storage";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

const validInput = {
  requestId: "33333333-3333-4333-8333-333333333333",
  fullName: "Alex Demo",
  email: "alex@example.com",
  subject: "Payment confirmation issue",
  priority: "High",
  description: "I did not receive a confirmation after the simulated payment.",
  confirmLocalTest: true,
};

function makeRequest(
  body: unknown,
  options: {
    readonly origin?: string | null;
    readonly raw?: string;
    readonly contentType?: string | null;
  } = {},
): Request {
  const headers = new Headers();
  headers.set("host", "127.0.0.1:3000");
  if (options.origin !== null) {
    headers.set("origin", options.origin ?? "http://127.0.0.1:3000");
  }
  if (options.contentType !== null) {
    headers.set("content-type", options.contentType ?? "application/json");
  }
  return new Request("http://127.0.0.1:3000/api/forms/support", {
    method: "POST",
    headers,
    body: options.raw ?? JSON.stringify(body),
  });
}

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-support-route-"));
  tempDirs.push(base);
  process.env.DATA_DIR = join(base, "data");
  process.env.APP_ORIGIN = "http://127.0.0.1:3000";
  process.env.LAB_TEST_MODE = "1";
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  process.env = { ...originalEnv };
});

describe("support form route", () => {
  it("persists exactly one record for a valid same-origin submit", async () => {
    const response = await supportRoute.POST(makeRequest(validInput));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { requestId: string; createdAt: string };
    expect(body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const storage = new Storage(process.env.DATA_DIR ?? "");
    expect(await listSupportSubmissionIds(storage)).toEqual([body.requestId]);
    const record = await loadSupportSubmission(storage, body.requestId);
    expect(record).toMatchObject({
      id: body.requestId,
      fullName: "Alex Demo",
      email: "alex@example.com",
      subject: "Payment confirmation issue",
      priority: "High",
      confirmLocalTest: true,
    });
  });

  it("persists nothing for invalid email or missing confirmation", async () => {
    const invalidEmail = await supportRoute.POST(
      makeRequest({ ...validInput, email: "not-an-email" }),
    );
    expect(invalidEmail.status).toBe(422);
    expect(await invalidEmail.json()).toMatchObject({
      error: { code: "invalid-body" },
    });

    const noConfirm = await supportRoute.POST(
      makeRequest({ ...validInput, confirmLocalTest: false }),
    );
    expect(noConfirm.status).toBe(422);

    const storage = new Storage(process.env.DATA_DIR ?? "");
    expect(await listSupportSubmissionIds(storage)).toEqual([]);
  });

  it("is idempotent for a repeated request ID", async () => {
    const first = await supportRoute.POST(makeRequest(validInput));
    expect(first.status).toBe(201);
    const retry = await supportRoute.POST(makeRequest(validInput));
    expect(retry.status).toBe(201);
    const firstBody = (await first.json()) as { requestId: string };
    const retryBody = (await retry.json()) as { requestId: string };
    expect(retryBody.requestId).toBe(firstBody.requestId);
    const storage = new Storage(process.env.DATA_DIR ?? "");
    expect(await listSupportSubmissionIds(storage)).toEqual([firstBody.requestId]);
  });

  it("enforces the mutation guard, media type, size, and JSON parsing before storage", async () => {
    const crossOrigin = await supportRoute.POST(
      makeRequest(validInput, { origin: "http://evil.example:3000" }),
    );
    expect(crossOrigin.status).toBe(403);

    const noOriginNoToken = await supportRoute.POST(
      makeRequest(validInput, { origin: null }),
    );
    expect(noOriginNoToken.status).toBe(403);

    const wrongType = await supportRoute.POST(
      makeRequest(validInput, { contentType: "text/plain" }),
    );
    expect(wrongType.status).toBe(415);

    const oversized = await supportRoute.POST(
      makeRequest({
        ...validInput,
        description: "x".repeat(70 * 1024),
      }),
    );
    expect(oversized.status).toBe(413);

    const malformed = await supportRoute.POST(
      makeRequest(undefined, { raw: "{not json" }),
    );
    expect(malformed.status).toBe(400);

    const storage = new Storage(process.env.DATA_DIR ?? "");
    expect(await listSupportSubmissionIds(storage)).toEqual([]);
  });
});
