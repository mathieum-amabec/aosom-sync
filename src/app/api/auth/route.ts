import { NextResponse } from "next/server";
import { login, logout } from "@/lib/auth";

// Simple in-memory rate limiter for auth attempts (per IP, 10 attempts per 15 min)
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > MAX_ATTEMPTS;
}

export async function POST(request: Request) {
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
