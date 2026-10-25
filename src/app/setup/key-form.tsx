"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { guardedJsonFetch, readErrorMessage } from "./guard-fetch";

export interface KeyFormProps {
  readonly keyAvailable: boolean;
  readonly source: "memory" | "file" | null;
}

export function KeyForm({ keyAvailable, source }: KeyFormProps) {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await guardedJsonFetch("/api/setup/key", {
        method: "POST",
        body: { key, remember },
      });
      if (!response.ok) {
        setError(await readErrorMessage(response));
        return;
      }
      const payload = (await response.json()) as {
        keyPermitsInference?: boolean;
      };
      setKey("");
      setRemember(false);
      setMessage(
        payload.keyPermitsInference === false
          ? "Key validated, but OpenRouter reports a management-only key. It cannot run inference or image generation; replace it with an inference key."
          : "Key validated and stored. The key is never sent back to the browser.",
      );
      router.refresh();
    } catch {
      setError("The key could not be validated. Nothing was stored.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await guardedJsonFetch("/api/setup/key", {
        method: "DELETE",
        body: {},
      });
      if (!response.ok) {
        setError(await readErrorMessage(response));
        return;
      }
      setMessage(
        source === "file"
          ? "Key deleted from memory and disk."
          : "Session key deleted from memory.",
      );
      router.refresh();
    } catch {
      setError("The key could not be deleted.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="key-heading" className="space-y-4 rounded-lg border border-slate-200 bg-white p-5">
      <div className="space-y-1">
        <h2 id="key-heading" className="text-lg font-semibold">
          OpenRouter API key
        </h2>
        <p className="text-sm text-slate-600">
          The key is validated with a non-billable <code>GET /api/v1/key</code> request, then kept
          in server memory by default. It is never returned to the browser, logged, or written to
          settings.
        </p>
        <p className="text-sm text-slate-600" data-testid="key-status">
          {keyAvailable
            ? `Key available (${source === "file" ? "Remember on, stored in data/secrets/openrouter-key" : "session memory only"}).`
            : "No key available for this server process."}
        </p>
      </div>

      <form onSubmit={submit} className="space-y-3">
        <div className="space-y-1">
          <label htmlFor="openrouter-key" className="block text-sm font-medium">
            API key
          </label>
          <input
            id="openrouter-key"
            name="key"
            type="password"
            autoComplete="off"
            required
            minLength={8}
            maxLength={512}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="remember"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          Remember API key (stores plaintext on disk with mode 0600)
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "Working..." : "Validate and save key"}
          </button>
          {keyAvailable ? (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="rounded border border-slate-300 px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              Delete key
            </button>
          ) : null}
        </div>
      </form>

      {message ? (
        <p role="status" className="text-sm text-emerald-700">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
    </section>
  );
}
