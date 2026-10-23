import { z } from "zod";

export const IMAGE_RESOLUTION_TIERS = ["512", "768", "1K", "1.5K", "2K", "4K"] as const;
export const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
export const MODEL_SETTINGS_VERSION = 1;
export const QUOTE_ATTEMPTS_PER_IMAGE = 3;

/**
 * Bounded model identifier. OpenRouter image IDs use `author/slug` and the
 * browser SDK default uses `openrouter/openai/gpt-5.6-luna`, so 1-3 segments.
 */
export const modelIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)+$/,
    "Model IDs must look like author/slug (letters, digits, . _ : - and /).",
  );

export const imageAspectRatioSchema = z
  .string()
  .trim()
  .min(3)
  .max(16)
  .regex(/^\d{1,2}:\d{1,2}$/, "Aspect ratio must look like 1:1.");

export const imageModelSettingsSchema = z.strictObject({
  modelId: modelIdSchema,
  resolution: z.enum(IMAGE_RESOLUTION_TIERS),
  aspectRatio: imageAspectRatioSchema,
  format: z.enum(IMAGE_OUTPUT_FORMATS),
  n: z.literal(1),
});

export const browserModelSettingsSchema = z.strictObject({
  modelId: modelIdSchema,
});

export const modelSettingsSchema = z.strictObject({
  version: z.literal(MODEL_SETTINGS_VERSION),
  updatedAt: z.iso.datetime(),
  image: imageModelSettingsSchema,
  browser: browserModelSettingsSchema,
});

export type ImageModelSelection = z.infer<typeof imageModelSettingsSchema>;
export type BrowserModelSelection = z.infer<typeof browserModelSettingsSchema>;
export type ModelSettings = z.infer<typeof modelSettingsSchema>;
