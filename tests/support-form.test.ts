import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supportSubmissionSchema } from "../src/lib/schemas";
import {
  listSupportSubmissionIds,
  loadSupportSubmission,
  saveSupportSubmission,
  SupportSubmissionError,
} from "../src/server/support-form";
import { listSubmissions } from "../src/server/submissions-view";
import { Storage } from "../src/server/storage";

const tempDirs: string[] = [];

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-support-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

const validInput = {
  requestId: "11111111-1111-4111-8111-111111111111",
  fullName: "Alex Demo",
  email: "alex@example.com",
  subject: "Payment confirmation issue",
  priority: "High" as const,
  description: "I did not receive a confirmation after the simulated payment.",
  confirmLocalTest: true as const,
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("support submission schema", () => {
  it("accepts the documented fields and trims text", () => {
    const parsed = supportSubmissionSchema.parse({
      ...validInput,
      fullName: "  Alex Demo  ",
    });
    expect(parsed.fullName).toBe("Alex Demo");
    expect(parsed.priority).toBe("High");
  });

  it("rejects invalid email, short fields, missing confirmation, and extras", () => {
    for (const invalid of [
      { ...validInput, email: "not-an-email" },
      { ...validInput, fullName: "A" },
      { ...validInput, subject: "ab" },
      { ...validInput, description: "too short" },
      { ...validInput, confirmLocalTest: false },
      { requestId: validInput.requestId, email: validInput.email },
      { ...validInput, extra: "nope" },
    ]) {
      expect(supportSubmissionSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("support submission persistence", () => {
  it("normalizes uppercase request IDs so later reads and retries work", async () => {
    const storage = await makeStorage();
    const uppercase = {
      ...validInput,
      requestId: validInput.requestId.toUpperCase(),
    };
    const saved = await saveSupportSubmission(storage, uppercase);
    expect(saved.id).toBe(validInput.requestId);
    expect(await loadSupportSubmission(storage, saved.id)).toMatchObject({
      id: saved.id,
      requestId: saved.id,
    });
    await expect(saveSupportSubmission(storage, uppercase)).resolves.toMatchObject({
      id: saved.id,
    });
  });

  it("treats a malformed createdAt as corrupt instead of crashing the view", async () => {
    const storage = await makeStorage();
    await storage.writeJson(["submissions", "support", `${validInput.requestId}.json`], {
      version: 1,
      id: validInput.requestId,
      createdAt: 42,
      ...validInput,
    });
    expect(
      await loadSupportSubmission(storage, validInput.requestId),
    ).toBeUndefined();
    const view = await listSubmissions(storage);
    expect(view.corruptSupport).toBe(1);
    expect(view.support).toEqual([]);
  });

  it("writes exactly one private record with a UUID filename", async () => {
    const storage = await makeStorage();
    const saved = await saveSupportSubmission(storage, validInput);

    expect(saved.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(saved.filename).toBe(`${saved.id}.json`);
    const path = storage.path(["submissions", "support", saved.filename]);
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(raw).toMatchObject({
      version: 1,
      id: saved.id,
      fullName: "Alex Demo",
      email: "alex@example.com",
      subject: "Payment confirmation issue",
      priority: "High",
      confirmLocalTest: true,
    });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(
        (await stat(storage.path(["submissions", "support"]))).mode & 0o700,
      ).toBe(0o700);
    }

    expect(await loadSupportSubmission(storage, saved.id)).toMatchObject({
      id: saved.id,
      fullName: "Alex Demo",
    });
    expect(await listSupportSubmissionIds(storage)).toEqual([saved.id]);
  });

  it("creates distinct records for distinct request IDs and is idempotent per ID", async () => {
    const storage = await makeStorage();
    const first = await saveSupportSubmission(storage, validInput);
    const duplicate = await saveSupportSubmission(storage, validInput);
    expect(duplicate.id).toBe(first.id);
    expect(await listSupportSubmissionIds(storage)).toEqual([first.id]);

    const second = await saveSupportSubmission(storage, {
      ...validInput,
      requestId: "22222222-2222-4222-8222-222222222222",
    });
    expect(second.id).not.toBe(first.id);
    expect(await listSupportSubmissionIds(storage)).toEqual(
      [first.id, second.id].sort(),
    );
  });

  it("rejects a reused request ID with different values", async () => {
    const storage = await makeStorage();
    await saveSupportSubmission(storage, validInput);
    await expect(
      saveSupportSubmission(storage, {
        ...validInput,
        subject: "A different subject",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await loadSupportSubmission(storage, validInput.requestId)).toMatchObject({
      subject: validInput.subject,
    });
  });

  it("persists nothing for invalid or unconfirmed input", async () => {
    const storage = await makeStorage();
    await expect(
      saveSupportSubmission(storage, { ...validInput, email: "bad" }),
    ).rejects.toThrow(SupportSubmissionError);
    await expect(
      saveSupportSubmission(storage, { ...validInput, confirmLocalTest: false }),
    ).rejects.toThrow(SupportSubmissionError);
    expect(await listSupportSubmissionIds(storage)).toEqual([]);
    expect(await storage.listFiles(["submissions", "support"])).toEqual([]);
  });
});
