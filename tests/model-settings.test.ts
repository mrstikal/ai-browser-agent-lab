import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelSettingsSchema } from "../src/lib/schemas";
import {
  createDefaultModelSettings,
  DEFAULT_BROWSER_MODEL_ID,
  DEFAULT_IMAGE_MODEL_ID,
  loadModelSettings,
  ModelSettingsCorruptionError,
  saveModelSettings,
  updateBrowserSettings,
  updateImageSettings,
} from "../src/server/model-settings";
import { Storage } from "../src/server/storage";

const tempDirs: string[] = [];

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-settings-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("model settings", () => {
  it("defaults image and browser choices independently", async () => {
    const storage = await makeStorage();
    const settings = await loadModelSettings(storage);
    expect(settings.image).toEqual({
      modelId: DEFAULT_IMAGE_MODEL_ID,
      resolution: "768",
      aspectRatio: "1:1",
      format: "png",
      n: 1,
    });
    expect(settings.browser).toEqual({ modelId: DEFAULT_BROWSER_MODEL_ID });
    expect(DEFAULT_IMAGE_MODEL_ID).toBe("black-forest-labs/flux-3-image-klein");
    expect(DEFAULT_BROWSER_MODEL_ID).toBe("openrouter/openai/gpt-5.6-luna");
  });

  it("round-trips settings in a private settings.json", async () => {
    const storage = await makeStorage();
    await saveModelSettings(storage, createDefaultModelSettings());

    const path = storage.path(["settings.json"]);
    const loaded = await loadModelSettings(storage);
    expect(loaded.image.modelId).toBe(DEFAULT_IMAGE_MODEL_ID);
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(raw).not.toHaveProperty("key");
    expect(JSON.stringify(raw)).not.toContain("sk-or-");
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("migrates a legacy non-OpenRouter browser model on load", async () => {
    const storage = await makeStorage();
    const base = createDefaultModelSettings();
    await storage.writeJson(["settings.json"], {
      ...base,
      browser: { modelId: "openai/gpt-5.6" },
    });
    const loaded = await loadModelSettings(storage);
    expect(loaded.browser.modelId).toBe("openrouter/openai/gpt-5.6");
    const updated = updateBrowserSettings(loaded, {
      modelId: "openrouter/openai/gpt-5.6-luna",
    });
    expect(updated.browser.modelId).toBe("openrouter/openai/gpt-5.6-luna");
  });

  it("updates image and browser choices without touching each other", async () => {
    const base = createDefaultModelSettings();
    const withImage = updateImageSettings(base, {
      modelId: "other/model-v1",
      resolution: "1K",
      aspectRatio: "4:3",
      format: "webp",
      n: 1,
    });
    expect(withImage.browser).toEqual(base.browser);
    expect(withImage.image.modelId).toBe("other/model-v1");

    const withBrowser = updateBrowserSettings(withImage, {
      modelId: "openrouter/openai/advanced:free-1",
    });
    expect(withBrowser.image).toEqual(withImage.image);
    expect(withBrowser.browser.modelId).toBe("openrouter/openai/advanced:free-1");
  });

  it("rejects unbounded or malformed model IDs and image selections", () => {
    const base = createDefaultModelSettings();
    for (const modelId of [
      "flux",
      "a/ b",
      "a//b",
      `a/${"x".repeat(300)}`,
      "a/\u0000b",
      "openai/gpt-5.6",
      "anthropic/claude-sonnet",
      "",
    ]) {
      expect(() =>
        updateBrowserSettings(base, { modelId }),
      ).toThrow(ModelSettingsCorruptionError);
    }
    expect(
      modelSettingsSchema.safeParse({
        ...base,
        browser: { modelId: "openrouter/openai/gpt-5.6-luna" },
      }).success,
    ).toBe(true);

    expect(() =>
      updateImageSettings(base, {
        modelId: DEFAULT_IMAGE_MODEL_ID,
        resolution: "9K" as never,
        aspectRatio: "1:1",
        format: "png",
        n: 1,
      }),
    ).toThrow(ModelSettingsCorruptionError);
  });

  it("never persists a key-like extra field", async () => {
    const storage = await makeStorage();
    const base = createDefaultModelSettings();
    await expect(
      saveModelSettings(storage, {
        ...base,
        key: "sk-or-v1-must-not-be-here",
      } as never),
    ).rejects.toThrow(ModelSettingsCorruptionError);
    expect(await storage.readFile(["settings.json"])).toBeUndefined();
  });

  it("fails closed on malformed settings and leaves the file untouched", async () => {
    const storage = await makeStorage();
    await storage.writeFile(["settings.json"], "{not json");
    const before = await readFile(storage.path(["settings.json"]), "utf8");
    await expect(loadModelSettings(storage)).rejects.toThrow(
      ModelSettingsCorruptionError,
    );
    expect(await readFile(storage.path(["settings.json"]), "utf8")).toBe(before);

    await storage.writeJson(["settings.json"], {
      ...createDefaultModelSettings(),
      key: "sk-or-v1-not-allowed",
    });
    await expect(loadModelSettings(storage)).rejects.toThrow(
      ModelSettingsCorruptionError,
    );
  });
});
