import {
  inquirySubmissionSchema,
  type InquirySubmissionInput,
} from "../lib/schemas";
import { Storage, StorageExistsError } from "./storage";

export const INQUIRY_SUBMISSIONS_SEGMENTS = [
  "submissions",
  "inquiry",
] as const;
export const INQUIRY_SUBMISSION_VERSION = 1;

export interface InquirySubmissionRecord extends InquirySubmissionInput {
  readonly version: typeof INQUIRY_SUBMISSION_VERSION;
  readonly id: string;
  readonly createdAt: string;
}

export interface SaveInquirySubmissionResult {
  readonly id: string;
  readonly createdAt: string;
  readonly filename: string;
}

export type InquirySubmissionErrorCode = "invalid" | "conflict" | "storage";

export class InquirySubmissionError extends Error {
  readonly code: InquirySubmissionErrorCode;

  constructor(
    message: string,
    code: InquirySubmissionErrorCode = "invalid",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InquirySubmissionError";
    this.code = code;
  }
}

function sameInquiryInput(
  record: InquirySubmissionRecord,
  input: InquirySubmissionInput,
): boolean {
  return (
    record.fullName === input.fullName &&
    record.email === input.email &&
    record.productId === input.productId &&
    record.inquiryType === input.inquiryType &&
    record.message === input.message
  );
}

function submissionSegments(id: string): readonly string[] {
  return [...INQUIRY_SUBMISSIONS_SEGMENTS, `${id}.json`];
}

export async function saveInquirySubmission(
  storage: Storage,
  input: unknown,
  now: Date = new Date(),
): Promise<SaveInquirySubmissionResult> {
  const parsed = inquirySubmissionSchema.safeParse(input);
  if (!parsed.success) {
    throw new InquirySubmissionError(
      "The product inquiry does not match the expected schema.",
      "invalid",
      { cause: parsed.error },
    );
  }

  const id = parsed.data.requestId;
  const existing = await loadInquirySubmission(storage, id);
  if (existing) {
    if (!sameInquiryInput(existing, parsed.data)) {
      throw new InquirySubmissionError(
        "This request ID was already used with different values.",
        "conflict",
      );
    }
    return { id, createdAt: existing.createdAt, filename: `${id}.json` };
  }

  const createdAt = now.toISOString();
  const record: InquirySubmissionRecord = {
    version: INQUIRY_SUBMISSION_VERSION,
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
      const raced = await loadInquirySubmission(storage, id);
      if (raced && sameInquiryInput(raced, parsed.data)) {
        return { id, createdAt: raced.createdAt, filename: `${id}.json` };
      }
      throw new InquirySubmissionError(
        "This request ID was already used with different values.",
        "conflict",
        { cause: error },
      );
    }
    throw new InquirySubmissionError(
      "The product inquiry could not be stored.",
      "storage",
      { cause: error },
    );
  }
  return { id, createdAt, filename: `${id}.json` };
}

export async function loadInquirySubmission(
  storage: Storage,
  id: string,
): Promise<InquirySubmissionRecord | undefined> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
  ) {
    return undefined;
  }
  const raw = await storage.readFile(submissionSegments(id));
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as InquirySubmissionRecord;
    if (parsed.version !== INQUIRY_SUBMISSION_VERSION || parsed.id !== id) {
      return undefined;
    }
    const { version: _version, id: _id, createdAt: _createdAt, ...input } = parsed;
    void _version;
    void _id;
    void _createdAt;
    if (!inquirySubmissionSchema.safeParse(input).success) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function listInquirySubmissionIds(
  storage: Storage,
): Promise<string[]> {
  const names = await storage.listFiles(["submissions", "inquiry"]);
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}
