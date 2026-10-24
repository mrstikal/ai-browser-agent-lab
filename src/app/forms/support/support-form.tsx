"use client";

import Link from "next/link";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { SUPPORT_PRIORITIES, supportSubmissionSchema } from "@/lib/schemas";
import { guardedJsonFetch, readErrorMessage } from "@/app/setup/guard-fetch";

interface SupportValues {
  fullName: string;
  email: string;
  subject: string;
  priority: (typeof SUPPORT_PRIORITIES)[number];
  description: string;
}

const EMPTY_VALUES: SupportValues = {
  fullName: "",
  email: "",
  subject: "",
  priority: "Normal",
  description: "",
};

const inputClass =
  "w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none";

type Step = "edit" | "review" | "done";

export function SupportForm() {
  const [values, setValues] = useState<SupportValues>(EMPTY_VALUES);
  const [step, setStep] = useState<Step>("edit");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const [savedRequestId, setSavedRequestId] = useState<string | null>(null);

  function field(name: keyof SupportValues) {
    return {
      id: `support-${name}`,
      name,
      value: values[name],
      "aria-invalid": errors[name] ? true : undefined,
      "aria-describedby": errors[name] ? `support-${name}-error` : undefined,
      onChange: (
        event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
      ) => {
        setValues((current) => ({ ...current, [name]: event.target.value }));
        setErrors((current) => {
          if (!current[name]) return current;
          const next = { ...current };
          delete next[name];
          return next;
        });
      },
    };
  }

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = supportSubmissionSchema.safeParse({
      ...values,
      requestId,
      confirmLocalTest: true,
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path.map(String).join(".");
        if (!next[path]) next[path] = issue.message;
      }
      setErrors(next);
      return;
    }
    const { requestId: _requestId, confirmLocalTest: _confirm, ...normalized } =
      parsed.data;
    void _requestId;
    void _confirm;
    setValues(normalized);
    setErrors({});
    setConfirmed(false);
    setStep("review");
  }

  async function submit() {
    if (!confirmed) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const response = await guardedJsonFetch("/api/forms/support", {
        method: "POST",
        body: { ...values, requestId, confirmLocalTest: true },
      });
      if (!response.ok) {
        setSubmitError(await readErrorMessage(response));
        return;
      }
      const payload = (await response.json()) as { requestId?: unknown };
      if (
        typeof payload.requestId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          payload.requestId,
        )
      ) {
        setSubmitError(
          "The server response was malformed. The record may already exist; reload before retrying.",
        );
        return;
      }
      setSavedRequestId(payload.requestId);
      setStep("done");
    } catch {
      setSubmitError("The support request could not be submitted.");
    } finally {
      setBusy(false);
    }
  }

  if (step === "done" && savedRequestId) {
    return (
      <section
        aria-live="polite"
        className="space-y-4 rounded-lg border border-emerald-300 bg-emerald-50 p-5"
      >
        <h2 className="text-lg font-semibold text-emerald-900">
          Local test request recorded
        </h2>
        <p className="text-sm text-emerald-900">
          Your request ID is{" "}
          <strong data-testid="support-request-id" className="font-mono">
            {savedRequestId}
          </strong>
        </p>
        <p className="text-sm text-emerald-900">
          This is a local test submission stored under{" "}
          <code>data/submissions/support/</code>.
        </p>
        <Link href="/shop" className="font-medium text-emerald-900 underline">
          Back to the shop
        </Link>
      </section>
    );
  }

  if (step === "review") {
    return (
      <section
        aria-live="polite"
        className="space-y-4 rounded-lg border border-slate-200 bg-white p-5"
      >
        <h2 className="text-lg font-semibold">Review your request</h2>
        <dl className="space-y-2 text-sm">
          <div>
            <dt className="font-medium text-slate-500">Full name</dt>
            <dd>{values.fullName}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">Email</dt>
            <dd>{values.email}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">Subject</dt>
            <dd>{values.subject}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">Priority</dt>
            <dd>{values.priority}</dd>
          </div>
          <div>
            <dt className="font-medium text-slate-500">Description</dt>
            <dd className="whitespace-pre-wrap">{values.description}</dd>
          </div>
        </dl>
        <div className="flex items-start gap-2 text-sm">
          <input
            id="support-confirm"
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            disabled={busy}
            className="mt-0.5"
            data-testid="support-confirm-local-test"
          />
          <label htmlFor="support-confirm">
            I confirm this is a local test submission and not a real support request.
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!confirmed || busy}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            data-testid="support-submit"
          >
            {busy ? "Submitting..." : "Submit request"}
          </button>
          <button
            type="button"
            onClick={() => setStep("edit")}
            disabled={busy}
            className="rounded border border-slate-300 px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            Back to edit
          </button>
        </div>
        {submitError ? (
          <p role="alert" className="text-sm text-red-700">
            {submitError}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <form
      onSubmit={review}
      noValidate
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-5"
      data-testid="support-form"
    >
      <div className="space-y-1">
        <label htmlFor="support-fullName" className="block text-sm font-medium">
          Full name
        </label>
        <input {...field("fullName")} autoComplete="name" className={inputClass} />
        {errors.fullName ? (
          <p id="support-fullName-error" role="alert" className="text-sm text-red-700">
            {errors.fullName}
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <label htmlFor="support-email" className="block text-sm font-medium">
          Email
        </label>
        <input {...field("email")} type="email" autoComplete="email" className={inputClass} />
        {errors.email ? (
          <p id="support-email-error" role="alert" className="text-sm text-red-700">
            {errors.email}
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <label htmlFor="support-subject" className="block text-sm font-medium">
          Subject
        </label>
        <input {...field("subject")} className={inputClass} />
        {errors.subject ? (
          <p id="support-subject-error" role="alert" className="text-sm text-red-700">
            {errors.subject}
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <label htmlFor="support-priority" className="block text-sm font-medium">
          Priority
        </label>
        <select {...field("priority")} className={inputClass}>
          {SUPPORT_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {priority}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label htmlFor="support-description" className="block text-sm font-medium">
          Description
        </label>
        <textarea {...field("description")} rows={6} className={inputClass} />
        {errors.description ? (
          <p id="support-description-error" role="alert" className="text-sm text-red-700">
            {errors.description}
          </p>
        ) : null}
      </div>

      <button
        type="submit"
        className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white"
        data-testid="support-review"
      >
        Review request
      </button>
    </form>
  );
}
