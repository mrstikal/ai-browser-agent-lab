import { NextResponse, type NextRequest } from "next/server";
import { isTrustedHostHeader } from "@/server/config";

/**
 * Sensitive pages and read APIs can disclose agent tasks, outputs, submission
 * PII, and setup state. Mutation routes already validate Host; reads need the
 * same boundary because loopback binding alone does not stop DNS rebinding.
 */
export function middleware(request: NextRequest): NextResponse {
  if (!isTrustedHostHeader(request.headers.get("host"))) {
    return new NextResponse("Forbidden", {
      status: 403,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/agent/:path*",
    "/submissions/:path*",
    "/setup/:path*",
    "/api/agent/:path*",
    "/api/images/progress/:path*",
  ],
};
