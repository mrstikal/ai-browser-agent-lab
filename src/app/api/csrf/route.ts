import { checkRequestBoundary, getCsrfToken } from "@/server/mutation-guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  const boundary = checkRequestBoundary(request);
  if (!boundary.ok) return boundary.response;

  return Response.json(
    { token: getCsrfToken() },
    {
      status: 200,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
