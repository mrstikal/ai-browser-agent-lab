import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inquirySubmissionSchema } from "../src/lib/schemas";
import {
  InquirySubmissionError,
  listInquirySubmissionIds,
  loadInquirySubmission,
  saveInquirySubmission,
} from "../src/server/inquiry-form";
import { Storage } from "../src/server/storage";

const tempDirs: string[] = [];

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-inquiry-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

const validInput = {
  requestId: "44444444-4444-4444-8444-444444444444",
  fullName: "Alex Demo",
  email: "alex@example.com",
  productId: "P22",
  inquiryType: "Specifications" as const,
  message: "Does this webcam support 1080p video recording?",
};

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("product inquiry schema", () => {
  it("accepts P22 and trims text fields", () => {
    const parsed = inquirySubmissionSchema.parse({
      ...validInput,
      fullName: "  Alex Demo ",
      email: " alex@example.com ",
      message: "  Does this webcam support 1080p video recording?  ",
    });
    expect(parsed).toMatchObject({
      productId: "P22",
      fullName: "Alex Demo",
      email: "alex@example.com",
      inquiryType: "Specifications",
    });
    expect(parsed.message).toBe(
      "Does this webcam support 1080p video recording?",
    );
  });

  it("rejects unknown products, invalid email, short messages, and extras", () => {
    for (const invalid of [
      { ...validInput, productId: "P99" },
      { ...validInput, productId: "p22" },
      { ...validInput, email: "bad" },
      { ...validInput, message: "short" },
      { ...validInput, inquiryType: "Billing" },
      { ...validInput, extra: true },
    ]) {
      expect(inquirySubmissionSchema.safeParse(invalid).success).toBe(false);
    }
  });
});

describe("inquiry persistence", () => {
  it("writes exactly one private record and is idempotent per request ID", async () => {
    const storage = await makeStorage();
    const saved = await saveInquirySubmission(storage, validInput);
    expect(saved.filename).toBe(`${saved.id}.json`);
    const path = storage.path(["submissions", "inquiry", saved.filename]);
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(raw).toMatchObject({
      version: 1,
      id: saved.id,
      productId: "P22",
      inquiryType: "Specifications",
      fullName: "Alex Demo",
    });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }

    await saveInquirySubmission(storage, validInput);
    expect(await listInquirySubmissionIds(storage)).toEqual([saved.id]);
    expect(await loadInquirySubmission(storage, saved.id)).toMatchObject({
      id: saved.id,
      productId: "P22",
    });

    const restarted = new Storage(storage.root);
    expect(await loadInquirySubmission(restarted, saved.id)).toMatchObject({
      message: validInput.message,
    });
  });

  it("rejects a reused request ID with different values", async () => {
    const storage = await makeStorage();
    await saveInquirySubmission(storage, validInput);
    await expect(
      saveInquirySubmission(storage, {
        ...validInput,
        productId: "P01",
        message: "A different message for the same request id.",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await loadInquirySubmission(storage, validInput.requestId)).toMatchObject({
      productId: "P22",
      message: validInput.message,
    });
  });

  it("survives a real process restart", async () => {
    const storage = await makeStorage();
    const saved = await saveInquirySubmission(storage, validInput);
    const inquiryUrl = new URL("../src/server/inquiry-form.ts", import.meta.url).href;
    const storageUrl = new URL("../src/server/storage.ts", import.meta.url).href;
    const code = `
      import { loadInquirySubmission } from ${JSON.stringify(inquiryUrl)};
      import { Storage } from ${JSON.stringify(storageUrl)};
      const record = await loadInquirySubmission(new Storage(process.env.DATA_DIR), ${JSON.stringify(saved.id)});
      console.log("RECORD " + JSON.stringify(record));
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      {
        cwd: process.cwd(),
        env: { ...process.env, DATA_DIR: storage.root },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    try {
      const output = await new Promise<string>((resolve, reject) => {
        let buffer = "";
        const timer = setTimeout(
          () => reject(new Error(`Timed out: ${buffer}`)),
          15_000,
        );
        child.stdout?.on("data", (chunk) => {
          buffer += chunk.toString();
          const match = /RECORD (\{.*\})/.exec(buffer);
          if (match?.[1]) {
            clearTimeout(timer);
            resolve(match[1]);
          }
        });
        child.once("exit", (exitCode) => {
          clearTimeout(timer);
          reject(new Error(`Child exited ${String(exitCode)}: ${buffer}`));
        });
      });
      expect(JSON.parse(output)).toMatchObject({
        id: saved.id,
        productId: "P22",
        message: validInput.message,
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
  }, 20_000);

  it("persists nothing for an invalid product or malformed input", async () => {
    const storage = await makeStorage();
    await expect(
      saveInquirySubmission(storage, { ...validInput, productId: "P99" }),
    ).rejects.toThrow(InquirySubmissionError);
    await expect(
      saveInquirySubmission(storage, { ...validInput, message: "" }),
    ).rejects.toThrow(InquirySubmissionError);
    expect(await listInquirySubmissionIds(storage)).toEqual([]);
  });
});
