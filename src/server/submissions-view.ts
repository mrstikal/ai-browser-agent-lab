import {
  listSupportSubmissionIds,
  loadSupportSubmission,
} from "./support-form";
import {
  listInquirySubmissionIds,
  loadInquirySubmission,
} from "./inquiry-form";
import { Storage } from "./storage";

export interface SubmissionListItem {
  readonly kind: "support" | "inquiry";
  readonly id: string;
  readonly createdAt: string;
  readonly fullName: string;
  readonly email: string;
  readonly detail: string;
  readonly productId: string | null;
  readonly inquiryType: string | null;
}

export interface SubmissionsView {
  readonly support: readonly SubmissionListItem[];
  readonly inquiry: readonly SubmissionListItem[];
  readonly corruptSupport: number;
  readonly corruptInquiry: number;
}

function newestFirst(
  left: SubmissionListItem,
  right: SubmissionListItem,
): number {
  return right.createdAt.localeCompare(left.createdAt);
}

export async function listSubmissions(
  storage: Storage,
): Promise<SubmissionsView> {
  const support: SubmissionListItem[] = [];
  let corruptSupport = 0;
  for (const id of await listSupportSubmissionIds(storage)) {
    const record = await loadSupportSubmission(storage, id);
    if (!record) {
      corruptSupport += 1;
      continue;
    }
    support.push({
      kind: "support",
      id: record.id,
      createdAt: record.createdAt,
      fullName: record.fullName,
      email: record.email,
      detail: record.subject,
      productId: null,
      inquiryType: null,
    });
  }

  const inquiry: SubmissionListItem[] = [];
  let corruptInquiry = 0;
  for (const id of await listInquirySubmissionIds(storage)) {
    const record = await loadInquirySubmission(storage, id);
    if (!record) {
      corruptInquiry += 1;
      continue;
    }
    inquiry.push({
      kind: "inquiry",
      id: record.id,
      createdAt: record.createdAt,
      fullName: record.fullName,
      email: record.email,
      detail: record.message,
      productId: record.productId,
      inquiryType: record.inquiryType,
    });
  }

  return {
    support: support.sort(newestFirst),
    inquiry: inquiry.sort(newestFirst),
    corruptSupport,
    corruptInquiry,
  };
}

export async function resetSubmissions(
  storage: Storage,
): Promise<{ readonly support: number; readonly inquiry: number }> {
  let support = 0;
  for (const id of await listSupportSubmissionIds(storage)) {
    if (await storage.deleteFile(["submissions", "support", `${id}.json`])) {
      support += 1;
    }
  }
  let inquiry = 0;
  for (const id of await listInquirySubmissionIds(storage)) {
    if (await storage.deleteFile(["submissions", "inquiry", `${id}.json`])) {
      inquiry += 1;
    }
  }
  return { support, inquiry };
}
