import { describe, it, expect, vi } from "vitest";

// proxy.ts imports verifySessionToken at module load; mock it so no env/session is needed.
vi.mock("@/lib/auth", () => ({ verifySessionToken: vi.fn().mockResolvedValue(null) }));

import { NextRequest } from "next/server";
const { proxy } = await import("@/proxy");

const req = (path: string) => new NextRequest(new URL("https://aosom-sync.vercel.app" + path));

describe("proxy PUBLIC_PATHS", () => {
  it("lets /api/assistant through unauthenticated (storefront widget must reach it)", async () => {
    const res = await proxy(req("/api/assistant"));
    // NextResponse.next() → 200, no Location; a /login redirect would be 307 with Location.
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("still redirects a non-public API route to /login when unauthenticated", async () => {
    const res = await proxy(req("/api/import/queue"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location") || "").toContain("/login");
  });

  it("keeps the other storefront routes public (regression guard)", async () => {
    for (const p of ["/api/pixel/script", "/api/waitlist", "/api/price-alert", "/api/ugc-videos"]) {
      const res = await proxy(req(p));
      expect(res.headers.get("location"), `${p} should be public`).toBeNull();
    }
  });

  it("opens only the email unsubscribe link and the Resend webhook, not the rest of /api/email", async () => {
    for (const p of ["/api/email/unsubscribe", "/api/email/webhook"]) {
      expect((await proxy(req(p))).headers.get("location"), `${p} should be public`).toBeNull();
    }
    expect((await proxy(req("/api/email/stats"))).status).toBe(307);
  });
});
