"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { guardedJsonFetch, readErrorMessage } from "./guard-fetch";

export interface ModelFormProps {
  readonly image: {
    readonly modelId: string;
    readonly resolution: string;
    readonly aspectRatio: string;
    readonly format: string;
  };
  readonly browser: { readonly modelId: string };
}

const inputClass =
  "w-full rounded border border-slate-300 px-3 py-2 text-sm";

export function ModelForm({ image, browser }: ModelFormProps) {
  const router = useRouter();
  const [imageModelId, setImageModelId] = useState(image.modelId);
  const [resolution, setResolution] = useState(image.resolution);
  const [aspectRatio, setAspectRatio] = useState(image.aspectRatio);
  const [format, setFormat] = useState(image.format);
  const [browserModelId, setBrowserModelId] = useState(browser.modelId);
  const [busy, setBusy] = useState<"image" | "browser" | null>(null);
  const [imageMessage, setImageMessage] = useState<string | null>(null);
  const [browserMessage, setBrowserMessage] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [browserError, setBrowserError] = useState<string | null>(null);

  async function save(
    kind: "image" | "browser",
    body: unknown,
  ): Promise<void> {
    setBusy(kind);
    setImageMessage(null);
    setBrowserMessage(null);
    setImageError(null);
    setBrowserError(null);
    try {
      const response = await guardedJsonFetch("/api/setup/models", {
        method: "POST",
        body,
      });
      if (!response.ok) {
        const message = await readErrorMessage(response);
        if (kind === "image") setImageError(message);
        else setBrowserError(message);
        return;
      }
      if (kind === "image") {
        setImageMessage("Image model choice saved.");
      } else {
        setBrowserMessage("Browser model choice saved.");
      }
      router.refresh();
    } catch {
      if (kind === "image") setImageError("The image model choice could not be saved.");
      else setBrowserError("The browser model choice could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  async function submitImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await save("image", {
      image: {
        modelId: imageModelId,
        resolution,
        aspectRatio,
        format,
        n: 1,
      },
    });
  }

  async function submitBrowser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await save("browser", { browser: { modelId: browserModelId } });
  }

  return (
    <section aria-labelledby="models-heading" className="space-y-6 rounded-lg border border-slate-200 bg-white p-5">
      <div className="space-y-1">
        <h2 id="models-heading" className="text-lg font-semibold">
          Model settings
        </h2>
        <p className="text-sm text-slate-600">
          Image and browser choices are stored independently in <code>data/settings.json</code>.
          The key is never part of this file.
        </p>
      </div>

      <form onSubmit={submitImage} className="space-y-3" data-testid="image-model-form">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Image model
        </h3>
        <div className="space-y-1">
          <label htmlFor="image-model-id" className="block text-sm font-medium">
            Image model ID
          </label>
          <input
            id="image-model-id"
            value={imageModelId}
            onChange={(event) => setImageModelId(event.target.value)}
            required
            maxLength={200}
            className={inputClass}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <label htmlFor="image-resolution" className="block text-sm font-medium">
              Resolution
            </label>
            <select
              id="image-resolution"
              value={resolution}
              onChange={(event) => setResolution(event.target.value)}
              className={inputClass}
            >
              {["512", "768", "1K", "1.5K", "2K", "4K"].map((tier) => (
                <option key={tier} value={tier}>
                  {tier}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="image-aspect" className="block text-sm font-medium">
              Aspect ratio
            </label>
            <input
              id="image-aspect"
              value={aspectRatio}
              onChange={(event) => setAspectRatio(event.target.value)}
              required
              maxLength={16}
              className={inputClass}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="image-format" className="block text-sm font-medium">
              Output format
            </label>
            <select
              id="image-format"
              value={format}
              onChange={(event) => setFormat(event.target.value)}
              className={inputClass}
            >
              <option value="png">png</option>
              <option value="jpeg">jpeg</option>
              <option value="webp">webp</option>
            </select>
          </div>
        </div>
        <button
          type="submit"
          disabled={busy !== null}
          className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Save image model
        </button>
        {imageMessage ? (
          <p role="status" className="text-sm text-emerald-700">
            {imageMessage}
          </p>
        ) : null}
        {imageError ? (
          <p role="alert" className="text-sm text-red-700">
            {imageError}
          </p>
        ) : null}
      </form>

      <form onSubmit={submitBrowser} className="space-y-3" data-testid="browser-model-form">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Browser agent model
        </h3>
        <div className="space-y-1">
          <label htmlFor="browser-model-id" className="block text-sm font-medium">
            Browser model ID
          </label>
          <input
            id="browser-model-id"
            value={browserModelId}
            onChange={(event) => setBrowserModelId(event.target.value)}
            required
            maxLength={200}
            className={inputClass}
          />
          <p className="text-xs text-slate-500">
            Advanced free-text IDs are format-checked and need a fresh compatibility check before
            the agent runs.
          </p>
        </div>
        <button
          type="submit"
          disabled={busy !== null}
          className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Save browser model
        </button>
        {browserMessage ? (
          <p role="status" className="text-sm text-emerald-700">
            {browserMessage}
          </p>
        ) : null}
        {browserError ? (
          <p role="alert" className="text-sm text-red-700">
            {browserError}
          </p>
        ) : null}
      </form>
    </section>
  );
}
