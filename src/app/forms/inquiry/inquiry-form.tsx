"use client";

import Link from "next/link";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { INQUIRY_TYPES, inquirySubmissionSchema } from "@/lib/schemas";
import { products } from "@/lib/products";
import { guardedJsonFetch, readErrorMessage } from "@/app/setup/guard-fetch";

interface InquiryValues {
  fullName: string;
  email: string;
  productId: string;
  inquiryType: (typeof INQUIRY_TYPES)[number];
  message: string;
}

const emptyValues = (productId: string): InquiryValues => ({
  fullName: "",
  email: "",
  productId,
  inquiryType: "Specifications",
  message: "",
});

const inputClass =
  "w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none";

export function InquiryForm({ initialProductId }: { initialProductId: string }) {
  const [values, setValues] = useState<InquiryValues>(() =>
    emptyValues(initialProductId),
  );
  const [requestId] = useState(() => crypto.randomUUID());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [savedRequestId, setSavedRequestId] = useState<string | null>(null);

  function field(name: keyof InquiryValues) {
    return {
      id: `inquiry-${name}`,
      name,
      value: values[name],
      "aria-invalid": errors[name] ? true : undefined,
      "aria-describedby": errors[name] ? `inquiry-${name}-error` : undefined,
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

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = inquirySubmissionSchema.safeParse({ ...values, requestId });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path.map(String).join(".");
        if (!next[path]) next[path] = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    setSubmitError(null);
    try {
      const { requestId: id, ...input } = parsed.data;
      const response = await guardedJsonFetch("/api/forms/inquiry", {
        method: "POST",
        body: { ...input, requestId: id },
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
    } catch {
      setSubmitError("The product inquiry could not be submitted.");
    } finally {
      setBusy(false);
    }
  }

  if (savedRequestId) {
    return (
      <section
        aria-live="polite"
        className="space-y-4 rounded-lg border border-emerald-300 bg-emerald-50 p-5"
      >
        <h2 className="text-lg font-semibold text-emerald-900">
          Local test inquiry recorded
        </h2>
        <p className="text-sm text-emerald-900">
          Your request ID is{" "}
          <strong data-testid="inquiry-request-id" className="font-mono">
            {savedRequestId}
          </strong>
        </p>
        <p className="text-sm text-emerald-900">
          Stored under <code>data/submissions/inquiry/</code>.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href="/submissions" className="font-medium text-emerald-900 underline">
            View local submissions
          </Link>
          <Link href="/shop" className="font-medium text-emerald-900 underline">
            Back to the shop
          </Link>
        </div>
      </section>
    );
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      className="space-y-4 rounded-lg border border-slate-200 bg-white p-5"
      data-testid="inquiry-form"
    >
      <div className="space-y-1">
        <label htmlFor="inquiry-fullName" className="block text-sm font-medium">
          Full name
        </label>
        <input {...field("fullName")} autoComplete="name" className={inputClass} />
        {errors.fullName ? (
          <p id="inquiry-fullName-error" role="alert" className="text-sm text-red-700">
            {errors.fullName}
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <label htmlFor="inquiry-email" className="block text-sm font-medium">
          Email
        </label>
        <input {...field("email")} type="email" autoComplete="email" className={inputClass} />
        {errors.email ? (
          <p id="inquiry-email-error" role="alert" className="text-sm text-red-700">
            {errors.email}
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <label htmlFor="inquiry-productId" className="block text-sm font-medium">
          Product
        </label>
        <select {...field("productId")} className={inputClass}>
          <option value="">Select a product</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
            </option>
          ))}
        </select>
        {errors.productId ? (
          <p id="inquiry-productId-error" role="alert" className="text-sm text-red-700">
            {errors.productId}
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <label htmlFor="inquiry-inquiryType" className="block text-sm font-medium">
          Inquiry type
        </label>
        <select {...field("inquiryType")} className={inputClass}>
          {INQUIRY_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label htmlFor="inquiry-message" className="block text-sm font-medium">
          Message
        </label>
        <textarea {...field("message")} rows={6} className={inputClass} />
        {errors.message ? (
          <p id="inquiry-message-error" role="alert" className="text-sm text-red-700">
            {errors.message}
          </p>
        ) : null}
      </div>

      <button
        type="submit"
        disabled={busy}
        className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        data-testid="inquiry-submit"
      >
        {busy ? "Submitting..." : "Submit inquiry"}
      </button>
      {submitError ? (
        <p role="alert" className="text-sm text-red-700">
          {submitError}
        </p>
      ) : null}
    </form>
  );
}