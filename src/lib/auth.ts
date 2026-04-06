import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { env, AUTH } from "./config";

const SESSION_COOKIE = AUTH.COOKIE_NAME;
const SESSION_MAX_AGE = AUTH.SESSION_MAX_AGE;

async function hmacSign(ts: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw", enc.encode(env.authPassword), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(ts));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Create a signed token: base64(timestamp:hmac) */
async function createToken(): Promise<string> {
  const ts = Date.now().toString();
  const sig = await hmacSign(ts);
  return btoa(`${ts}:${sig}`);
}

async function verifyToken(token: string): Promise<boolean> {
  try {
    const decoded = atob(token);
    const sep = decoded.indexOf(":");
    if (sep === -1) return false;
    const ts = decoded.slice(0, sep);
    const sig = decoded.slice(sep + 1);
    const age = Date.now() - parseInt(ts, 10);
    if (age >= SESSION_MAX_AGE * 1000 || age < 0) return false;
    const expected = await hmacSign(ts);
    if (sig.length !== expected.length) return false;
    // Constant-time comparison
    let diff = 0;
    for (let i = 0; i < sig.length; i++) {
      diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return diff === 0;
  } catch {
    return false;
  }
}

export async function login(password: string): Promise<boolean> {
  const enc = new TextEncoder();
  const a = enc.encode(password);
  const b = enc.encode(env.authPassword);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff !== 0) return false;
  const token = await createToken();
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.isProduction,
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
export async function isAuthenticatedFromRequest(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return false;
  return verifyToken(token);
}
