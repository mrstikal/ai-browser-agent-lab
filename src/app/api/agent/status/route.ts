import { loadAgentStatus } from "@/server/agent-manager";
import { AgentCompatibilityError } from "@/server/agent-compatibility";
import { AgentRunCorruptionError } from "@/server/agent-runs";
import { ModelSettingsCorruptionError } from "@/server/model-settings";
import { StorageCorruptionError } from "@/server/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const snapshot = await loadAgentStatus();
    return Response.json(snapshot, {
      status: 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (
      error instanceof AgentRunCorruptionError ||
      error instanceof AgentCompatibilityError ||
      error instanceof ModelSettingsCorruptionError ||
      error instanceof StorageCorruptionError
    ) {
      return Response.json(
        {
          error: {
            code: "state-unreadable",
            message:
              "Saved agent run, model, or compatibility state is unreadable. No work was started.",
          },
        },
        { status: 500, headers: { "cache-control": "no-store" } },
      );
    }
    return Response.json(
      {
        error: {
          code: "status-unavailable",
          message: "Agent status is unavailable. No work was started.",
        },
      },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
