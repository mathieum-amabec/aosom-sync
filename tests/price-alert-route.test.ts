import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/database", () => ({
  getProduct: vi.fn(),
  upsertPriceAlert: vi.fn(),
  getTriggeredPriceAlerts: vi.fn(),
  markPriceAlertsNotified: vi.fn(),
  confirmPriceAlert: vi.fn(),
}));
vi.mock("@/lib/klaviyo-client", () => ({
  identifyProfile: vi.fn().mockResolvedValue({ ok: true }),
  trackEvent: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/lib/rate-limiter", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/config", () => ({ env: { cronSecret: "testsecret" }, getPublicAppUrl: () => "https://app.test" }));

import { POST, OPTIONS } from "@/app/api/price-alert/route";
import { GET as NOTIFY } from "@/app/api/price-alert/notify/route";
import { GET as CONFIRM } from "@/app/api/price-alert/confirm/route";
import { getProduct, upsertPriceAlert, getTriggeredPriceAlerts, markPriceAlertsNotified, confirmPriceAlert } from "@/lib/database";
import { trackEvent } from "@/lib/klaviyo-client";
import { checkRateLimit } from "@/lib/rate-limiter";

const ALLOWED = { allowed: true, remaining: 9, retryAfterMs: 0 };

function post(body: unknown, origin = "https://ameublodirect.ca") {
  return new Request("https://aosom-sync.vercel.app/api/price-alert", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin, "x-forwarded-for": "1.2.3.4" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/price-alert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkRateLimit).mockReturnValue(ALLOWED);
    vi.mocked(getProduct).mockResolvedValue({ sku: "ABC", price: 99.99, shopify_product_id: "gid://x" } as never);
  });

  it("accepts a valid signup, upserts with a confirm token, and emails confirmation", async () => {
    const res = await POST(post({ email: "Shopper@Example.com", sku: "ABC", price: 99.99 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.message).toMatch(/confirm/i);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://ameublodirect.ca");

    // Stored unconfirmed with a token (double opt-in); price from server, email normalized.
    expect(vi.mocked(upsertPriceAlert)).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "shopper@example.com",
        sku: "ABC",
        shopifyProductId: "gid://x",
        priceAtSignup: 99.99,
        confirmToken: expect.any(String),
        tokenExpiresAt: expect.any(Number),
      }),
    );
    // Confirmation email event carries a confirm link to the confirm route.
    const ev = vi.mocked(trackEvent).mock.calls[0];
    expect(ev[0]).toBe("Price Alert Confirmation");
    expect(ev[1]).toBe("shopper@example.com");
    expect(String((ev[2] as Record<string, unknown>).confirm_url)).toMatch(/\/api\/price-alert\/confirm\?token=/);
  });

  it("does not set CORS allow-origin for a non-allow-listed origin", async () => {
    const res = await POST(post({ email: "a@b.com", sku: "ABC", price: 10 }, "https://evil.com"));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rejects an invalid email (400)", async () => {
    const res = await POST(post({ email: "nope", sku: "ABC", price: 10 }));
    expect(res.status).toBe(400);
    expect(upsertPriceAlert).not.toHaveBeenCalled();
  });

  it("rejects a bad price (400)", async () => {
    const res = await POST(post({ email: "a@b.com", sku: "ABC", price: 0 }));
    expect(res.status).toBe(400);
  });

  it("404s for an unknown sku", async () => {
    vi.mocked(getProduct).mockResolvedValue(null);
    const res = await POST(post({ email: "a@b.com", sku: "NOPE", price: 10 }));
    expect(res.status).toBe(404);
    expect(upsertPriceAlert).not.toHaveBeenCalled();
  });

  it("429s when rate-limited", async () => {
    vi.mocked(checkRateLimit).mockReturnValue({ allowed: false, remaining: 0, retryAfterMs: 5000 });
    const res = await POST(post({ email: "a@b.com", sku: "ABC", price: 10 }));
    expect(res.status).toBe(429);
  });

  it("answers CORS preflight (OPTIONS)", async () => {
    const res = await OPTIONS(new Request("https://x/api/price-alert", { method: "OPTIONS", headers: { origin: "https://ameublodirect.ca" } }));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://ameublodirect.ca");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});

describe("GET /api/price-alert/notify (cron)", () => {
  const cron = (secret: string | null) =>
    new Request("https://x/api/price-alert/notify", secret ? { headers: { authorization: `Bearer ${secret}` } } : {});

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(trackEvent).mockResolvedValue({ ok: true });
  });

  it("401s without the cron secret", async () => {
    expect((await NOTIFY(cron(null))).status).toBe(401);
    expect((await NOTIFY(cron("wrong-but-same-length-secret!"))).status).toBe(401);
  });

  it("fires a Price Drop Alert per triggered alert and marks them notified", async () => {
    vi.mocked(getTriggeredPriceAlerts).mockResolvedValue([
      { id: 1, email: "a@b.com", sku: "ABC", priceAtSignup: 100, currentPrice: 80, productName: "Chair", shopifyHandle: "chair" },
      { id: 2, email: "c@d.com", sku: "XYZ", priceAtSignup: 50, currentPrice: 40, productName: "Lamp", shopifyHandle: null },
    ]);
    const res = await NOTIFY(cron("testsecret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, triggered: 2, notified: 2 });
    expect(trackEvent).toHaveBeenCalledTimes(2);
    expect(trackEvent).toHaveBeenCalledWith("Price Drop Alert", "a@b.com", expect.objectContaining({
      sku: "ABC", old_price: 100, new_price: 80, product_url: "https://ameublodirect.ca/products/chair",
    }));
    expect(markPriceAlertsNotified).toHaveBeenCalledWith([1, 2]);
  });

  it("leaves an alert pending (does not mark notified) when the event fails", async () => {
    vi.mocked(getTriggeredPriceAlerts).mockResolvedValue([
      { id: 7, email: "a@b.com", sku: "ABC", priceAtSignup: 100, currentPrice: 80, productName: "Chair", shopifyHandle: "chair" },
    ]);
    vi.mocked(trackEvent).mockResolvedValue({ ok: false, skipped: true });
    const res = await NOTIFY(cron("testsecret"));
    expect(await res.json()).toMatchObject({ triggered: 1, notified: 0, failed: 1 });
    expect(markPriceAlertsNotified).toHaveBeenCalledWith([]);
  });
});

describe("GET /api/price-alert/confirm (double opt-in)", () => {
  const get = (qs: string) => new Request(`https://app.test/api/price-alert/confirm?${qs}`);
  beforeEach(() => vi.clearAllMocks());

  it("confirms a valid token and 302-redirects to the product page", async () => {
    vi.mocked(confirmPriceAlert).mockResolvedValue({ sku: "ABC", shopifyHandle: "chair" });
    const res = await CONFIRM(get("token=good-token"));
    expect(confirmPriceAlert).toHaveBeenCalledWith("good-token");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://ameublodirect.ca/products/chair?price_alert=confirmed");
  });

  it("redirects to the storefront home when the product has no handle", async () => {
    vi.mocked(confirmPriceAlert).mockResolvedValue({ sku: "ABC", shopifyHandle: null });
    const res = await CONFIRM(get("token=good"));
    expect(res.status).toBe(302);
    // new URL() normalizes the bare origin to include a trailing slash before the query.
    expect(res.headers.get("location")).toBe("https://ameublodirect.ca/?price_alert=confirmed");
  });

  it("shows a 400 error page for an invalid/expired token", async () => {
    vi.mocked(confirmPriceAlert).mockResolvedValue(null);
    const res = await CONFIRM(get("token=bad"));
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("shows the error page when no token is supplied (no DB hit)", async () => {
    const res = await CONFIRM(get("foo=bar"));
    expect(res.status).toBe(400);
    expect(confirmPriceAlert).not.toHaveBeenCalled();
  });
});
