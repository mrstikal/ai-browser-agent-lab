import { z } from "zod";
import { products } from "./products";

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

/**
 * The Browser Use SDK resolves the first path segment as the inference
 * provider and reads that provider's ambient credentials. Browser runs must
 * stay on the app's OpenRouter account, so only `openrouter/<author>/<slug>`
 * is accepted.
 */
export const browserModelIdSchema = modelIdSchema.refine(
  (value) =>
    value.startsWith("openrouter/") && value.split("/").length >= 3,
  "Browser model IDs must start with openrouter/ and name a model, e.g. openrouter/openai/gpt-5.6-luna.",
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
  modelId: browserModelIdSchema,
});

export const modelSettingsSchema = z.strictObject({
  version: z.literal(MODEL_SETTINGS_VERSION),
  updatedAt: z.iso.datetime(),
  image: imageModelSettingsSchema,
  browser: browserModelSettingsSchema,
});

export const SUPPORT_PRIORITIES = ["Low", "Normal", "High"] as const;

const emailSchema = z.string().trim().max(200).pipe(z.email());

export const supportSubmissionSchema = z.strictObject({
  requestId: z.uuid(),
  fullName: z.string().trim().min(2).max(120),
  email: emailSchema,
  subject: z.string().trim().min(3).max(160),
  priority: z.enum(SUPPORT_PRIORITIES),
  description: z.string().trim().min(10).max(4000),
  confirmLocalTest: z.literal(true),
});

export type SupportSubmissionInput = z.infer<typeof supportSubmissionSchema>;

export const INQUIRY_TYPES = [
  "Availability",
  "Specifications",
  "Other",
] as const;

const productIdValues = products.map((product) => product.id) as [
  string,
  ...string[],
];

export const inquirySubmissionSchema = z.strictObject({
  requestId: z.uuid(),
  fullName: z.string().trim().min(2).max(120),
  email: emailSchema,
  productId: z.enum(productIdValues),
  inquiryType: z.enum(INQUIRY_TYPES),
  message: z.string().trim().min(10).max(4000),
});

export type InquirySubmissionInput = z.infer<typeof inquirySubmissionSchema>;

export type ImageModelSelection = z.infer<typeof imageModelSettingsSchema>;
export type BrowserModelSelection = z.infer<typeof browserModelSettingsSchema>;
export type ModelSettings = z.infer<typeof modelSettingsSchema>;
