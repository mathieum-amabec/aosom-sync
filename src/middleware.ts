import { NextRequest, NextResponse } from "next/server";
import { isAuthenticatedFromRequest } from "@/lib/auth";

const PUBLIC_PATHS = ["/login", "/api/auth", "/api/cron", "/api/health"];

export async function middleware(request: NextRequest) {
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

  // Check auth
  if (!(await isAuthenticatedFromRequest(request))) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
