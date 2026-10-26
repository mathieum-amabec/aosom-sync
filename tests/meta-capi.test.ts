import { describe, it, expect, vi } from "vitest";
import crypto from "crypto";
import {
  buildUserData, normalize, purchaseEventFromOrder, purchaseEventId, isPaidOrder, sendCapiEvents, type ShopifyOrderLike,
} from "@/lib/meta-capi";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

describe("normalize", () => {
  it("follows Meta rules", () => {
    expect(normalize.email("  Foo@Bar.COM ")).toBe("foo@bar.com");
    expect(normalize.phone("(514) 555-1234")).toBe("15145551234");
    expect(normalize.phone("+1 514 555 1234")).toBe("15145551234");
    expect(normalize.city("Saint-Jérôme")).toBe("saintjérôme");
    expect(normalize.zip("H2X 1Y4")).toBe("h2x1y4");
    expect(normalize.country("CA")).toBe("ca");
  });
});

describe("buildUserData", () => {
  it("hashes PII, leaves ip/ua/fbp/fbc raw, drops empties", () => {
    const u = buildUserData({ email: "A@b.com", firstName: "", ip: "1.2.3.4", userAgent: "UA", fbp: "fb.1.1700000000000.123456", country: "CA" });
    expect(u.em).toEqual([sha("a@b.com")]);
    expect(u.country).toEqual([sha("ca")]);
    expect(u.fn).toBeUndefined();
    expect(u.client_ip_address).toBe("1.2.3.4");
    expect(u.client_user_agent).toBe("UA");
    expect(u.fbp).toBe("fb.1.1700000000000.123456");
  });
});

const order: ShopifyOrderLike = {
  id: 123456789, checkout_token: "tok_abc", created_at: "2026-10-26T12:00:00Z", total_price: "199.99", currency: "CAD",
  financial_status: "paid", email: "Buyer@Example.com", customer: { id: 77, first_name: "Ann", last_name: "Lee" },
  shipping_address: { city: "Laval", province_code: "QC", zip: "H7A 1A1", country_code: "CA" },
  client_details: { browser_ip: "9.9.9.9", user_agent: "Mozilla" },
  line_items: [{ sku: "01-0901", quantity: 2, price: "50.00" }, { sku: null, quantity: 1, price: "1" }],
  order_status_url: "https://furnishdirect.ca/123/orders/x/authenticate",
};

describe("purchaseEventFromOrder", () => {
  it("uses checkout_token as event_id (matches browser eid)", () => {
    expect(purchaseEventId(order)).toBe("tok_abc");
    expect(purchaseEventId({ id: 5, checkout_token: null })).toBe("order_5");
  });
  it("builds a Purchase with SKU content_ids and hashed user data", () => {
    const e = purchaseEventFromOrder(order);
    expect(e.event_name).toBe("Purchase");
    expect(e.event_id).toBe("tok_abc");
    expect(e.event_source_url).toBe("https://furnishdirect.ca/");
    expect(e.custom_data).toMatchObject({ value: 199.99, currency: "CAD", content_ids: ["01-0901"], num_items: 2, order_id: "123456789" });
    expect(e.user_data.em).toEqual([sha("buyer@example.com")]);
    expect(e.user_data.client_ip_address).toBe("9.9.9.9");
    expect(e.event_time).toBe(Math.floor(Date.parse("2026-10-26T12:00:00Z") / 1000));
  });
});

describe("isPaidOrder", () => {
  it("rejects test and unpaid orders", () => {
    expect(isPaidOrder({ financial_status: "paid", test: false })).toBe(true);
    expect(isPaidOrder({ financial_status: "paid", test: true })).toBe(false);
    expect(isPaidOrder({ financial_status: "pending", test: false })).toBe(false);
  });
});

describe("sendCapiEvents", () => {
  it("posts to the pixel endpoint with test_event_code when given", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }));
    const r = await sendCapiEvents([purchaseEventFromOrder(order)], { pixelId: "214720653324969", accessToken: "T", testEventCode: "TEST1", fetchImpl: f as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: true, received: 1 });
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toContain("/214720653324969/events?access_token=T");
    expect(JSON.parse(init.body).test_event_code).toBe("TEST1");
  });
  it("surfaces Meta errors", async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "bad token" } }), { status: 400 }));
    const r = await sendCapiEvents([], { pixelId: "1", accessToken: "T", fetchImpl: f as unknown as typeof fetch });
    expect(r).toMatchObject({ ok: false, status: 400, error: "bad token" });
  });
});
