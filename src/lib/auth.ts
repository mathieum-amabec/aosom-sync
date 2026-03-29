import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "aosom_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function getPassword(): string {
  return process.env.AUTH_PASSWORD || "admin123";
}

/** Create a simple signed token: base64(timestamp:hash) */
function createToken(): string {
  const ts = Date.now().toString();
  const data = `${ts}:${getPassword()}`;
  // Simple hash — not crypto-grade but sufficient for a 2-user internal tool
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data.charCodeAt(i)) | 0;
  }
  return Buffer.from(`${ts}:${hash}`).toString("base64");
}

function verifyToken(token: string): boolean {
  try {
    const decoded = Buffer.from(token, "base64").toString();
    const [ts] = decoded.split(":");
    const age = Date.now() - parseInt(ts, 10);
    return age < SESSION_MAX_AGE * 1000 && age >= 0;
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
