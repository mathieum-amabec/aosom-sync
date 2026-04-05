import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";

const SESSION_COOKIE = "aosom_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function getPassword(): string {
  const pw = process.env.AUTH_PASSWORD;
  if (!pw) throw new Error("AUTH_PASSWORD environment variable is required");
  return pw;
}

function getSigningSecret(): string {
  // Derive a signing key from the password so tokens are tied to the current password
  return crypto.createHash("sha256").update(getPassword()).digest("hex");
}

/** Create an HMAC-signed token: base64(timestamp:hmac) */
function createToken(): string {
  const ts = Date.now().toString();
  const hmac = crypto
    .createHmac("sha256", getSigningSecret())
    .update(ts)
    .digest("hex");
  return Buffer.from(`${ts}:${hmac}`).toString("base64");
}

function verifyToken(token: string): boolean {
  try {
    const decoded = Buffer.from(token, "base64").toString();
    const colonIdx = decoded.indexOf(":");
    if (colonIdx === -1) return false;

    const ts = decoded.slice(0, colonIdx);
    const providedHmac = decoded.slice(colonIdx + 1);

    // Verify age
    const age = Date.now() - parseInt(ts, 10);
    if (age >= SESSION_MAX_AGE * 1000 || age < 0) return false;

    // Verify HMAC signature
    const expectedHmac = crypto
      .createHmac("sha256", getSigningSecret())
      .update(ts)
      .digest("hex");

    const a = Buffer.from(providedHmac);
    const b = Buffer.from(expectedHmac);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function login(password: string): Promise<boolean> {
  if (password !== getPassword()) return false;
  const token = createToken();
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
  return true;
}

export async function logout(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

export async function isAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return false;
  return verifyToken(token);
}

/** Middleware check for API routes */
export function isAuthenticatedFromRequest(req: NextRequest): boolean {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return false;
  return verifyToken(token);
}
