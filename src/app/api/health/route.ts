import { NextResponse } from "next/server";
import { HEALTH_PAYLOAD } from "@/lib/health";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(HEALTH_PAYLOAD, {
    status: 200,
    headers: {
      "cache-control": "no-store",
    },
  });
}
