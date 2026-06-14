// Regression tests for the DB-independent emergency admin login (fix/turso-quota-p0).
// When Turso is blocked (quota) or down, getUserByUsername() throws and the normal
// login path 500s — locking everyone out. The emergency path must let "admin" log in
// using AUTH_PASSWORD without ever touching the database.

import { describe, it, expect, vi, beforeEach } from "vitest";

const TEST_SECRET = "emergency-admin-secret";
process.env.AUTH_PASSWORD = TEST_SECRET;

// Mock the DB layer (libsql has no win-arm64 build) AND simulate Turso being down by
// having getUserByUsername throw — the emergency path must not call it at all.
const db = vi.hoisted(() => ({
  getUserByUsername: vi.fn(),
  updateUserLastLogin: vi.fn(),
  createUser: vi.fn(),
}));
vi.mock("@/lib/database", () => db);

// Mock the auth helpers so no real cookie store / next/headers is needed.
const auth = vi.hoisted(() => ({
  setSessionCookie: vi.fn(),
  logout: vi.fn(),
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(),
}));
vi.mock("@/lib/auth", () => auth);

import { POST } from "@/app/api/auth/route";

function loginRequest(body: Record<string, unknown>): Request {
  return new Request("https://app.test/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: Turso is DOWN — any user-store read throws.
  db.getUserByUsername.mockRejectedValue(new Error("Turso quota exceeded"));
});

describe("emergency admin login (Turso-independent)", () => {
  it("logs admin in with AUTH_PASSWORD even when Turso is down", async () => {
    // getUserByUsername rejects (Turso down). Without the emergency path the route
    // would 500; the emergency branch returns 200 before the login lookup is reached.
    const res = await POST(loginRequest({ username: "admin", password: TEST_SECRET }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, username: "admin", role: "admin" });
    expect(auth.setSessionCookie).toHaveBeenCalledWith("admin", "admin");
  });

  it("logs admin in via emergency path even when the DB is healthy", async () => {
    // Healthy DB but emergency path still short-circuits for admin + AUTH_PASSWORD.
    db.getUserByUsername.mockResolvedValue({
      id: 1, username: "admin", password_hash: "unused", role: "admin",
    });
    const res = await POST(loginRequest({ username: "admin", password: TEST_SECRET }));
    expect(res.status).toBe(200);
    expect(auth.setSessionCookie).toHaveBeenCalledWith("admin", "admin");
    // verifyPassword (normal path) is never consulted for the emergency login.
    expect(auth.verifyPassword).not.toHaveBeenCalled();
  });

  it("rejects a wrong password (falls through to the DB path, which is down → throws)", async () => {
    // Wrong password skips the emergency branch and hits getUserByUsername, which
    // rejects — the route has no catch, so the rejection propagates (500 at runtime).
    await expect(POST(loginRequest({ username: "admin", password: "wrong" }))).rejects.toThrow();
    expect(auth.setSessionCookie).not.toHaveBeenCalled();
  });

  it("does not grant admin to a non-admin username even with the right password", async () => {
    // username !== "admin" must not mint an admin session via the emergency path.
    await expect(POST(loginRequest({ username: "meta-review", password: TEST_SECRET }))).rejects.toThrow();
    expect(auth.setSessionCookie).not.toHaveBeenCalled();
  });
});
