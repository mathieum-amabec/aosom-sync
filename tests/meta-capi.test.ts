import { describe, it, expect, vi } from "vitest";
import crypto from "crypto";
import {
  buildUserData, clickIdsFromOrder, normalize, purchaseEventFromOrder, purchaseEventId, isPaidOrder, sendCapiEvents, type ShopifyOrderLike,
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

describe("clickIdsFromOrder", () => {
  const MS = 1_730_000_000_000;
  const FBP = "fb.1.1700000000000.1234567890";
  const FBC = "fb.1.1700000000000.AbC_dEf-123";

  it("reads fbp/fbc from the hidden cart attributes", () => {
    const ids = clickIdsFromOrder({ note_attributes: [{ name: "_fbp", value: FBP }, { name: "_fbc", value: FBC }, { name: "gift", value: "x" }] }, MS);
    expect(ids).toEqual({ fbp: FBP, fbc: FBC });
  });
  it("prefers the cart fbc over landing_site", () => {
    const ids = clickIdsFromOrder({ note_attributes: [{ name: "_fbc", value: FBC }], landing_site: "/p?fbclid=OTHER1234" }, MS);
    expect(ids.fbc).toBe(FBC);
  });
  it("rebuilds fbc from landing_site, keeping the fbclid's exact case", () => {
    const ids = clickIdsFromOrder({ landing_site: "/products/x?variant=1&utm_source=facebook&fbclid=IwZXh0bgNhZW0B_aEm-xY&utm_id=2" }, MS);
    expect(ids).toEqual({ fbp: null, fbc: `fb.1.${MS}.IwZXh0bgNhZW0B_aEm-xY` });
  });
  it("discards an fbclid cut off by Shopify's 255-character landing_site cap", () => {
    const head = "/products/table-a-cafe-ronde-80-cm?variant=43125221982313&media_type=image&utm_source=facebook&utm_medium=paid&utm_campaign=advantage_ventes_qc_on_saute_2026&fbclid=";
    const site = head + "IwZXh0bgNhZW0B".repeat(10).slice(0, 255 - head.length);
    expect(site).toHaveLength(255);
    expect(clickIdsFromOrder({ landing_site: site }, MS).fbc).toBeNull();
  });
  it("keeps an fbclid at the cap when other parameters prove it ended", () => {
    const tail = "&utm_id=2";
    const head = "/products/table-a-cafe-ronde-80-cm?variant=43125221982313&media_type=image&utm_source=facebook&utm_medium=paid&fbclid=";
    const id = "IwZXh0bgNhZW0B".repeat(20).slice(0, 255 - head.length - tail.length);
    expect(head.length + id.length + tail.length).toBe(255);
    expect(clickIdsFromOrder({ landing_site: head + id + tail }, MS).fbc).toBe(`fb.1.${MS}.${id}`);
  });
  it("keeps an fbclid that ends a short landing_site", () => {
    expect(clickIdsFromOrder({ landing_site: "/p?fbclid=IwZXh0bgNhZW0B" }, MS).fbc).toBe(`fb.1.${MS}.IwZXh0bgNhZW0B`);
  });
  it("treats a terminal fbclid just under the cap as cut off too", () => {
    const padded = `/${"p".repeat(252 - "?fbclid=IwZXh0bgNhZW0B".length - 1)}?fbclid=IwZXh0bgNhZW0B`;
    expect(padded).toHaveLength(252);
    expect(clickIdsFromOrder({ landing_site: padded }, MS).fbc).toBeNull();
  });
  it("decodes a percent-encoded fbclid", () => {
    expect(clickIdsFromOrder({ landing_site: "/p?fbclid=IwZXh0%2DbgNhZW0B" }, MS).fbc).toBe(`fb.1.${MS}.IwZXh0-bgNhZW0B`);
  });
  it("allows a day of clock skew on a cart fbc, but no more", () => {
    const at = (ms: number) => clickIdsFromOrder({ note_attributes: [{ name: "_fbc", value: `fb.1.${ms}.AbC_dEf-123` }] }, MS).fbc;
    expect(at(MS + 3_600_000)).toBe(`fb.1.${MS + 3_600_000}.AbC_dEf-123`);
    expect(at(MS + 2 * 86_400_000)).toBeNull();
  });
  it("rejects a cart fbc claiming to be created after the order, then tries landing_site", () => {
    const ids = clickIdsFromOrder({ note_attributes: [{ name: "_fbc", value: "fb.1.9999999999999.AbC_dEf-123" }], landing_site: "/p?fbclid=IwZXh0bgNhZW0B" }, MS);
    expect(ids.fbc).toBe(`fb.1.${MS}.IwZXh0bgNhZW0B`);
  });
  it("leaves event_id unchanged when click ids are present, so deduplication holds", () => {
    const e = purchaseEventFromOrder({ ...order, note_attributes: [{ name: "_fbp", value: FBP }, { name: "_fbc", value: FBC }] });
    expect(e.event_id).toBe("tok_abc");
    expect(e.event_name).toBe("Purchase");
  });
  it("does not mistake a similarly named parameter for fbclid", () => {
    expect(clickIdsFromOrder({ landing_site: "/p?xfbclid=IwZXh0bgNhZW0B" }, MS).fbc).toBeNull();
  });
  it("drops values that are not Meta-shaped", () => {
    const ids = clickIdsFromOrder({ note_attributes: [{ name: "_fbp", value: "<script>" }, { name: "_fbc", value: 42 }], landing_site: "/p?fbclid=%E0%A4%A" }, MS);
    expect(ids).toEqual({ fbp: null, fbc: null });
  });
  it("copes with an order that has neither", () => {
    expect(clickIdsFromOrder({ note_attributes: null, landing_site: null }, MS)).toEqual({ fbp: null, fbc: null });
  });
  it("puts them unhashed in the Purchase user_data, stamped with the event time", () => {
    const e = purchaseEventFromOrder({ ...order, note_attributes: [{ name: "_fbp", value: FBP }], landing_site: "/?fbclid=IwZXh0bgNhZW0B" });
    expect(e.user_data.fbp).toBe(FBP);
    expect(e.user_data.fbc).toBe(`fb.1.${e.event_time * 1000}.IwZXh0bgNhZW0B`);
  });
  it("leaves them out when the order has none", () => {
    const e = purchaseEventFromOrder(order);
    expect(e.user_data.fbp).toBeUndefined();
    expect(e.user_data.fbc).toBeUndefined();
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
