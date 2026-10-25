import { modelSettingsSchema, type ModelSettings } from "../lib/schemas";
import { Storage, StorageCorruptionError } from "./storage";

export const SETTINGS_SEGMENTS = ["settings.json"] as const;

export const DEFAULT_IMAGE_MODEL_ID = "black-forest-labs/flux-3-image-klein";
export const DEFAULT_BROWSER_MODEL_ID = "openrouter/openai/gpt-5.6-luna";
export const DEFAULT_IMAGE_RESOLUTION = "768";
export const DEFAULT_IMAGE_ASPECT_RATIO = "1:1";
export const DEFAULT_IMAGE_FORMAT = "png";

export class ModelSettingsError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelSettingsError";
  }
}

export class ModelSettingsCorruptionError extends StorageCorruptionError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelSettingsCorruptionError";
  }
}

export function createDefaultModelSettings(now: Date = new Date()): ModelSettings {
  return {
    version: 1,
    updatedAt: now.toISOString(),
    image: {
      modelId: DEFAULT_IMAGE_MODEL_ID,
      resolution: DEFAULT_IMAGE_RESOLUTION,
      aspectRatio: DEFAULT_IMAGE_ASPECT_RATIO,
      format: DEFAULT_IMAGE_FORMAT,
      n: 1,
    },
    browser: {
      modelId: DEFAULT_BROWSER_MODEL_ID,
    },
  };
}

function invalid(message: string, cause?: unknown): never {
  throw new ModelSettingsCorruptionError(`Model settings are invalid: ${message}`, {
    cause,
  });
}

export function parseModelSettings(value: unknown): ModelSettings {
  const result = modelSettingsSchema.safeParse(value);
  if (!result.success) {
    invalid(
      result.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
        .join("; "),
      result.error,
    );
  }
  return result.data;
}

/**
 * Older settings allowed arbitrary browser provider prefixes. Those IDs made
 * the SDK select an ambient provider; migrate them onto the app's OpenRouter
 * account instead of making the whole settings file unreadable.
 */
function migrateLegacyBrowserModel(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const browser = record.browser;
  if (typeof browser !== "object" || browser === null || Array.isArray(browser)) {
    return value;
  }
  const modelId = (browser as Record<string, unknown>).modelId;
  if (typeof modelId !== "string") return value;
  const trimmed = modelId.trim();
  if (trimmed.length === 0 || trimmed.startsWith("openrouter/")) return value;
  return {
    ...record,
    browser: { ...browser, modelId: `openrouter/${trimmed}` },
  };
}

export async function loadModelSettings(
  storage: Storage,
): Promise<ModelSettings> {
  let raw: unknown;
  try {
    raw = await storage.readJson<unknown>(SETTINGS_SEGMENTS);
  } catch (error) {
    if (error instanceof StorageCorruptionError) {
      throw new ModelSettingsCorruptionError(
        "settings.json contains malformed JSON. Inspect it manually; no data was changed.",
        { cause: error },
      );
    }
    throw error;
  }
  if (raw === undefined) return createDefaultModelSettings();
  return parseModelSettings(migrateLegacyBrowserModel(raw));
}

export async function saveModelSettings(
  storage: Storage,
  settings: ModelSettings,
): Promise<void> {
  await storage.writeJson(SETTINGS_SEGMENTS, parseModelSettings(settings));
}

export function updateImageSettings(
  settings: ModelSettings,
  image: ModelSettings["image"],
  now: Date = new Date(),
): ModelSettings {
  const merged: unknown = {
    ...settings,
    updatedAt: now.toISOString(),
    image,
  };
  return parseModelSettings(merged);
}

export function updateBrowserSettings(
  settings: ModelSettings,
  browser: ModelSettings["browser"],
  now: Date = new Date(),
): ModelSettings {
  const merged: unknown = {
    ...settings,
    updatedAt: now.toISOString(),
    browser,
  };
  return parseModelSettings(merged);
}

export function sameImageSelection(
  left: ModelSettings["image"],
  right: ModelSettings["image"],
): boolean {
  return (
    left.modelId === right.modelId &&
    left.resolution === right.resolution &&
    left.aspectRatio === right.aspectRatio &&
    left.format === right.format &&
    left.n === right.n
  );
}
