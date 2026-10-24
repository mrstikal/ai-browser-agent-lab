import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as inquiryRoute from "@/app/api/forms/inquiry/route";
import {
  listInquirySubmissionIds,
  loadInquirySubmission,
} from "@/server/inquiry-form";
import { Storage } from "@/server/storage";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

const validInput = {
  requestId: "55555555-5555-4555-8555-555555555555",
  fullName: "Alex Demo",
  email: "alex@example.com",
  productId: "P22",
  inquiryType: "Specifications",
  message: "Does this webcam support 1080p video recording?",
};

function makeRequest(
  body: unknown,
  options: { readonly origin?: string | null } = {},
): Request {
  const headers = new Headers();
  headers.set("host", "127.0.0.1:3000");
  if (options.origin !== null) {
    headers.set("origin", options.origin ?? "http://127.0.0.1:3000");
  }
  headers.set("content-type", "application/json");
  return new Request("http://127.0.0.1:3000/api/forms/inquiry", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-inquiry-route-"));
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

describe("inquiry form route", () => {
  it("stores one idempotent record for a valid product inquiry", async () => {
    const first = await inquiryRoute.POST(makeRequest(validInput));
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { requestId: string };
    expect(firstBody.requestId).toBe(validInput.requestId);

    const retry = await inquiryRoute.POST(makeRequest(validInput));
    expect(retry.status).toBe(201);
    expect(await retry.json()).toMatchObject({ requestId: validInput.requestId });

    const storage = new Storage(process.env.DATA_DIR ?? "");
    expect(await listInquirySubmissionIds(storage)).toEqual([
      validInput.requestId,
    ]);
    expect(await loadInquirySubmission(storage, validInput.requestId)).toMatchObject({
      productId: "P22",
      inquiryType: "Specifications",
      message: validInput.message,
    });
  });

  it("rejects a reused request ID with different values", async () => {
    await inquiryRoute.POST(makeRequest(validInput));
    const conflict = await inquiryRoute.POST(
      makeRequest({ ...validInput, productId: "P01" }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "idempotency-conflict" },
    });
    const storage = new Storage(process.env.DATA_DIR ?? "");
    expect(await listInquirySubmissionIds(storage)).toEqual([
      validInput.requestId,
    ]);
    expect(await loadInquirySubmission(storage, validInput.requestId)).toMatchObject({
      productId: "P22",
    });
  });

  it("rejects unknown products and guard violations without storing", async () => {
    const unknown = await inquiryRoute.POST(
      makeRequest({ ...validInput, productId: "P99" }),
    );
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toMatchObject({
      error: { code: "invalid-body" },
    });

    const crossOrigin = await inquiryRoute.POST(
      makeRequest(validInput, { origin: "http://evil.example:3000" }),
    );
    expect(crossOrigin.status).toBe(403);

    const storage = new Storage(process.env.DATA_DIR ?? "");
    expect(await listInquirySubmissionIds(storage)).toEqual([]);
  });
});
