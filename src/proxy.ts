import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/auth";
import { AUTH } from "@/lib/config";

// "/api/pixel/script" is public so Shopify's storefront ScriptTag can fetch it
// (no session). "/api/pixel/install" is intentionally NOT public — it stays
// session-gated for the dashboard.
// "/api/image-preview" is public so Facebook/Instagram can fetch a draft's
// branded image when publishing (the Graph APIs fetch the URL themselves, with
// no session). The route only composes images for SKUs that exist in the DB.
// "/api/price-alert" is public so the Shopify storefront can POST price-drop
// signups (cross-origin, CORS-guarded, rate-limited); its /notify cron child
// self-gates on CRON_SECRET.
// "/api/video-serve" is public so Facebook/Instagram can fetch a draft's rendered
// reel MP4 when publishing (Graph APIs fetch the URL themselves, no session). The
// route only streams the video_path of an existing draft, with a traversal guard.
const PUBLIC_PATHS = ["/login", "/privacy", "/api/auth", "/api/cron", "/api/health", "/api/social/content", "/api/pixel/script", "/api/feeds", "/api/image-preview", "/api/price-alert", "/api/video-serve"];

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
