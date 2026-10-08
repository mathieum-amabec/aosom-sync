import { describe, it, expect, vi, beforeEach } from "vitest";

const auth = vi.hoisted(() => ({ authed: true, admin: true }));
vi.mock("@/lib/auth", () => ({ isAuthenticated: vi.fn(async () => auth.authed), isAdmin: vi.fn(async () => auth.admin) }));
vi.mock("@/lib/gsc-sync", () => ({ getSeoSummary: vi.fn(async (days: number) => ({ connected: true, lastDay: "2026-10-06", days })) }));
const cfg = vi.hoisted(() => ({ result: { configured: false, missing: ["GSC_SERVICE_ACCOUNT_JSON", "GSC_SITE_URL"] } as unknown }));
vi.mock("@/lib/gsc-client", () => ({ readGscConfig: vi.fn(() => cfg.result) }));

import { GET } from "@/app/api/seo/summary/route";

const call = (qs = "") => GET(new Request(`http://x/api/seo/summary${qs}`));

beforeEach(() => {
  auth.authed = true;
  auth.admin = true;
  cfg.result = { configured: false, missing: ["GSC_SERVICE_ACCOUNT_JSON", "GSC_SITE_URL"] };
});

describe("GET /api/seo/summary", () => {
  it("requires a session and admin rights", async () => {
    auth.authed = false;
    expect((await call()).status).toBe(401);
    auth.authed = true;
    auth.admin = false;
    expect((await call()).status).toBe(403);
  });

  it("answers 'not configured' with what is missing, instead of an error", async () => {
    const body = await (await call()).json();
    expect(body.success).toBe(true);
    expect(body.data.configured).toBe(false);
    expect(body.data.missing).toEqual(["GSC_SERVICE_ACCOUNT_JSON", "GSC_SITE_URL"]);
  });

  it("clamps the period to 7-90 days and reports configured", async () => {
    cfg.result = { configured: true, config: {} };
    expect((await (await call("?days=1")).json()).data.summary.days).toBe(7);
    expect((await (await call("?days=500")).json()).data.summary.days).toBe(90);
    expect((await (await call("?days=28")).json()).data.configured).toBe(true);
  });
});
