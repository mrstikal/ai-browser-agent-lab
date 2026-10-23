import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendStartedAttempt,
  createEmptyImageManifest,
  publishAttempt,
  saveImageManifest,
} from "../src/server/image-state";
import { buildAttemptFilename, validateImageBytes } from "../src/server/image-validation";
import { resetCredentialHolderForTests, setOpenRouterKey } from "../src/server/credentials";
import { resetPaidOperationsForTests } from "../src/server/paid-operation";
import { loadSetupView } from "../src/server/setup-view";
import { Storage } from "../src/server/storage";
import { attemptId, pngBytes } from "./helpers/image-fixtures";
import { PRODUCT_IDS } from "../src/server/image-state";

const tempDirs: string[] = [];

async function makeStorage(): Promise<Storage> {
  const base = await mkdtemp(join(tmpdir(), "ai-browser-lab-setup-view-"));
  tempDirs.push(base);
  return new Storage(join(base, "data"));
}

async function publishImages(storage: Storage, count: number): Promise<void> {
  let manifest = createEmptyImageManifest();
  for (let index = 0; index < count; index += 1) {
    const productId = PRODUCT_IDS[index];
    if (!productId) throw new Error("Missing product fixture.");
    const id = attemptId(100 + index);
    manifest = appendStartedAttempt(manifest, productId, id, {
      startedAt: new Date(Date.now() - 5000),
    });
    const filename = buildAttemptFilename(productId, id, "png");
    const bytes = pngBytes(32, 32);
    await storage.writeFile(["images", filename], bytes);
    manifest = publishAttempt(manifest, productId, id, {
      filename,
      validation: validateImageBytes(bytes, { filename }),
      publishedAt: new Date(),
      finishedAt: new Date(),
    });
  }
  await saveImageManifest(storage, manifest);
}

function envFor(dataDir: string): Record<string, string> {
  return { DATA_DIR: dataDir };
}

function catalogFetch(
  models: readonly string[],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/images/models")) {
      return Response.json({
        data: models.map((id) => ({
          id,
          architecture: { output_modalities: ["image"] },
        })),
      });
    }
    if (url.includes("/images/models/") && url.endsWith("/endpoints")) {
      return Response.json({
        id: "black-forest-labs/flux-3-image-klein",
        endpoints: [
          {
            provider_slug: "cheap",
            provider_tag: "cheap",
            supports_streaming: false,
            allowed_passthrough_parameters: [],
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
    }
    throw new Error(`Unexpected fetch: ${url} ${init?.method ?? "GET"}`);
  }) as typeof fetch;
}

afterEach(async () => {
  resetCredentialHolderForTests();
  resetPaidOperationsForTests();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("setup view", () => {
  it("renders a fresh install with a key-required quote", async () => {
    const storage = await makeStorage();
    const view = await loadSetupView(storage, { env: envFor(storage.root) });
    expect(view.key).toEqual({ keyAvailable: false, source: null, error: null });
    expect(view.setup.status).toBe("not_configured");
    expect(view.quote).toMatchObject({ ok: false, code: "key-required" });
    expect(JSON.stringify(view)).not.toContain("sk-or-");
  });

  it("renders completed images without a key and no quote", async () => {
    const storage = await makeStorage();
    await publishImages(storage, 24);
    const view = await loadSetupView(storage, { env: envFor(storage.root) });
    expect(view.setup.status).toBe("completed");
    expect(view.setup.validImageCount).toBe(24);
    expect(view.quote).toBeNull();
  });

  it("renders partial images as incomplete", async () => {
    const storage = await makeStorage();
    await publishImages(storage, 3);
    const view = await loadSetupView(storage, { env: envFor(storage.root) });
    expect(view.setup.status).toBe("incomplete");
    expect(view.setup.validImageCount).toBe(3);
    expect(view.setup.missingImageIds).toHaveLength(21);
    expect(view.quote).toMatchObject({ ok: false, code: "key-required" });
  });

  it("surfaces malformed settings, image state, and stored keys", async () => {
    const storage = await makeStorage();
    await storage.writeFile(["settings.json"], "{bad");
    const settingsView = await loadSetupView(storage, { env: envFor(storage.root) });
    expect(settingsView.settingsError).toMatch(/unreadable/);
    expect(settingsView.settings.image.modelId).toBe(
      "black-forest-labs/flux-3-image-klein",
    );

    await storage.deleteFile(["settings.json"]);
    await storage.writeFile(["images", "manifest.json"], "{bad");
    const stateView = await loadSetupView(storage, { env: envFor(storage.root) });
    expect(stateView.setupError).toMatch(/unreadable/);
    expect(stateView.quote).toBeNull();

    await storage.deleteFile(["images", "manifest.json"]);
    await storage.writeFile(["secrets", "openrouter-key"], "short");
    resetCredentialHolderForTests();
    const keyView = await loadSetupView(storage, { env: envFor(storage.root) });
    expect(keyView.key.keyAvailable).toBe(false);
    expect(keyView.key.error).toMatch(/unreadable or malformed/);
  });

  it("renders stale-model and unknown-price quote messages", async () => {
    const storage = await makeStorage();
    await setOpenRouterKey("sk-or-v1-view-key", {
      remember: false,
      env: envFor(storage.root),
    });

    const stale = await loadSetupView(storage, {
      env: envFor(storage.root),
      fetchImpl: catalogFetch(["other/model"]),
    });
    expect(stale.quote).toMatchObject({ ok: false, code: "stale-model" });
    if (stale.quote && !stale.quote.ok) {
      expect(stale.quote.message).toMatch(/no longer available/);
    }

    const priced = await loadSetupView(storage, {
      env: envFor(storage.root),
      fetchImpl: catalogFetch(["black-forest-labs/flux-3-image-klein"]),
    });
    expect(priced.quote).toMatchObject({ ok: true });
    if (priced.quote?.ok) {
      expect(priced.quote.quote.baseUsd).toBe("0.192");
      expect(priced.quote.quote.startingBalanceBaseUsd).toBe("1.184");
    }
  });
});
