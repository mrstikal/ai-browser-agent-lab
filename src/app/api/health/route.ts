import { NextResponse } from "next/server";
import { HEALTH_PAYLOAD } from "@/lib/health";
import { isServerLockHeld } from "@/server/server-lock";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  if (!(await isServerLockHeld())) {
    return NextResponse.json(
      { ok: false },
      {
        status: 503,
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  }

  return NextResponse.json(HEALTH_PAYLOAD, {
    status: 200,
    headers: {
      "cache-control": "no-store",
    },
  });
}
