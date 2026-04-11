import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/auth";
import { AUTH } from "@/lib/config";

const PUBLIC_PATHS = ["/login", "/api/auth", "/api/cron", "/api/health", "/api/sync"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow static assets — only known static file extensions, not any path with a dot
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    /\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|webp|avif)$/i.test(pathname)
  ) {
    return NextResponse.next();
  }

  // Check auth via cookie (no DB access needed — token is self-contained)
  const token = request.cookies.get(AUTH.COOKIE_NAME)?.value;
  if (!token || !(await verifySessionToken(token))) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
