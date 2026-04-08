import { NextResponse } from "next/server";
import { login, logout } from "@/lib/auth";

// Simple in-memory rate limiter for auth attempts (per IP, 10 attempts per 15 min)
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_IPS = 10000;

function isRateLimited(ip: string): boolean {
  const now = Date.now();

  // Periodic cleanup: evict expired entries to prevent memory leak
  if (attempts.size > MAX_TRACKED_IPS) {
    for (const [key, entry] of attempts) {
      if (now > entry.resetAt) attempts.delete(key);
    }
  }

  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > MAX_ATTEMPTS;
}

export async function POST(request: Request) {
  // Reject oversized payloads
  const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
  if (contentLength > 1024) {
    return NextResponse.json({ success: false, error: "Payload too large" }, { status: 413 });
  }

  const body = await request.json();

  if (body.action === "logout") {
    await logout();
    return NextResponse.json({ success: true });
  }

  // Rate limit login attempts
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (isRateLimited(ip)) {
    return NextResponse.json({ success: false, error: "Too many attempts. Try again later." }, { status: 429 });
  }

  const ok = await login(body.password || "");
  if (!ok) {
    return NextResponse.json({ success: false, error: "Invalid password" }, { status: 401 });
  }

  return NextResponse.json({ success: true });
}
