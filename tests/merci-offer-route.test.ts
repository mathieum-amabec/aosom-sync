import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/rate-limiter", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/post-purchase/offer-service", () => ({ getOrCreateOffer: vi.fn() }));

import { POST, OPTIONS, maxDuration } from "@/app/api/merci/offer/route";
import { checkRateLimit } from "@/lib/rate-limiter";
import { getOrCreateOffer } from "@/lib/post-purchase/offer-service";
import { signSessionToken } from "@/lib/post-purchase/session-token";

const SECRET = "shpss_test";
const nowSec = () => Math.floor(Date.now() / 1000);
const good = (extra: Record<string, unknown> = {}) => signSessionToken({ dest: "27u5y2-kp.myshopify.com", aud: "client-1", exp: nowSec() + 300, nbf: nowSec() - 5, ...extra }, SECRET);

function req(body: unknown, token: string | null = good()) {
  return new Request("https://aosom-sync.vercel.app/api/merci/offer", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), "x-real-ip": "1.2.3.4" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/merci/offer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SHOPIFY_MERCI_APP_SECRET = SECRET;
    process.env.SHOPIFY_MERCI_APP_CLIENT_ID = "client-1";
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: true, remaining: 10, retryAfterMs: 0 });
    vi.mocked(getOrCreateOffer).mockResolvedValue({ status: 200, body: { expiresAt: "2026-11-21T15:30:00.000Z", offers: [] } });
  });
  afterEach(() => {
    delete process.env.SHOPIFY_MERCI_APP_SECRET;
    delete process.env.SHOPIFY_MERCI_APP_CLIENT_ID;
  });

  it("valid token → delegates with the order id, CORS * (extensions run in a worker)", async () => {
    const res = await POST(req({ orderId: "gid://shopify/OrderIdentity/6001" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(getOrCreateOffer).toHaveBeenCalledWith("gid://shopify/OrderIdentity/6001", { sub: null, confirmationNumber: null });
  });
  it("#5 passes the token's customer and the confirmation number; 403 goes back to the block", async () => {
    vi.mocked(getOrCreateOffer).mockResolvedValue({ status: 403, body: { error: "order" } });
    const res = await POST(req({ orderId: "1", confirmationNumber: "L8UWCL9KC" }, good({ sub: "gid://shopify/Customer/77" })));
    expect(res.status).toBe(403);
    expect(getOrCreateOffer).toHaveBeenCalledWith("1", { sub: "gid://shopify/Customer/77", confirmationNumber: "L8UWCL9KC" });
  });
  it("#8 the route is capped at 30 s", () => {
    expect(maxDuration).toBe(30);
  });
  it("passes 202 through so the extension retries", async () => {
    vi.mocked(getOrCreateOffer).mockResolvedValue({ status: 202, body: { pending: true } });
    expect((await POST(req({ orderId: "1" }))).status).toBe(202);
  });
  it("401 without a token or with a forged one", async () => {
    expect((await POST(req({ orderId: "1" }, null))).status).toBe(401);
    const forged = signSessionToken({ dest: "27u5y2-kp.myshopify.com", aud: "client-1", exp: nowSec() + 300 }, "wrong");
    expect((await POST(req({ orderId: "1" }, forged))).status).toBe(401);
    expect(getOrCreateOffer).not.toHaveBeenCalled();
  });
  it("503 when the app secret is not configured (block renders nothing)", async () => {
    delete process.env.SHOPIFY_MERCI_APP_SECRET;
    expect((await POST(req({ orderId: "1" }))).status).toBe(503);
  });
  it("400 on bad JSON or missing orderId; 429 when rate-limited", async () => {
    expect((await POST(req("{nope"))).status).toBe(400);
    expect((await POST(req({}))).status).toBe(400);
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    expect((await POST(req({ orderId: "1" }))).status).toBe(429);
  });
  it("500 (not a crash) when the service throws", async () => {
    vi.mocked(getOrCreateOffer).mockRejectedValue(new Error("db down"));
    expect((await POST(req({ orderId: "1" }))).status).toBe(500);
  });
  it("OPTIONS preflight allows Authorization", async () => {
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
  });
});
