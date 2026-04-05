import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedFromRequest } from "@/lib/auth";

const PUBLIC_PATHS = ["/login", "/api/auth", "/api/cron/sync"];
const STATIC_EXT_RE = /\.(ico|png|jpg|jpeg|svg|gif|webp|css|js|woff2?|ttf|eot|map)$/;

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow static assets (explicit extensions only, not arbitrary dots)
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    STATIC_EXT_RE.test(pathname)
  ) {
    return NextResponse.next();
  }

  // Check auth
  if (!isAuthenticatedFromRequest(request)) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const runtime = "nodejs";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
