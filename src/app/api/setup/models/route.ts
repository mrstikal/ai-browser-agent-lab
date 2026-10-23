import { z } from "zod";
import {
  browserModelSettingsSchema,
  imageModelSettingsSchema,
} from "@/lib/schemas";
import { readGuardedMutation } from "@/server/mutation-guard";
import {
  loadModelSettings,
  saveModelSettings,
  updateBrowserSettings,
  updateImageSettings,
} from "@/server/model-settings";
import { createStorage } from "@/server/storage";
import { invalidateAgentCompatibility } from "@/server/agent-compatibility";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const modelsSchema = z
  .strictObject({
    image: imageModelSettingsSchema.optional(),
    browser: browserModelSettingsSchema.optional(),
  })
  .refine((value) => value.image !== undefined || value.browser !== undefined, {
    message: "Provide at least one of image or browser settings.",
  });

export async function POST(request: Request) {
  const guarded = await readGuardedMutation(request, { schema: modelsSchema });
  if (!guarded.ok) return guarded.response;

  const storage = createStorage();
  if (guarded.data.browser !== undefined) {
    try {
      await invalidateAgentCompatibility(storage);
    } catch {
      return Response.json(
        {
          error: {
            code: "compatibility-invalidation-failed",
            message:
              "The browser-model compatibility record could not be invalidated, so nothing was saved.",
          },
        },
        { status: 500, headers: { "cache-control": "no-store" } },
      );
    }
  }

  let settings;
  try {
    settings = await loadModelSettings(storage);
  } catch {
    return Response.json(
      { error: { code: "settings-corrupt", message: "Model settings are unreadable." } },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }

  if (guarded.data.image !== undefined) {
    settings = updateImageSettings(settings, guarded.data.image);
  }
  if (guarded.data.browser !== undefined) {
    settings = updateBrowserSettings(settings, guarded.data.browser);
  }

  try {
    await saveModelSettings(storage, settings);
  } catch {
    return Response.json(
      {
        error: {
          code: "settings-save-failed",
          message: "Model settings could not be saved.",
        },
      },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }

  return Response.json(
    { image: settings.image, browser: settings.browser },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
