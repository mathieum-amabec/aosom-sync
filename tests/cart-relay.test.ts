import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseCartEvent, selectCarts, groupCarts, renderItemsHtml, buildTemplateHtml, cartSubject, subscriptionAllows, pruneState, emptyState,
  storefrontUrl, ENABLED_KEY, type CartEvent, type SelectCtx,
} from "@/lib/cart-relay";

const now = new Date("2026-10-22T20:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60e3).toISOString();
const ev = (o: Partial<CartEvent> = {}, item: Partial<CartEvent["item"]> = {}): CartEvent => ({
  eventId: "e1", profileId: "p1", email: "client@gmail.com", at: ago(5 * 60), locale: "fr",
  item: { title: "Armoire haute — Blanc", quantity: 1, price: 270.99, image: null, url: "https://ameublodirect.ca/products/armoire?variant=1", variantId: "v1", ...item }, ...o,
});
const ctx = (o: Partial<SelectCtx> = {}): SelectCtx => ({
  state: emptyState(), relanceProfiles: {}, checkoutAfter: () => false, orderedAfter: () => false, canEmail: () => true, ...o,
});
const reasons = (events: CartEvent[], c: SelectCtx) => selectCarts(events, c, now).skipped.map((s) => s.reason);

describe("parseCartEvent", () => {
  const raw = (props: Record<string, unknown>) => ({ id: "x1", relationships: { profile: { data: { id: "p9" } } }, attributes: { datetime: ago(300), event_properties: props } });
  it("reads Shopify's Added to Cart payload and serves the public domain", () => {
    const e = parseCartEvent(raw({
      "Product Name": "Chaise", "Variant Name": "Gris", Price: 99.5, Quantity: 2, VariantID: "77",
      URL: "https://27u5y2-kp.myshopify.com/products/chaise?utm=x&variant=77", ImageURL: "https://cdn.shopify.com/s/files/a/chaise.jpg?v=1",
    }), "a@b.co")!;
    expect(e.item).toMatchObject({ title: "Chaise — Gris", quantity: 2, price: 99.5, variantId: "77", url: "https://ameublodirect.ca/products/chaise?variant=77", image: "https://cdn.shopify.com/s/files/a/chaise_x300.jpg?v=1" });
    expect(e.locale).toBeNull();
  });
  it("never invents a price", () => {
    expect(parseCartEvent(raw({ "Product Name": "Chaise", Price: null }), "a@b.co")!.item.price).toBeNull();
    expect(parseCartEvent(raw({ "Product Name": "Chaise", Price: 0 }), "a@b.co")!.item.price).toBeNull();
  });
  it("drops non-shop links and non-Shopify images; Default Title is not a colour", () => {
    expect(storefrontUrl("javascript:alert(1)")).toBeNull();
    expect(storefrontUrl("https://evil.example/products/x")).toBeNull();
    const e = parseCartEvent(raw({ "Product Name": "Chaise", "Variant Name": "Default Title", ImageURL: "https://evil.example/a.jpg", URL: "http://ameublodirect.ca/p" }), "a@b.co")!;
    expect(e.item).toMatchObject({ title: "Chaise", image: null, url: null });
  });
  it("detects English from the /en storefront path or Customer Locale", () => {
    expect(parseCartEvent(raw({ "Product Name": "Chair", URL: "https://ameublodirect.ca/en/products/chair" }), null)!.locale).toBe("en");
    expect(parseCartEvent(raw({ "Product Name": "Chair", "Customer Locale": "en-CA" }), null)!.locale).toBe("en");
    expect(parseCartEvent(raw({ "Product Name": "Chair", "Customer Locale": "fr-CA" }), null)!.locale).toBe("fr");
  });
});

describe("selectCarts", () => {
  it("emails an old-enough cart with an identified, subscribed shopper", () => {
    const r = selectCarts([ev()], ctx(), now);
    expect(r.send).toHaveLength(1);
    expect(r.send[0].items).toHaveLength(1);
  });
  it("waits 3 h (not final) and drops carts older than 48 h (final)", () => {
    const r = selectCarts([ev({ eventId: "a", at: ago(60) }), ev({ eventId: "b", profileId: "p2", at: ago(60 * 50) })], ctx(), now);
    expect(r.send).toHaveLength(0);
    expect(r.skipped).toEqual([
      { cartId: "b", eventIds: ["b"], reason: "too-old", final: true },
      { cartId: "a", eventIds: ["a"], reason: "too-recent", final: false },
    ]);
  });
  it("a fresh add-to-cart restarts the wait of the whole cart", () => {
    expect(reasons([ev({ eventId: "old", at: ago(600) }), ev({ eventId: "new", at: ago(30) }, { variantId: "v2" })], ctx())).toEqual(["too-recent"]);
  });
  it("skips a shopper who started a checkout after the cart (relance-paiement owns it)", () => {
    expect(reasons([ev()], ctx({ checkoutAfter: () => true }))).toEqual(["checkout-after"]);
  });
  it("skips a shopper who ordered", () => {
    expect(reasons([ev()], ctx({ orderedAfter: () => true }))).toEqual(["ordered"]);
  });
  it("checks the checkout against the cart's first add, with 5 min tolerance", () => {
    const seen: string[] = [];
    selectCarts([ev({ eventId: "a", at: ago(600) }), ev({ eventId: "b", at: ago(400) }, { variantId: "v2" })], ctx({ checkoutAfter: (_p, iso) => (seen.push(iso), false) }), now);
    expect(seen[0]).toBe(new Date(now.getTime() - 605 * 60e3).toISOString());
  });
  it("skips suppressed / unsubscribed / unknown-consent profiles", () => {
    expect(reasons([ev()], ctx({ canEmail: () => false }))).toEqual(["no-consent"]);
    expect(subscriptionAllows({ email: { marketing: { can_receive_email_marketing: true, consent: "NEVER_SUBSCRIBED", suppression: [] } } })).toBe(true);
    expect(subscriptionAllows({ email: { marketing: { can_receive_email_marketing: true, consent: "SUBSCRIBED", suppression: [{ reason: "USER_SUPPRESSED" }] } } })).toBe(false);
    expect(subscriptionAllows({ email: { marketing: { can_receive_email_marketing: true, consent: "UNSUBSCRIBED" } } })).toBe(false);
    expect(subscriptionAllows({ email: { marketing: { can_receive_email_marketing: false, consent: "SUBSCRIBED" } } })).toBe(false);
    expect(subscriptionAllows(undefined)).toBe(false);
  });
  it("honours the 7-day per-profile cooldown of this relay", () => {
    const state = { ...emptyState(), profiles: { p1: ago(60 * 24 * 3) } };
    expect(reasons([ev()], ctx({ state }))).toEqual(["cooldown"]);
    expect(selectCarts([ev()], ctx({ state: { ...emptyState(), profiles: { p1: ago(60 * 24 * 8) } } }), now).send).toHaveLength(1);
  });
  it("skips a profile relance-paiement reminded in the last 72 h, not longer", () => {
    expect(reasons([ev()], ctx({ relanceProfiles: { p1: ago(60 * 24) } }))).toEqual(["relance-paiement"]);
    expect(reasons([ev()], ctx({ relanceProfiles: { p1: ago(60 * 71) } }))).toEqual(["relance-paiement"]);
    // 2026-10-31 regression: a checkout reminder 3–7 days old used to block the cart email.
    expect(selectCarts([ev()], ctx({ relanceProfiles: { p1: ago(60 * 73) } }), now).send).toHaveLength(1);
    expect(selectCarts([ev()], ctx({ relanceProfiles: { p1: ago(60 * 24 * 5) } }), now).send).toHaveLength(1);
  });
  it("never emails the same cart twice, nor an address without email or an internal one", () => {
    expect(reasons([ev()], ctx({ state: { ...emptyState(), events: { e1: ago(10) } } }))).toEqual(["done"]);
    expect(reasons([ev({ email: null })], ctx())).toEqual(["no-email"]);
    expect(reasons([ev({ email: "qa-roue@ameublodirect.ca" })], ctx())).toEqual(["internal"]);
  });
  it("sends one email per profile for the whole cart, one line per variant", () => {
    const r = selectCarts([
      ev({ eventId: "a", at: ago(600) }), ev({ eventId: "b", at: ago(500) }, { variantId: "v2", title: "Table" }), ev({ eventId: "c", at: ago(400) }),
    ], ctx(), now);
    expect(r.send).toHaveLength(1);
    expect(r.send[0].eventIds.sort()).toEqual(["a", "b", "c"]);
    expect(r.send[0].items.map((i) => i.variantId).sort()).toEqual(["v1", "v2"]);
  });
  it("caps the batch and leaves the rest for the next run", () => {
    const evs = ["a", "b", "c"].map((id) => ev({ eventId: id, profileId: `p-${id}` }));
    const r = selectCarts(evs, ctx({ limit: 2 }), now);
    expect(r.send).toHaveLength(2);
    expect(r.skipped).toEqual([expect.objectContaining({ final: false })]);
  });
  it("groupCarts takes the profile locale when events carry none, FR otherwise", () => {
    expect(groupCarts([ev({ locale: null })], now, () => "en")[0].locale).toBe("en");
    expect(groupCarts([ev({ locale: null })], now)[0].locale).toBe("fr");
  });
});

describe("rendering", () => {
  const cart = (locale: "fr" | "en") => ({ locale, items: [{ title: "Table <b>", quantity: 2, price: 10, image: null, url: "https://ameublodirect.ca/products/t", variantId: "1" }] });
  it("escapes titles, shows quantity and a localized price", () => {
    const fr = renderItemsHtml(cart("fr"));
    expect(fr).toContain("Table &lt;b&gt;");
    expect(fr).toContain("2 × 10,00 $");
    expect(renderItemsHtml(cart("en"))).toContain("2 × $10.00");
  });
  it("omits the price line when the event has none instead of inventing one", () => {
    const h = renderItemsHtml({ locale: "fr", items: [{ title: "Chaise", quantity: 1, price: null, image: null, url: null, variantId: "1" }] });
    expect(h).toContain("Chaise");
    expect(h).not.toMatch(/\$/);
  });
  it("FR and EN templates carry the per-person blocks and the localized unsubscribe tag", () => {
    for (const l of ["fr", "en"] as const) {
      const h = buildTemplateHtml(l);
      expect(h).toContain("cart_relay_items_html");
      expect(h).toContain("cart_relay_url");
      expect(h).toContain(`<html lang="${l}">`);
      expect(h).toContain(l === "fr" ? "{% unsubscribe 'Se désabonner' %}" : "{% unsubscribe 'Unsubscribe' %}");
      expect(h).toContain(l === "fr" ? "Livraison gratuite partout au Canada" : "Free shipping anywhere in Canada");
    }
    expect(cartSubject("fr").subject).toContain("panier");
    expect(cartSubject("en").subject).toContain("cart");
  });
  it("uses the Black Friday subject only Nov 20–30 (Toronto date), still without promising a discount", () => {
    const bf = cartSubject("fr", new Date("2026-11-27T15:00:00Z"));
    expect(bf.subject).toContain("Vendredi fou");
    expect(cartSubject("en", new Date("2026-11-30T20:00:00Z")).subject).toContain("Black Friday");
    // 2026-11-20 00:30 Toronto = 05:30 UTC → in; 2026-12-01 03:00 UTC is still Nov 30 in Toronto → in
    expect(cartSubject("fr", new Date("2026-11-20T05:30:00Z")).subject).toContain("Vendredi fou");
    expect(cartSubject("fr", new Date("2026-12-01T03:00:00Z")).subject).toContain("Vendredi fou");
    expect(cartSubject("fr", new Date("2026-12-01T06:00:00Z")).subject).not.toContain("Vendredi fou");
    expect(cartSubject("fr", new Date("2026-11-19T12:00:00Z")).subject).not.toContain("Vendredi fou");
    const all = [bf.subject, bf.preview, cartSubject("en", new Date("2026-11-27T15:00:00Z")).preview].join("\n");
    expect(all).not.toMatch(/rabais|discount|promo|coupon|code /i);
  });
  it("never names a supplier, and offers no discount or code", () => {
    const all = [buildTemplateHtml("fr"), buildTemplateHtml("en"), cartSubject("fr").subject, cartSubject("fr").preview, cartSubject("en").subject, cartSubject("en").preview].join("\n");
    expect(all).not.toMatch(/aosom|homcom|outsunny|pawhut|costway|wayfair/i);
    expect(all).not.toMatch(/rabais|discount|promo|coupon|code /i);
  });
  it("prunes old bookkeeping", () => {
    const s = pruneState({ ...emptyState(), events: { a: ago(60 * 24 * 9), b: ago(5) }, sentLog: [ago(60 * 30), ago(5)] }, now);
    expect(s.events).toEqual({ b: ago(5) });
    expect(s.sentLog).toEqual([ago(5)]);
  });
});

// ── the route: flag OFF means no send ──────────────────────────────────
const m = vi.hoisted(() => ({ setting: null as string | null, sends: 0, lease: 0 }));
vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: () => true }));
vi.mock("@/lib/cron-tracking", () => ({ trackCron: (_n: string, fn: () => unknown) => fn() }));
vi.mock("@/lib/database", () => ({
  getSetting: async (k: string) => (k === "cart_relay_enabled" ? m.setting : null),
  setSetting: async () => {}, acquireLease: async () => (m.lease++, "lease"), releaseLease: async () => {},
}));
vi.mock("@/lib/klaviyo-campaigns", () => ({
  RELAY_LEASE_KEY: "k", RELAY_LEASE_TTL_S: 1, metricEvents: async () => ({ events: [], emails: new Map() }), kv: async () => { m.sends++; return {}; }, sendCampaign: async () => { m.sends++; return {}; },
  assertRenders: async () => {}, campaignStatus: async () => "Sent", cleanupLists: async () => 0, createList: async () => "l", shouldRetry: () => false,
  stillInFlight: () => false, waitForLists: async () => {},
}));
vi.mock("@/lib/relance-paiement", async (orig) => ({
  ...(await orig<typeof import("@/lib/relance-paiement")>()), metricId: async (n: string) => n, recentEvents: async () => { m.sends++; return { events: [], emails: new Map() }; },
}));

describe("cron route flag", () => {
  beforeEach(() => { m.setting = null; m.sends = 0; m.lease = 0; });
  it("is OFF by default: no setting, no Klaviyo call, no lease", async () => {
    const { GET } = await import("@/app/api/cron/cart-relay/route");
    const res = await GET(new Request("https://x/api/cron/cart-relay"));
    expect(await res.json()).toEqual({ success: true, skipped: "disabled" });
    expect(m.sends).toBe(0);
    expect(m.lease).toBe(0);
  });
  it("stays off for any value other than 1", async () => {
    m.setting = "true";
    const { GET } = await import("@/app/api/cron/cart-relay/route");
    expect(await (await GET(new Request("https://x/api/cron/cart-relay"))).json()).toMatchObject({ skipped: "disabled" });
    expect(ENABLED_KEY).toBe("cart_relay_enabled");
  });
  it("dry run reads but never takes the lease nor sends", async () => {
    const { GET } = await import("@/app/api/cron/cart-relay/route");
    const j = await (await GET(new Request("https://x/api/cron/cart-relay?dryRun=1"))).json();
    expect(j).toMatchObject({ success: true, dryRun: true, enabled: false, wouldSend: [] });
    expect(m.lease).toBe(0);
  });
});
