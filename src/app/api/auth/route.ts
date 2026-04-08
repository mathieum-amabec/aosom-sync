import { NextResponse } from "next/server";
import { verifyPassword, hashPassword, setSessionCookie, logout } from "@/lib/auth";
import { getUserByUsername, updateUserLastLogin, createUser, getUserCount } from "@/lib/database";

// Simple in-memory rate limiter for auth attempts (per IP, 10 attempts per 15 min)
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_IPS = 10000;

function isRateLimited(ip: string): boolean {
  const now = Date.now();

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

/** Ensure at least one user exists (seeds from AUTH_PASSWORD env var) */
async function ensureDefaultUser(): Promise<void> {
  const count = await getUserCount();
  if (count > 0) return;
  const defaultPassword = process.env.AUTH_PASSWORD;
  if (!defaultPassword) return;
  const hash = await hashPassword(defaultPassword);
  await createUser("admin", hash);
  console.log("[AUTH] Default admin user created");
}

export async function POST(request: Request) {
  const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
  if (contentLength > 1024) {
    return NextResponse.json({ success: false, error: "Payload too large" }, { status: 413 });
  }

  const body = await request.json();

  if (body.action === "logout") {
    await logout();
    return NextResponse.json({ success: true });
  }

  // Ensure default user exists on first login attempt
  await ensureDefaultUser();

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (isRateLimited(ip)) {
    console.warn(`[AUTH] Rate limited: ${ip}`);
    return NextResponse.json({ success: false, error: "Too many attempts. Try again later." }, { status: 429 });
  }

  const username = (body.username || "").trim();
  const password = body.password || "";

  if (!username || !password) {
    return NextResponse.json({ success: false, error: "Username and password required" }, { status: 400 });
  }

  if (username.length > 50 || password.length > 200) {
    return NextResponse.json({ success: false, error: "Invalid credentials" }, { status: 400 });
  }

  const user = await getUserByUsername(username);
  if (!user) {
    console.warn(`[AUTH] Failed login: user=${username} ip=${ip}`);
    return NextResponse.json({ success: false, error: "Invalid credentials" }, { status: 401 });
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    console.warn(`[AUTH] Failed login: user=${username} ip=${ip}`);
    return NextResponse.json({ success: false, error: "Invalid credentials" }, { status: 401 });
  }

  await updateUserLastLogin(user.id);
  await setSessionCookie(username);
  console.log(`[AUTH] Successful login: user=${username} ip=${ip}`);
  return NextResponse.json({ success: true, username });
}
