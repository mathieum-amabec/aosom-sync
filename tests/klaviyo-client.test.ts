import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config", () => ({ env: { klaviyoApiKey: "pk_test_123" } }));

import { env } from "@/lib/config";
import { trackEvent, identifyProfile, isKlaviyoConfigured } from "@/lib/klaviyo-client";

const okRes = (status = 200) => ({ ok: status >= 200 && status < 300, status }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(okRes(200));
  vi.stubGlobal("fetch", fetchMock);
  (env as { klaviyoApiKey?: string }).klaviyoApiKey = "pk_test_123";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("klaviyo-client — trackEvent", () => {
  it("POSTs to /events/ with auth + revision headers and a profile-attached event", async () => {
    const res = await trackEvent("Price Drop", "shopper@example.com", { sku: "ABC", new_price: 9.99 });
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://a.klaviyo.com/api/events/");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Klaviyo-API-Key pk_test_123");
    expect(opts.headers.revision).toBe("2023-10-15");
    const body = JSON.parse(opts.body);
    expect(body.data.type).toBe("event");
    expect(body.data.attributes.metric.data.attributes.name).toBe("Price Drop");
    expect(body.data.attributes.profile.data.attributes.email).toBe("shopper@example.com");
    expect(body.data.attributes.properties).toEqual({ sku: "ABC", new_price: 9.99 });
  });

  it("rejects an invalid email without calling the API", async () => {
    const res = await trackEvent("Price Drop", "not-an-email", {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/invalid email/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a metric name", async () => {
    const res = await trackEvent("", "shopper@example.com");
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns ok:false with status on a non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce(okRes(400));
    const res = await trackEvent("Price Drop", "shopper@example.com");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
  });
});

describe("klaviyo-client — identifyProfile", () => {
  it("POSTs to /profiles/ with the email", async () => {
    const res = await identifyProfile("shopper@example.com", { Language: "fr" });
    expect(res.ok).toBe(true);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://a.klaviyo.com/api/profiles/");
    const body = JSON.parse(opts.body);
    expect(body.data.attributes.email).toBe("shopper@example.com");
    expect(body.data.attributes.properties).toEqual({ Language: "fr" });
  });

  it("treats 409 (already exists) as success", async () => {
    fetchMock.mockResolvedValueOnce(okRes(409));
    const res = await identifyProfile("shopper@example.com");
    expect(res.ok).toBe(true);
    expect(res.status).toBe(409);
  });
});

describe("klaviyo-client — no key configured", () => {
  beforeEach(() => {
    (env as { klaviyoApiKey?: string }).klaviyoApiKey = undefined;
  });

  it("isKlaviyoConfigured() is false and calls no-op", async () => {
    expect(isKlaviyoConfigured()).toBe(false);
    const res = await trackEvent("Price Drop", "shopper@example.com");
    expect(res).toEqual({ ok: false, skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("klaviyo-client — rate limiting", () => {
  it("spaces requests at least ~100ms apart (<=10 req/s)", async () => {
    const start = Date.now();
    await Promise.all([
      trackEvent("E", "a@example.com"),
      trackEvent("E", "b@example.com"),
      trackEvent("E", "c@example.com"),
    ]);
    const elapsed = Date.now() - start;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // 3 serialized requests → at least 2 gaps of ~100ms between them.
    expect(elapsed).toBeGreaterThanOrEqual(180);
  });
});
