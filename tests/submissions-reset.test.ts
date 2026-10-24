import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as resetRoute from "@/app/api/submissions/reset/route";
import { saveSupportSubmission } from "@/server/support-form";
import { saveInquirySubmission, loadInquirySubmission } from "@/server/inquiry-form";
import { loadSupportSubmission } from "@/server/support-form";
import { listSubmissions } from "@/server/submissions-view";
import { createDefaultModelSettings } from "@/server/model-settings";
import { Storage } from "@/server/storage";
import { pngBytes } from "./helpers/image-fixtures";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

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
  return new Request("http://127.0.0.1:3000/api/submissions/reset", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-reset-"));
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

async function seedSubmissions(storage: Storage) {
  const support = await saveSupportSubmission(storage, {
    requestId: "66666666-6666-4666-8666-666666666666",
    fullName: "Alex Demo",
    email: "alex@example.com",
    subject: "Payment confirmation issue",
    priority: "High",
    description: "I did not receive a confirmation after the simulated payment.",
    confirmLocalTest: true,
  });
  const inquiry = await saveInquirySubmission(storage, {
    requestId: "77777777-7777-4777-8777-777777777777",
    fullName: "Alex Demo",
    email: "alex@example.com",
    productId: "P22",
    inquiryType: "Specifications",
    message: "Does this webcam support 1080p video recording?",
  });
  return { support, inquiry };
}

describe("local submissions view and reset", () => {
  it("lists both forms and keeps valid records across a storage reload", async () => {
    const storage = new Storage(process.env.DATA_DIR ?? "");
    const seeded = await seedSubmissions(storage);

    const view = await listSubmissions(new Storage(storage.root));
    expect(view.support).toHaveLength(1);
    expect(view.inquiry).toHaveLength(1);
    expect(view.support[0]).toMatchObject({
      id: seeded.support.id,
      kind: "support",
      detail: "Payment confirmation issue",
    });
    expect(view.inquiry[0]).toMatchObject({
      id: seeded.inquiry.id,
      kind: "inquiry",
      productId: "P22",
      inquiryType: "Specifications",
    });
    expect(
      await loadSupportSubmission(new Storage(storage.root), seeded.support.id),
    ).toBeDefined();
    expect(
      await loadInquirySubmission(new Storage(storage.root), seeded.inquiry.id),
    ).toBeDefined();
  });

  it("counts corrupt submission files instead of silently hiding them", async () => {
    const storage = new Storage(process.env.DATA_DIR ?? "");
    await seedSubmissions(storage);
    await storage.writeFile(
      ["submissions", "inquiry", "bad.json"],
      "{not a record",
    );
    const view = await listSubmissions(storage);
    expect(view.inquiry).toHaveLength(1);
    expect(view.corruptInquiry).toBe(1);
  });

  it("requires confirmation and removes submissions only", async () => {
    const storage = new Storage(process.env.DATA_DIR ?? "");
    const seeded = await seedSubmissions(storage);
    await storage.writeFile(["images", "keep.png"], pngBytes(32, 32));
    await storage.writeFile(["secrets", "openrouter-key"], "sk-or-v1-keep");
    await storage.writeJson(["settings.json"], createDefaultModelSettings());

    const unconfirmed = await resetRoute.POST(makeRequest({ confirm: false }));
    expect(unconfirmed.status).toBe(422);
    expect(await listSubmissions(storage)).toMatchObject({
      support: [{ id: seeded.support.id }],
      inquiry: [{ id: seeded.inquiry.id }],
    });

    const crossOrigin = await resetRoute.POST(
      makeRequest({ confirm: true }, { origin: "http://evil.example:3000" }),
    );
    expect(crossOrigin.status).toBe(403);
    expect((await listSubmissions(storage)).support).toHaveLength(1);

    const response = await resetRoute.POST(makeRequest({ confirm: true }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      removed: { support: 1, inquiry: 1 },
    });
    expect(await listSubmissions(storage)).toMatchObject({
      support: [],
      inquiry: [],
      corruptSupport: 0,
      corruptInquiry: 0,
    });
    expect(
      await storage.readFile(["images", "keep.png"]),
    ).toEqual(pngBytes(32, 32));
    expect(
      await storage.readFile(["secrets", "openrouter-key"]),
    ).toEqual(Buffer.from("sk-or-v1-keep"));
    expect(await storage.readFile(["settings.json"])).toBeDefined();
  });
});
