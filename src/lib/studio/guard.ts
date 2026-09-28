import { NextResponse } from "next/server";
import { isAuthenticated, isAdmin } from "@/lib/auth";

/**
 * Every /api/studio route is admin-only: renders and AI retouches spend money (Vercel compute,
 * AI Gateway credit) and write to the publication queue. Returns a response to send back when
 * the caller is not allowed, or null to proceed.
 */
export async function requireStudioAdmin(): Promise<NextResponse | null> {
  if (!(await isAuthenticated())) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!(await isAdmin())) return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  return null;
}

/** URL of a file in our public Blob store under one of the Studio prefixes. */
export function isStudioBlobUrl(raw: string, prefixes: string[]): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === "https:" &&
      u.hostname.endsWith(".public.blob.vercel-storage.com") &&
      prefixes.some((p) => u.pathname.startsWith(`/${p}`))
    );
  } catch {
    return false;
  }
}
