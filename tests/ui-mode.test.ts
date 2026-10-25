import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as modeRoute from "@/app/api/ui/mode/route";
import {
  activePaidOperation,
  beginPaidOperation,
  resetPaidOperationsForTests,
} from "@/server/paid-operation";
import { Storage } from "@/server/storage";
import {
  UI_MODE_FILE_SEGMENTS,
  UiModeCorruptionError,
  createDefaultUiModeSettings,
  loadUiMode,
  loadUiModeView,
  parseUiModeSettings,
  saveUiMode,
} from "@/server/ui-mode";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-ui-mode-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

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
  return new Request("http://127.0.0.1:3000/api/ui/mode", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  resetPaidOperationsForTests();
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-ui-mode-route-"));
  tempDirs.push(base);
  process.env.DATA_DIR = join(base, "data");
  process.env.APP_ORIGIN = "http://127.0.0.1:3000";
  process.env.LAB_TEST_MODE = "1";
});

afterEach(async () => {
  resetPaidOperationsForTests();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
  process.env = { ...originalEnv };
});

describe("UI mode settings", () => {
  it("defaults to Classic when no file exists", async () => {
    const storage = await makeStorage();
    await expect(loadUiMode(storage)).resolves.toBe("classic");
    const view = await loadUiModeView(storage);
    expect(view).toEqual({ mode: "classic", error: null });
  });

  it("persists Alternate with a version and timestamp", async () => {
    const storage = await makeStorage();
    const saved = await saveUiMode(
      storage,
      "alternate",
      new Date("2026-10-25T12:00:00.000Z"),
    );
    expect(saved).toEqual({
      version: 1,
      mode: "alternate",
      updatedAt: "2026-10-25T12:00:00.000Z",
    });
    await expect(loadUiMode(storage)).resolves.toBe("alternate");
    expect(await storage.readJson(UI_MODE_FILE_SEGMENTS)).toEqual(saved);
  });

  it("rejects malformed settings and degrades the page view to Classic", async () => {
    const storage = await makeStorage();
    await storage.writeJson(UI_MODE_FILE_SEGMENTS, {
      version: 1,
      mode: "fancy",
      updatedAt: "2026-10-25T12:00:00.000Z",
    });

    expect(() =>
      parseUiModeSettings({
        version: 1,
        mode: "fancy",
        updatedAt: "2026-10-25T12:00:00.000Z",
      }),
    ).toThrow(UiModeCorruptionError);
    await expect(loadUiMode(storage)).rejects.toBeInstanceOf(
      UiModeCorruptionError,
    );
    await expect(loadUiModeView(storage)).resolves.toEqual({
      mode: "classic",
      error:
        "Saved layout mode is unreadable; Classic is shown. Inspect data/ui-settings.json.",
    });
  });

  it("creates a valid default record", () => {
    expect(createDefaultUiModeSettings(new Date("2026-10-25T12:00:00.000Z"))).toEqual({
      version: 1,
      mode: "classic",
      updatedAt: "2026-10-25T12:00:00.000Z",
    });
  });
});

describe("UI mode route", () => {
  it("saves a valid mode through the guarded route", async () => {
    const response = await modeRoute.POST(makeRequest({ mode: "alternate" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: "alternate" });
    expect(activePaidOperation()).toBeNull();
    await expect(loadUiMode(new Storage(process.env.DATA_DIR ?? ""))).resolves.toBe(
      "alternate",
    );
  });

  it("rejects an unknown mode without writing", async () => {
    const response = await modeRoute.POST(makeRequest({ mode: "fancy" }));
    expect(response.status).toBe(422);
    const storage = new Storage(process.env.DATA_DIR ?? "");
    await expect(loadUiMode(storage)).resolves.toBe("classic");
    expect(await storage.readJson(UI_MODE_FILE_SEGMENTS)).toBeUndefined();
  });

  it("rejects a different origin", async () => {
    const response = await modeRoute.POST(
      makeRequest({ mode: "alternate" }, { origin: "http://127.0.0.1:3999" }),
    );
    expect(response.status).toBe(403);
  });

  it("refuses to change the mode during an active paid operation", async () => {
    beginPaidOperation("run-1", "agent");
    const response = await modeRoute.POST(makeRequest({ mode: "alternate" }));
    expect(response.status).toBe(409);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("paid-operation-active");
    const storage = new Storage(process.env.DATA_DIR ?? "");
    expect(await storage.readJson(UI_MODE_FILE_SEGMENTS)).toBeUndefined();
  });
});
