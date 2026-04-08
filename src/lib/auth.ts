import { cookies } from "next/headers";
import { AUTH } from "./config";

const SESSION_COOKIE = AUTH.COOKIE_NAME;
const SESSION_MAX_AGE = AUTH.SESSION_MAX_AGE;

// ─── Password Hashing (PBKDF2-SHA256, Edge-compatible) ─────────────

const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

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

export async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const key = await globalThis.crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await globalThis.crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key, KEY_LENGTH * 8
  );
  return `${bufToHex(salt)}:${bufToHex(derived)}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [saltHex, expectedHex] = hash.split(":");
  if (!saltHex || !expectedHex) return false;
  const enc = new TextEncoder();
  const salt = hexToBuf(saltHex);
  const key = await globalThis.crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await globalThis.crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt.buffer as ArrayBuffer, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key, KEY_LENGTH * 8
  );
  const actual = new Uint8Array(derived);
  const expected = hexToBuf(expectedHex);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
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

export async function createSessionToken(username: string): Promise<string> {
  const ts = Date.now().toString();
  const payload = `${ts}:${username}`;
  const sig = await hmacSign(payload);
  return btoa(`${payload}:${sig}`);
}

export async function verifySessionToken(token: string): Promise<string | null> {
  try {
    const decoded = atob(token);
    const parts = decoded.split(":");
    if (parts.length < 3) return null;
    const ts = parts[0];
    const username = parts.slice(1, -1).join(":");
    const sig = parts[parts.length - 1];
    const age = Date.now() - parseInt(ts, 10);
    if (age >= SESSION_MAX_AGE * 1000 || age < 0) return null;
    const expected = await hmacSign(`${ts}:${username}`);
    if (sig.length !== expected.length) return null;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0 ? username : null;
  } catch {
    return null;
  }
}

// ─── Cookie-based Auth (Server Components) ──────────────────────────

export async function setSessionCookie(username: string): Promise<void> {
  const token = await createSessionToken(username);
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

export async function getSessionUsername(): Promise<string | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}
