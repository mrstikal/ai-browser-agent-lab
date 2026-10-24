import type { Metadata } from "next";
import Link from "next/link";
import { createStorage } from "@/server/storage";
import { listSubmissions, type SubmissionListItem } from "@/server/submissions-view";
import { ResetSubmissionsForm } from "./reset-submissions-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Local submissions",
};

function SubmissionList({
  title,
  items,
}: {
  readonly title: string;
  readonly items: readonly SubmissionListItem[];
}) {
  return (
    <section aria-labelledby={`submissions-${title}`} className="space-y-3">
      <h2 id={`submissions-${title}`} className="text-xl font-semibold">
        {title} ({items.length})
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-slate-600">No local {title.toLowerCase()} records yet.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              data-submission-id={item.id}
              className="space-y-1 rounded border border-slate-200 bg-white p-4 text-sm"
            >
              <p className="font-mono text-xs text-slate-500">{item.id}</p>
              <p className="font-medium">
                {item.fullName} · {item.email}
              </p>
              <p className="text-slate-700">
                {item.kind === "inquiry"
                  ? `${item.productId ?? "?"} · ${item.inquiryType ?? "?"}: ${item.detail}`
                  : item.detail}
              </p>
              <p className="text-xs text-slate-500">{item.createdAt}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function SubmissionsPage() {
  const view = await listSubmissions(createStorage());

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="text-sm font-medium uppercase tracking-wide text-slate-500">
          Local records
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Submissions</h1>
        <p className="max-w-2xl text-slate-600">
          Support and product-inquiry records stored locally. Reset removes only form
          submissions.
        </p>
        <p className="text-sm text-slate-600">
          <Link href="/forms/support" className="underline">
            Support form
          </Link>{" "}
          ·{" "}
          <Link href="/forms/inquiry" className="underline">
            Product inquiry form
          </Link>
        </p>
      </header>

      {view.corruptSupport + view.corruptInquiry > 0 ? (
        <p
          role="alert"
          className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
          {view.corruptSupport + view.corruptInquiry} submission file(s) could not be read
          and are hidden from this view. Inspect <code>data/submissions/</code> manually.
        </p>
      ) : null}
      <SubmissionList title="Support" items={view.support} />
      <SubmissionList title="Inquiry" items={view.inquiry} />
      <ResetSubmissionsForm
        supportCount={view.support.length}
        inquiryCount={view.inquiry.length}
      />
    </div>
  );
}
