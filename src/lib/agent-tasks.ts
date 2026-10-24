import { z } from "zod";

/**
 * Predefined catalog tasks (Phase 30). The agent receives only the task
 * instruction and a neutral answer shape; fixture-derived expected values live
 * in the server-side evaluator and are never sent to the model.
 */

export const AGENT_CATALOG_TASK_IDS = [
  "catalog-cheapest-home",
  "catalog-out-of-stock",
  "catalog-audio-under-70",
] as const;

export const agentCatalogTaskIdSchema = z.enum(AGENT_CATALOG_TASK_IDS);
export type AgentCatalogTaskId = z.infer<typeof agentCatalogTaskIdSchema>;

export interface AgentCatalogTaskPreset {
  readonly id: AgentCatalogTaskId;
  readonly label: string;
  readonly instruction: string;
  readonly answerShape: string;
}

export const AGENT_CATALOG_TASK_PRESETS: readonly AgentCatalogTaskPreset[] =
  Object.freeze([
    {
      id: "catalog-cheapest-home",
      label: "Task 1 · Cheapest available Home product",
      instruction:
        "Find the cheapest currently available product in the Home category. Return its exact name, USD price, and product page URL.",
      answerShape:
        '{"name":"<exact product name>","priceUsd":<integer USD price>,"url":"<product page URL>"}',
    },
    {
      id: "catalog-out-of-stock",
      label: "Task 2 · Out-of-stock products",
      instruction:
        "Inspect the catalog and return the names of all out-of-stock products and their total count.",
      answerShape:
        '{"names":["<exact product name>", ...],"count":<total count>}',
    },
    {
      id: "catalog-audio-under-70",
      label: "Task 3 · Audio products below $70",
      instruction:
        "Find every in-stock Audio product priced below $70; return names and USD prices in ascending price order.",
      answerShape:
        '{"items":[{"name":"<exact product name>","priceUsd":<integer USD price>}, ...]}',
    },
  ]);

export function isAgentCatalogTaskId(
  value: string,
): value is AgentCatalogTaskId {
  return (AGENT_CATALOG_TASK_IDS as readonly string[]).includes(value);
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

export function buildCatalogTaskInstruction(
  origin: string,
  id: AgentCatalogTaskId,
): string {
  const preset = getAgentCatalogTaskPreset(id);
  return [
    `Start at ${origin}/shop and use only the visible local browser UI.`,
    preset.instruction,
    `Return only one JSON object with exactly this shape: ${preset.answerShape}`,
    "Do not add prose, markdown fences, or extra keys.",
  ].join("\n");
}

/** A dashboard request is either a custom task or one known catalog preset. */
export type AgentTaskStartRequest =
  | { readonly presetId: AgentCatalogTaskId }
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

export type CatalogTaskAnswerParse =
  | { readonly ok: true; readonly answer: CatalogTaskAnswer }
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

  switch (presetId) {
    case "catalog-cheapest-home": {
      const parsed = catalogCheapestHomeAnswerSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          reason: `The answer did not match the required JSON shape (${firstIssue(parsed.error)}).`,
        };
      }
      return { ok: true, answer: { presetId, answer: parsed.data } };
    }
    case "catalog-out-of-stock": {
      const parsed = catalogOutOfStockAnswerSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          ok: false,
          reason: `The answer did not match the required JSON shape (${firstIssue(parsed.error)}).`,
        };
      }
      return { ok: true, answer: { presetId, answer: parsed.data } };
    }
    case "catalog-audio-under-70": {
      const parsed = catalogAudioAnswerSchema.safeParse(raw);
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

/** Only insignificant case and whitespace differences are normalized. */
export function normalizeTaskName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
