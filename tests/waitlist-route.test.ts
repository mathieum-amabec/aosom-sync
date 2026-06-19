import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/database", () => ({
  getProduct: vi.fn(),
  upsertWaitlistEntry: vi.fn(),
}));
vi.mock("@/lib/klaviyo-client", () => ({
  identifyProfile: vi.fn().mockResolvedValue({ ok: true }),
  trackEvent: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/lib/rate-limiter", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/insights", () => ({ storeLink: vi.fn(() => ({ inStore: true, shopifyUrl: "https://ameublodirect.ca/products/chair" })) }));
vi.mock("@/lib/config", () => ({ getPublicAppUrl: () => "https://app.test" }));

import { POST, OPTIONS } from "@/app/api/waitlist/route";
import { getProduct, upsertWaitlistEntry } from "@/lib/database";
import { trackEvent } from "@/lib/klaviyo-client";
import { checkRateLimit } from "@/lib/rate-limiter";

const ALLOWED = { allowed: true, remaining: 9, retryAfterMs: 0 };
const BLOCKED = { allowed: false, remaining: 0, retryAfterMs: 5000 };

function post(body: unknown, origin = "https://ameublodirect.ca") {
  return new Request("https://aosom-sync.vercel.app/api/waitlist", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin, "x-forwarded-for": "1.2.3.4" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/waitlist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockReturnValue(ALLOWED);
    vi.mocked(getProduct).mockResolvedValue({ sku: "ABC", name: "Chaise", price: 99.99, shopify_product_id: "gid://x", shopify_handle: "chair" } as never);
  });

  it("accepts a valid signup, stores unconfirmed with a token, and emails confirmation", async () => {
    const res = await POST(post({ email: "Shopper@Example.com", sku: "ABC", shopify_product_id: "ignored" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toMatch(/confirm/i);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://ameublodirect.ca");

    // Email normalized; server-side shopify id preferred; stored unconfirmed with a token (double opt-in).
    expect(vi.mocked(upsertWaitlistEntry)).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "shopper@example.com",
        sku: "ABC",
        shopifyProductId: "gid://x",
        confirmToken: expect.any(String),
        tokenExpiresAt: expect.any(Number),
      }),
    );
    // Confirmation email event carries a confirm link to the confirm route.
    const ev = vi.mocked(trackEvent).mock.calls[0];
    expect(ev[0]).toBe("Back In Stock Confirmation");
    expect(ev[1]).toBe("shopper@example.com");
    expect(String((ev[2] as Record<string, unknown>).confirm_url)).toMatch(/\/api\/waitlist\/confirm\?token=/);
  });

  it("does not set CORS allow-origin for a non-allow-listed origin", async () => {
    const res = await POST(post({ email: "a@b.com", sku: "ABC" }, "https://evil.com"));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rejects an invalid email (400)", async () => {
    const res = await POST(post({ email: "nope", sku: "ABC" }));
    expect(res.status).toBe(400);
    expect(upsertWaitlistEntry).not.toHaveBeenCalled();
  });

  it("rejects a missing sku (400)", async () => {
    const res = await POST(post({ email: "a@b.com", sku: "  " }));
    expect(res.status).toBe(400);
  });

  it("404s for an unknown sku", async () => {
    vi.mocked(getProduct).mockResolvedValue(null);
    const res = await POST(post({ email: "a@b.com", sku: "NOPE" }));
    expect(res.status).toBe(404);
    expect(upsertWaitlistEntry).not.toHaveBeenCalled();
  });

  it("429s on the per-IP limit (first check)", async () => {
    vi.mocked(checkRateLimit).mockReturnValueOnce(BLOCKED);
    const res = await POST(post({ email: "a@b.com", sku: "ABC" }));
    expect(res.status).toBe(429);
    expect(upsertWaitlistEntry).not.toHaveBeenCalled();
  });

  it("429s on the per-(email,sku)-per-hour limit (second check)", async () => {
    vi.mocked(checkRateLimit).mockReturnValueOnce(ALLOWED).mockReturnValueOnce(BLOCKED);
    const res = await POST(post({ email: "a@b.com", sku: "ABC" }));
    expect(res.status).toBe(429);
    expect(upsertWaitlistEntry).not.toHaveBeenCalled();
  });

  it("succeeds even when Klaviyo tracking fails (best-effort)", async () => {
    vi.mocked(trackEvent).mockResolvedValue({ ok: false, skipped: true });
    const res = await POST(post({ email: "a@b.com", sku: "ABC" }));
    expect(res.status).toBe(200);
    expect(upsertWaitlistEntry).toHaveBeenCalled();
  });

  it("answers CORS preflight (OPTIONS)", async () => {
    const res = await OPTIONS(new Request("https://x/api/waitlist", { method: "OPTIONS", headers: { origin: "https://ameublodirect.ca" } }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://ameublodirect.ca");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});
