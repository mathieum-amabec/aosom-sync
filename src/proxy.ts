import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/auth";
import { AUTH } from "@/lib/config";

const PUBLIC_PATHS = ["/login", "/privacy", "/api/auth", "/api/cron", "/api/health", "/api/sync"];

function isReviewerAllowed(pathname: string): boolean {
  return AUTH.REVIEWER_ALLOWED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p + "?")
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
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
  const session = token ? await verifySessionToken(token) : null;
  if (!session) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Role-based access: the reviewer role (seeded for Meta App Review) is
  // restricted to Social Media + Settings + a small API allowlist. Pages
  // outside the allowlist redirect to /social; API calls return 403.
  if (session.role === "reviewer" && !isReviewerAllowed(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/social", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
