import { z } from "zod";
import {
  agentUiModeSchema,
  type AgentUiMode,
} from "@/lib/agent-ui-mode";
import {
  Storage,
  StorageCorruptionError,
} from "./storage";

export const UI_MODE_FILE_SEGMENTS = ["ui-settings.json"] as const;
export const UI_MODE_VERSION = 1 as const;

export const uiModeSettingsSchema = z.strictObject({
  version: z.literal(UI_MODE_VERSION),
  mode: agentUiModeSchema,
  updatedAt: z.iso.datetime(),
});

export type UiModeSettings = z.infer<typeof uiModeSettingsSchema>;

export class UiModeCorruptionError extends StorageCorruptionError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UiModeCorruptionError";
  }
}

export function createDefaultUiModeSettings(
  now: Date = new Date(),
): UiModeSettings {
  return {
    version: UI_MODE_VERSION,
    mode: "classic",
    updatedAt: now.toISOString(),
  };
}

export function parseUiModeSettings(value: unknown): UiModeSettings {
  const parsed = uiModeSettingsSchema.safeParse(value);
  if (!parsed.success) {
    throw new UiModeCorruptionError(
      "Saved layout settings are unreadable. Inspect data/ui-settings.json.",
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

export async function loadUiModeSettings(
  storage: Storage,
): Promise<UiModeSettings> {
  const raw = await storage.readJson<unknown>(UI_MODE_FILE_SEGMENTS);
  if (raw === undefined) return createDefaultUiModeSettings();
  return parseUiModeSettings(raw);
}

export async function loadUiMode(storage: Storage): Promise<AgentUiMode> {
  return (await loadUiModeSettings(storage)).mode;
}

export interface UiModeView {
  readonly mode: AgentUiMode;
  readonly error: string | null;
}

/**
 * Page-facing read: a corrupt optional layout setting must not take down the
 * catalog or a form. The strict `loadUiMode` remains the agent-run source so a
 * corrupt setting fails closed before any paid work starts.
 */
export async function loadUiModeView(storage: Storage): Promise<UiModeView> {
  try {
    return { mode: await loadUiMode(storage), error: null };
  } catch {
    return {
      mode: "classic",
      error:
        "Saved layout mode is unreadable; Classic is shown. Inspect data/ui-settings.json.",
    };
  }
}

export async function saveUiMode(
  storage: Storage,
  mode: AgentUiMode,
  now: Date = new Date(),
): Promise<UiModeSettings> {
  const settings = uiModeSettingsSchema.parse({
    version: UI_MODE_VERSION,
    mode,
    updatedAt: now.toISOString(),
  });
  await storage.writeJson(UI_MODE_FILE_SEGMENTS, settings);
  return settings;
}
