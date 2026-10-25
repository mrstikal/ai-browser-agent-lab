import type { ModelSettings } from "../lib/schemas";
import { getKeyStatus, loadOpenRouterKey, type KeyStatus } from "./credentials";
import {
  ImageQuoteError,
  prepareImageQuote,
  type ImageQuote,
  type ImageQuoteCode,
} from "./image-quote";
import {
  createEmptyImageManifest,
  deriveSetupState,
  inspectSetupState,
  loadImageJob,
  type ImageJobSnapshot,
  type SetupState,
} from "./image-state";
import { isImageJobLive } from "./image-job-liveness";
import { createDefaultModelSettings, loadModelSettings } from "./model-settings";
import { Storage, type StorageEnv } from "./storage";

export interface SetupViewKey extends KeyStatus {
  readonly error: string | null;
}

export type SetupViewQuote =
  | { readonly ok: true; readonly quote: ImageQuote }
  | { readonly ok: false; readonly code: ImageQuoteCode; readonly message: string };

export interface SetupView {
  readonly setup: SetupState;
  readonly setupError: string | null;
  readonly settings: ModelSettings;
  readonly settingsError: string | null;
  readonly key: SetupViewKey;
  readonly quote: SetupViewQuote | null;
}

const QUOTE_MESSAGES: Record<ImageQuoteCode, string> = {
  "key-required":
    "Enter and validate an OpenRouter API key to see the current image estimate.",
  "key-rejected":
    "OpenRouter rejected this key. Replace it and validate again before quoting.",
  "stale-model":
    "The saved image model is no longer available with these settings. Choose a supported model and check the price again.",
  "unverified-capabilities":
    "This model endpoint does not verifiably support the requested resolution, aspect ratio, and format. Choose another model.",
  "unknown-price":
    "OpenRouter does not publish a usable flat per-image price for this choice. Generation stays blocked until a defensible estimate is available.",
  unavailable:
    "The price check is temporarily unavailable (network, timeout, or provider error). No paid request was made.",
  "invalid-response":
    "The provider returned model metadata that could not be verified. No paid request was made.",
  "invalid-settings":
    "Model settings are unreadable. Inspect data/settings.json before quoting.",
  "invalid-image-state":
    "Saved image state is unreadable. Inspect the image manifest before quoting.",
  "no-targets":
    "All 24 images are already valid. Choose explicit regeneration targets to quote a new batch.",
  "invalid-selection":
    "The requested image selection is not valid. Check the model, resolution, aspect ratio, and format.",
};

export interface LoadSetupViewOptions {
  readonly env?: StorageEnv | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly skipQuote?: boolean | undefined;
}

export async function loadSetupView(
  storage: Storage,
  options: LoadSetupViewOptions = {},
): Promise<SetupView> {
  const env = options.env ?? process.env;
  let key: SetupViewKey;
  let keyValue: string | undefined;
  try {
    const status = await getKeyStatus(env, { sweepTemps: false });
    keyValue = await loadOpenRouterKey(env);
    key = { ...status, error: null };
  } catch {
    key = {
      keyAvailable: false,
      source: null,
      error:
        "The stored key is unreadable or malformed. Delete it and enter the key again.",
    };
  }

  let settings: ModelSettings;
  let settingsError: string | null = null;
  try {
    settings = await loadModelSettings(storage);
  } catch {
    settings = createDefaultModelSettings();
    settingsError =
      "Model settings are unreadable. Inspect data/settings.json; defaults are shown but not active.";
  }

  let setup: SetupState;
  let setupError: string | null = null;
  let liveJob: ImageJobSnapshot | null = null;
  try {
    liveJob = (await loadImageJob(storage)) ?? null;
  } catch {
    // inspectSetupState below reports unreadable image state with its own
    // message; liveness simply stays false.
  }
  try {
    setup = await inspectSetupState(storage, {
      keyAvailable: key.keyAvailable,
      jobIsLive: isImageJobLive(storage, liveJob),
    });
  } catch {
    setup = deriveSetupState({
      keyAvailable: key.keyAvailable,
      manifest: createEmptyImageManifest(),
      validImageIds: [],
    });
    setupError =
      "Saved image state is unreadable. Inspect the image manifest and quarantine files before continuing.";
  }

  let quote: SetupViewQuote | null = null;
  if (!options.skipQuote && !setupError && setup.status !== "completed") {
    if (!key.keyAvailable || !keyValue) {
      quote = {
        ok: false,
        code: "key-required",
        message: QUOTE_MESSAGES["key-required"],
      };
    } else {
      try {
        quote = {
          ok: true,
          quote: await prepareImageQuote({
            storage,
            apiKey: keyValue,
            selection: settings.image,
            env,
            fetchImpl: options.fetchImpl,
          }),
        };
      } catch (error) {
        if (error instanceof ImageQuoteError) {
          quote = { ok: false, code: error.code, message: QUOTE_MESSAGES[error.code] };
        } else {
          quote = {
            ok: false,
            code: "unavailable",
            message: QUOTE_MESSAGES.unavailable,
          };
        }
      }
    }
  }

  return { setup, setupError, settings, settingsError, key, quote };
}
