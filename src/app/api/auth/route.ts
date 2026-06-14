import { NextResponse } from "next/server";
import { verifyPassword, hashPassword, setSessionCookie, logout } from "@/lib/auth";
import { getUserByUsername, updateUserLastLogin, createUser } from "@/lib/database";

// Simple in-memory rate limiter for auth attempts (per IP, 10 attempts per 15 min)
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_IPS = 10000;

/** Constant-time string comparison (same pattern as lib/auth.ts verifyPassword). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

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

/** Ensure seeded users exist: admin from AUTH_PASSWORD, meta-review from META_REVIEW_PASSWORD */
async function ensureSeededUsers(): Promise<void> {
  const defaultPassword = process.env.AUTH_PASSWORD;
  if (defaultPassword) {
    const existing = await getUserByUsername("admin");
    if (!existing) {
      const hash = await hashPassword(defaultPassword);
      await createUser("admin", hash, "admin");
      console.log("[AUTH] Default admin user created");
    }
  }

  const reviewerPassword = process.env.META_REVIEW_PASSWORD;
  if (reviewerPassword) {
    const existing = await getUserByUsername("meta-review");
    if (!existing) {
      const hash = await hashPassword(reviewerPassword);
      await createUser("meta-review", hash, "reviewer");
      console.log("[AUTH] meta-review reviewer user created");
    }
  }
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

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (isRateLimited(ip)) {
    console.warn(`[AUTH] Rate limited: ${ip}`);
    return NextResponse.json({ success: false, error: "Too many attempts. Try again later." }, { status: 429 });
  }

  // Coerce to strings — a non-string JSON value (number/object/array) would otherwise
  // throw on .trim()/.charCodeAt() and surface as an opaque 500.
  const username = (typeof body.username === "string" ? body.username : "").trim();
  const password = typeof body.password === "string" ? body.password : "";

  if (!username || !password) {
    return NextResponse.json({ success: false, error: "Username and password required" }, { status: 400 });
  }

  if (username.length > 50 || password.length > 200) {
    return NextResponse.json({ success: false, error: "Invalid credentials" }, { status: 400 });
  }

  // Emergency admin login — DB-independent. The user-store path below depends on
  // Turso (getUserByUsername + ensureSeededUsers); if Turso is blocked (quota) or
  // down, those throw and NOBODY can log in. This fallback verifies the submitted
  // password against AUTH_PASSWORD (the admin secret) with a constant-time compare
  // and issues an admin session WITHOUT touching the database. It runs BEFORE
  // ensureSeededUsers so an outage never even attempts a query on this path.
  // Restricted to username "admin" so it can't mint admin under another username.
  const adminSecret = process.env.AUTH_PASSWORD;
  if (adminSecret && username === "admin" && safeEqual(password, adminSecret)) {
    await setSessionCookie("admin", "admin");
    console.log(`[AUTH] Emergency admin login (DB-independent): ip=${ip}`);
    return NextResponse.json({ success: true, username: "admin", role: "admin" });
  }

  // Normal path (DB-backed). Ensure seeded users exist on first login attempt.
  try {
    await ensureSeededUsers();
  } catch (err) {
    console.error("[AUTH] ensureSeededUsers failed (non-fatal):", err);
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
  await setSessionCookie(username, user.role);
  console.log(`[AUTH] Successful login: user=${username} role=${user.role} ip=${ip}`);
  return NextResponse.json({ success: true, username, role: user.role });
}
