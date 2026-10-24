import {
  supportSubmissionSchema,
  type SupportSubmissionInput,
} from "../lib/schemas";
import { Storage, StorageExistsError } from "./storage";

export const SUPPORT_SUBMISSIONS_SEGMENTS = [
  "submissions",
  "support",
] as const;
export const SUPPORT_SUBMISSION_VERSION = 1;

export interface SupportSubmissionRecord extends SupportSubmissionInput {
  readonly version: typeof SUPPORT_SUBMISSION_VERSION;
  readonly id: string;
  readonly createdAt: string;
}

export interface SaveSupportSubmissionResult {
  readonly id: string;
  readonly createdAt: string;
  readonly filename: string;
}

export type SupportSubmissionErrorCode = "invalid" | "conflict" | "storage";

export class SupportSubmissionError extends Error {
  readonly code: SupportSubmissionErrorCode;

  constructor(
    message: string,
    code: SupportSubmissionErrorCode = "invalid",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SupportSubmissionError";
    this.code = code;
  }
}

function sameSupportInput(
  record: SupportSubmissionRecord,
  input: SupportSubmissionInput,
): boolean {
  return (
    record.fullName === input.fullName &&
    record.email === input.email &&
    record.subject === input.subject &&
    record.priority === input.priority &&
    record.description === input.description &&
    record.confirmLocalTest === input.confirmLocalTest
  );
}

function submissionSegments(id: string): readonly string[] {
  return [...SUPPORT_SUBMISSIONS_SEGMENTS, `${id}.json`];
}

/**
 * Validates and persists exactly one local test support record under
 * data/submissions/support/<uuid>.json with atomic 0600 semantics. Invalid
 * input throws before any file is created.
 */
export async function saveSupportSubmission(
  storage: Storage,
  input: unknown,
  now: Date = new Date(),
): Promise<SaveSupportSubmissionResult> {
  const parsed = supportSubmissionSchema.safeParse(input);
  if (!parsed.success) {
    throw new SupportSubmissionError(
      "The support submission does not match the expected schema.",
      "invalid",
      { cause: parsed.error },
    );
  }

  const id = parsed.data.requestId;
  const existing = await loadSupportSubmission(storage, id);
  if (existing) {
    if (!sameSupportInput(existing, parsed.data)) {
      throw new SupportSubmissionError(
        "This request ID was already used with different values.",
        "conflict",
      );
    }
    return { id, createdAt: existing.createdAt, filename: `${id}.json` };
  }
  const createdAt = now.toISOString();
  const record: SupportSubmissionRecord = {
    version: SUPPORT_SUBMISSION_VERSION,
    id,
    createdAt,
    ...parsed.data,
  };

  try {
    await storage.writeFileExclusive(
      submissionSegments(id),
      `${JSON.stringify(record, null, 2)}\n`,
    );
  } catch (error) {
    if (error instanceof StorageExistsError) {
      const raced = await loadSupportSubmission(storage, id);
      if (raced && sameSupportInput(raced, parsed.data)) {
        return { id, createdAt: raced.createdAt, filename: `${id}.json` };
      }
      throw new SupportSubmissionError(
        "This request ID was already used with different values.",
        "conflict",
        { cause: error },
      );
    }
    throw new SupportSubmissionError(
      "The support submission could not be stored.",
      "storage",
      { cause: error },
    );
  }

  return { id, createdAt, filename: `${id}.json` };
}

export async function loadSupportSubmission(
  storage: Storage,
  id: string,
): Promise<SupportSubmissionRecord | undefined> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
  ) {
    return undefined;
  }
  const raw = await storage.readFile(submissionSegments(id));
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as SupportSubmissionRecord;
    if (parsed.version !== SUPPORT_SUBMISSION_VERSION || parsed.id !== id) {
      return undefined;
    }
    const { version: _version, id: _id, createdAt: _createdAt, ...input } = parsed;
    void _version;
    void _id;
    void _createdAt;
    if (!supportSubmissionSchema.safeParse(input).success) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function listSupportSubmissionIds(
  storage: Storage,
): Promise<string[]> {
  const names = await storage.listFiles(["submissions", "support"]);
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}
