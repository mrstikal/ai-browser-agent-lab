import { z } from "zod";
import { readGuardedMutation } from "@/server/mutation-guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Inert proof endpoint for the Phase 9 local mutation guard. It has no side
// effects and exists so the guard can be exercised end to end.
const probeSchema = z.strictObject({
  message: z.string().min(1).max(200),
});

export async function POST(request: Request) {
  const guarded = await readGuardedMutation(request, { schema: probeSchema });
  if (!guarded.ok) return guarded.response;

  return Response.json(
    { ok: true, received: guarded.data },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
