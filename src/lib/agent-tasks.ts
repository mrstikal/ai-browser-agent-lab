import { z } from "zod";
import { products } from "./products";
import type {
  InquirySubmissionInput,
  SupportSubmissionInput,
} from "./schemas";

/**
 * Predefined tasks (Phases 30-31). The agent receives only the task
 * instruction, the local site URL, and a neutral answer shape. Catalog expected
 * values live in the server-side evaluator and are never sent to the model;
 * form tasks necessarily include the prescribed submission values.
 */

export const AGENT_CATALOG_TASK_IDS = [
  "catalog-cheapest-home",
  "catalog-out-of-stock",
  "catalog-audio-under-70",
] as const;

export const agentCatalogTaskIdSchema = z.enum(AGENT_CATALOG_TASK_IDS);
export type AgentCatalogTaskId = z.infer<typeof agentCatalogTaskIdSchema>;

export const AGENT_FORM_TASK_IDS = [
  "form-support-request",
  "form-product-inquiry",
] as const;

export const agentFormTaskIdSchema = z.enum(AGENT_FORM_TASK_IDS);
export type AgentFormTaskId = z.infer<typeof agentFormTaskIdSchema>;

export const agentFormTaskTypeSchema = z.enum(["support", "inquiry"]);
export type AgentFormTaskType = z.infer<typeof agentFormTaskTypeSchema>;

export const AGENT_TASK_IDS = [
  ...AGENT_CATALOG_TASK_IDS,
  ...AGENT_FORM_TASK_IDS,
] as const;

export const agentPresetTaskIdSchema = z.enum(AGENT_TASK_IDS);
export type AgentPresetTaskId = z.infer<typeof agentPresetTaskIdSchema>;

/** Capture-time bound for a new per-run form-submission ID snapshot. */
export const AGENT_FORM_BASELINE_MAX_IDS = 1_000;
/** Read-time schema bound, kept wider so older records remain readable. */
export const AGENT_FORM_BASELINE_SCHEMA_MAX_IDS = 10_000;

export type AgentSupportFormExpected = Omit<
  SupportSubmissionInput,
  "requestId"
>;
export type AgentInquiryFormExpected = Omit<
  InquirySubmissionInput,
  "requestId"
> & {
  readonly productName: string;
};

export interface AgentTaskPreset {
  readonly id: AgentPresetTaskId;
  readonly label: string;
  readonly instruction: string;
  readonly answerShape: string;
  /** Relative local path where the task starts. */
  readonly startPath: string;
}

export interface AgentCatalogTaskPreset extends AgentTaskPreset {
  readonly id: AgentCatalogTaskId;
}

export type AgentFormTaskPreset =
  | (AgentTaskPreset & {
      readonly id: "form-support-request";
      readonly form: "support";
      readonly expected: AgentSupportFormExpected;
    })
  | (AgentTaskPreset & {
      readonly id: "form-product-inquiry";
      readonly form: "inquiry";
      readonly expected: AgentInquiryFormExpected;
    });

const SUPPORT_FORM_EXPECTED: AgentSupportFormExpected = {
  fullName: "Alex Demo",
  email: "alex@example.com",
  subject: "Payment confirmation issue",
  priority: "High",
  description:
    "I did not receive a confirmation after the simulated payment.",
  confirmLocalTest: true,
};

const clarityWebcam = products.find(
  (product) => product.name === "Clarity Webcam",
);
if (!clarityWebcam) {
  throw new Error("The product fixture is missing Clarity Webcam.");
}

const INQUIRY_FORM_EXPECTED: AgentInquiryFormExpected = {
  fullName: "Alex Demo",
  email: "alex@example.com",
  productId: clarityWebcam.id,
  productName: clarityWebcam.name,
  inquiryType: "Specifications",
  message: "Does this webcam support 1080p video recording?",
};

export const AGENT_CATALOG_TASK_PRESETS: readonly AgentCatalogTaskPreset[] =
  Object.freeze([
    {
      id: "catalog-cheapest-home",
      label: "Task 1 · Cheapest available Home product",
      startPath: "/shop",
      instruction:
        "Find the cheapest currently available product in the Home category. Return its exact name, USD price, and product page URL.",
      answerShape:
        '{"name":"<exact product name>","priceUsd":<integer USD price>,"url":"<product page URL>"}',
    },
    {
      id: "catalog-out-of-stock",
      label: "Task 2 · Out-of-stock products",
      startPath: "/shop",
      instruction:
        "Inspect the catalog and return the names of all out-of-stock products and their total count.",
      answerShape:
        '{"names":["<exact product name>", ...],"count":<total count>}',
    },
    {
      id: "catalog-audio-under-70",
      label: "Task 3 · Audio products below $70",
      startPath: "/shop",
      instruction:
        "Find every in-stock Audio product priced below $70; return names and USD prices in ascending price order.",
      answerShape:
        '{"items":[{"name":"<exact product name>","priceUsd":<integer USD price>}, ...]}',
    },
  ]);

export const AGENT_FORM_TASK_PRESETS: readonly AgentFormTaskPreset[] =
  Object.freeze([
    {
      id: "form-support-request",
      label: "Task 4 · Support request",
      startPath: "/forms/support",
      form: "support",
      expected: SUPPORT_FORM_EXPECTED,
      instruction:
        `Using the support form, submit name ${SUPPORT_FORM_EXPECTED.fullName}, email ${SUPPORT_FORM_EXPECTED.email}, subject '${SUPPORT_FORM_EXPECTED.subject}', priority ${SUPPORT_FORM_EXPECTED.priority}, description '${SUPPORT_FORM_EXPECTED.description}'. Review the details, check the local test submission confirmation, submit, and return the request ID.`,
      answerShape: '{"requestId":"<support request UUID>"}',
    },
    {
      id: "form-product-inquiry",
      label: "Task 5 · Product inquiry",
      startPath: "/shop",
      form: "inquiry",
      expected: INQUIRY_FORM_EXPECTED,
      instruction:
        `Find ${INQUIRY_FORM_EXPECTED.productName} and use its inquiry form. Submit name ${INQUIRY_FORM_EXPECTED.fullName}, email ${INQUIRY_FORM_EXPECTED.email}, product ${INQUIRY_FORM_EXPECTED.productName}, inquiry type ${INQUIRY_FORM_EXPECTED.inquiryType}, and the message '${INQUIRY_FORM_EXPECTED.message}'. Return the confirmation ID.`,
      answerShape: '{"confirmationId":"<inquiry confirmation UUID>"}',
    },
  ]);

export const AGENT_TASK_PRESETS: readonly AgentTaskPreset[] = Object.freeze([
  ...AGENT_CATALOG_TASK_PRESETS,
  ...AGENT_FORM_TASK_PRESETS,
]);

export function isAgentCatalogTaskId(
  value: string,
): value is AgentCatalogTaskId {
  return (AGENT_CATALOG_TASK_IDS as readonly string[]).includes(value);
}

export function isAgentFormTaskId(value: string): value is AgentFormTaskId {
  return (AGENT_FORM_TASK_IDS as readonly string[]).includes(value);
}

export function isAgentPresetTaskId(
  value: string,
): value is AgentPresetTaskId {
  return (AGENT_TASK_IDS as readonly string[]).includes(value);
}

export function getAgentCatalogTaskPreset(
  id: AgentCatalogTaskId,
): AgentCatalogTaskPreset {
  const preset = AGENT_CATALOG_TASK_PRESETS.find(
    (candidate) => candidate.id === id,
  );
  if (!preset) {
    throw new Error(`Unknown catalog task preset: ${id}`);
  }
  return preset;
}

export function getAgentFormTaskPreset(
  id: AgentFormTaskId,
): AgentFormTaskPreset {
  const preset = AGENT_FORM_TASK_PRESETS.find(
    (candidate) => candidate.id === id,
  );
  if (!preset) {
    throw new Error(`Unknown form task preset: ${id}`);
  }
  return preset;
}

export function getAgentTaskPreset(id: AgentPresetTaskId): AgentTaskPreset {
  const preset = AGENT_TASK_PRESETS.find((candidate) => candidate.id === id);
  if (!preset) {
    throw new Error(`Unknown task preset: ${id}`);
  }
  return preset;
}

export function buildPresetTaskInstruction(
  origin: string,
  id: AgentPresetTaskId,
): string {
  const preset = getAgentTaskPreset(id);
  return [
    `Start at ${origin}${preset.startPath} and use only the visible local browser UI.`,
    preset.instruction,
    `Return only one JSON object with exactly this shape: ${preset.answerShape}`,
    "Do not add prose, markdown fences, or extra keys.",
  ].join("\n");
}

export function buildCatalogTaskInstruction(
  origin: string,
  id: AgentCatalogTaskId,
): string {
  return buildPresetTaskInstruction(origin, id);
}

export function buildFormTaskInstruction(
  origin: string,
  id: AgentFormTaskId,
): string {
  return buildPresetTaskInstruction(origin, id);
}

/** A dashboard request is either a custom task or one known preset. */
export type AgentTaskStartRequest =
  | { readonly presetId: AgentPresetTaskId }
  | { readonly task: string };

const answerNameSchema = z.string().trim().min(1).max(200);
const answerPriceSchema = z.number().finite().nonnegative().max(1_000_000);
const answerUrlSchema = z.string().trim().min(1).max(1_000);

export const catalogCheapestHomeAnswerSchema = z.strictObject({
  name: answerNameSchema,
  priceUsd: answerPriceSchema,
  url: answerUrlSchema,
});
export type CatalogCheapestHomeAnswer = z.infer<
  typeof catalogCheapestHomeAnswerSchema
>;

export const catalogOutOfStockAnswerSchema = z.strictObject({
  names: z.array(answerNameSchema).max(50),
  count: z.number().int().min(0).max(50),
});
export type CatalogOutOfStockAnswer = z.infer<
  typeof catalogOutOfStockAnswerSchema
>;

export const catalogAudioAnswerSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        name: answerNameSchema,
        priceUsd: answerPriceSchema,
      }),
    )
    .max(50),
});
export type CatalogAudioAnswer = z.infer<typeof catalogAudioAnswerSchema>;

export const formSupportAnswerSchema = z.strictObject({
  requestId: z.uuid().transform((value) => value.toLowerCase()),
});
export type FormSupportAnswer = z.infer<typeof formSupportAnswerSchema>;

export const formInquiryAnswerSchema = z.strictObject({
  confirmationId: z.uuid().transform((value) => value.toLowerCase()),
});
export type FormInquiryAnswer = z.infer<typeof formInquiryAnswerSchema>;

export type CatalogTaskAnswer =
  | {
      readonly presetId: "catalog-cheapest-home";
      readonly answer: CatalogCheapestHomeAnswer;
    }
  | {
      readonly presetId: "catalog-out-of-stock";
      readonly answer: CatalogOutOfStockAnswer;
    }
  | {
      readonly presetId: "catalog-audio-under-70";
      readonly answer: CatalogAudioAnswer;
    };

export type FormTaskAnswer =
  | {
      readonly presetId: "form-support-request";
      readonly answer: FormSupportAnswer;
    }
  | {
      readonly presetId: "form-product-inquiry";
      readonly answer: FormInquiryAnswer;
    };

export type PresetTaskAnswer = CatalogTaskAnswer | FormTaskAnswer;

export type CatalogTaskAnswerParse =
  | { readonly ok: true; readonly answer: CatalogTaskAnswer }
  | { readonly ok: false; readonly reason: string };

export type FormTaskAnswerParse =
  | { readonly ok: true; readonly answer: FormTaskAnswer }
  | { readonly ok: false; readonly reason: string };

export type PresetTaskAnswerParse =
  | { readonly ok: true; readonly answer: PresetTaskAnswer }
  | { readonly ok: false; readonly reason: string };

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid JSON shape";
  const path =
    issue.path.length > 0 ? issue.path.map(String).join(".") : "answer";
  return `${path}: ${issue.message}`.slice(0, 300);
}

const JSON_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * JSON.parse silently keeps the last value of a duplicated key, which would let
 * an ambiguous answer pass the strict schema. Walk the already parsed document
 * (so syntax is known valid) and reject duplicate keys, including escaped
 * spellings that decode to the same key.
 */
function hasDuplicateJsonKeys(text: string): boolean {
  let index = 0;

  function skipWhitespace(): void {
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
        index += 1;
      } else {
        break;
      }
    }
  }

  function parseString(): string {
    index += 1;
    let value = "";
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        index += 1;
        return value;
      }
      if (char === "\\") {
        const escape = text[index + 1];
        if (escape === "u") {
          const hex = text.slice(index + 2, index + 6);
          value += String.fromCharCode(Number.parseInt(hex, 16));
          index += 6;
        } else {
          value += JSON_ESCAPES[escape ?? ""] ?? escape ?? "";
          index += 2;
        }
        continue;
      }
      value += char ?? "";
      index += 1;
    }
    return value;
  }

  function parseValue(): boolean {
    skipWhitespace();
    const char = text[index];
    if (char === "{") {
      index += 1;
      const keys = new Set<string>();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return false;
      }
      while (index < text.length) {
        skipWhitespace();
        if (text[index] !== '"') return false;
        const key = parseString();
        if (keys.has(key)) return true;
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") return false;
        index += 1;
        if (parseValue()) return true;
        skipWhitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] === "}") {
          index += 1;
          return false;
        }
        return false;
      }
      return false;
    }
    if (char === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return false;
      }
      while (index < text.length) {
        if (parseValue()) return true;
        skipWhitespace();
        if (text[index] === ",") {
          index += 1;
          continue;
        }
        if (text[index] === "]") {
          index += 1;
          return false;
        }
        return false;
      }
      return false;
    }
    if (char === '"') {
      parseString();
      return false;
    }
    while (index < text.length && !/[\s,\]}]/.test(text[index] ?? "")) {
      index += 1;
    }
    return false;
  }

  return parseValue();
}

function parseJsonText(
  outputText: string | null,
): { readonly ok: true; readonly raw: unknown } | { readonly ok: false; readonly reason: string } {
  if (typeof outputText !== "string" || outputText.trim().length === 0) {
    return { ok: false, reason: "The run returned no answer text." };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(outputText);
  } catch {
    return { ok: false, reason: "The answer was not valid JSON." };
  }
  if (hasDuplicateJsonKeys(outputText)) {
    return {
      ok: false,
      reason: "The answer contained duplicate JSON keys and is ambiguous.",
    };
  }
  return { ok: true, raw };
}

/**
 * Strict answer parsing: the model must return one JSON value matching the
 * neutral shape exactly. Markdown fences, prose, extra keys, duplicate keys,
 * and wrong types fail instead of being repaired or guessed. This is the
 * documented fallback for models whose structured-output/schema compatibility
 * is not verified; the server still validates independently of anything the
 * worker accepted.
 */
export function parseCatalogTaskAnswer(
  presetId: AgentCatalogTaskId,
  outputText: string | null,
): CatalogTaskAnswerParse {
  const parsedText = parseJsonText(outputText);
  if (!parsedText.ok) return parsedText;

  switch (presetId) {
    case "catalog-cheapest-home": {
      const parsed = catalogCheapestHomeAnswerSchema.safeParse(parsedText.raw);
      if (!parsed.success) {
        return {
          ok: false,
          reason: `The answer did not match the required JSON shape (${firstIssue(parsed.error)}).`,
        };
      }
      return { ok: true, answer: { presetId, answer: parsed.data } };
    }
    case "catalog-out-of-stock": {
      const parsed = catalogOutOfStockAnswerSchema.safeParse(parsedText.raw);
      if (!parsed.success) {
        return {
          ok: false,
          reason: `The answer did not match the required JSON shape (${firstIssue(parsed.error)}).`,
        };
      }
      return { ok: true, answer: { presetId, answer: parsed.data } };
    }
    case "catalog-audio-under-70": {
      const parsed = catalogAudioAnswerSchema.safeParse(parsedText.raw);
      if (!parsed.success) {
        return {
          ok: false,
          reason: `The answer did not match the required JSON shape (${firstIssue(parsed.error)}).`,
        };
      }
      return { ok: true, answer: { presetId, answer: parsed.data } };
    }
  }
}

export function parseFormTaskAnswer(
  presetId: AgentFormTaskId,
  outputText: string | null,
): FormTaskAnswerParse {
  const parsedText = parseJsonText(outputText);
  if (!parsedText.ok) return parsedText;

  switch (presetId) {
    case "form-support-request": {
      const parsed = formSupportAnswerSchema.safeParse(parsedText.raw);
      if (!parsed.success) {
        return {
          ok: false,
          reason: `The answer did not match the required JSON shape (${firstIssue(parsed.error)}).`,
        };
      }
      return { ok: true, answer: { presetId, answer: parsed.data } };
    }
    case "form-product-inquiry": {
      const parsed = formInquiryAnswerSchema.safeParse(parsedText.raw);
      if (!parsed.success) {
        return {
          ok: false,
          reason: `The answer did not match the required JSON shape (${firstIssue(parsed.error)}).`,
        };
      }
      return { ok: true, answer: { presetId, answer: parsed.data } };
    }
  }
}

export function parsePresetTaskAnswer(
  presetId: AgentPresetTaskId,
  outputText: string | null,
): PresetTaskAnswerParse {
  if (isAgentCatalogTaskId(presetId)) {
    return parseCatalogTaskAnswer(presetId, outputText);
  }
  return parseFormTaskAnswer(presetId, outputText);
}

/** Only insignificant case and whitespace differences are normalized. */
export function normalizeTaskName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
