import { cookies } from "next/headers";
import { AUTH, type UserRole } from "./config";

const SESSION_COOKIE = AUTH.COOKIE_NAME;
const SESSION_MAX_AGE = AUTH.SESSION_MAX_AGE;

// ─── Password Hashing (HMAC-SHA256 iterated, Edge-compatible) ──────
// Uses HMAC-SHA256 with salt — simpler than PBKDF2, works identically
// across Node.js and Vercel Edge runtimes.

const SALT_LENGTH = 16;

function bufToHex(buf: ArrayBuffer | Uint8Array): string {
  const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

async function hmacHash(password: string, saltHex: string): Promise<string> {
  const enc = new TextEncoder();
  // Use hex→key directly to avoid any ArrayBuffer/Uint8Array cross-runtime issues
  const saltBytes = hexToBuf(saltHex);
  const keyBuf = new ArrayBuffer(saltBytes.length);
  new Uint8Array(keyBuf).set(saltBytes);
  const key = await globalThis.crypto.subtle.importKey(
    "raw", keyBuf, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(password));
  return bufToHex(sig);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const saltHex = bufToHex(salt);
  const hash = await hmacHash(password, saltHex);
  return `${saltHex}:${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, expectedHex] = stored.split(":");
  if (!saltHex || !expectedHex) return false;
  const actual = await hmacHash(password, saltHex);
  if (actual.length !== expectedHex.length) return false;
  // Constant-time comparison
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  return diff === 0;
}

// ─── Session Tokens (HMAC-SHA256, Edge-compatible) ──────────────────

const HMAC_SECRET = process.env.AUTH_PASSWORD || "aosom-sync-session-secret";

async function hmacSign(data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw", enc.encode(HMAC_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, enc.encode(data));
  return bufToHex(sig);
}

export interface SessionPayload {
  username: string;
  role: UserRole;
}

// Token format: base64("ts:role:username:sig"). Role comes before username so
// parsing stays unambiguous even if a future username ever contains a colon.
// Old tokens (ts:username:sig) no longer validate — users will re-login.
export async function createSessionToken(username: string, role: UserRole): Promise<string> {
  const ts = Date.now().toString();
  const payload = `${ts}:${role}:${username}`;
  const sig = await hmacSign(payload);
  return btoa(`${payload}:${sig}`);
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const decoded = atob(token);
    const parts = decoded.split(":");
    if (parts.length < 4) return null;
    const ts = parts[0];
    const role = parts[1];
    if (!(AUTH.ROLES as readonly string[]).includes(role)) return null;
    const username = parts.slice(2, -1).join(":");
    const sig = parts[parts.length - 1];
    const age = Date.now() - parseInt(ts, 10);
    if (age >= SESSION_MAX_AGE * 1000 || age < 0) return null;
    const expected = await hmacSign(`${ts}:${role}:${username}`);
    if (sig.length !== expected.length) return null;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0 ? { username, role: role as UserRole } : null;
  } catch {
    return null;
  }
}

// ─── Cookie-based Auth (Server Components) ──────────────────────────

export async function setSessionCookie(username: string, role: UserRole): Promise<void> {
  const token = await createSessionToken(username, role);
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE,
    path: "/",
  });
}

export async function logout(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

export async function isAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return false;
  return (await verifySessionToken(token)) !== null;
}

export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

export async function getSessionUsername(): Promise<string | null> {
  const session = await getSession();
  return session?.username ?? null;
}

export async function getSessionRole(): Promise<UserRole | null> {
  const session = await getSession();
  return session?.role ?? null;
}

export function isPathAllowedForRole(pathname: string, role: UserRole): boolean {
  if (role === "admin") return true;
  return AUTH.REVIEWER_ALLOWED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/") || pathname.startsWith(p + "?")
  );
}
