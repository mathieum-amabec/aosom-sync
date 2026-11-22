import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/database", () => ({ getSetting: vi.fn() }));
vi.mock("@/lib/post-purchase/order", async (orig) => {
  const real = await orig<typeof import("@/lib/post-purchase/order")>();
  return { ...real, fetchMerciOrder: vi.fn() };
});
vi.mock("@/lib/post-purchase/store", () => ({
  loadCandidates: vi.fn(),
  catalogueColour: vi.fn(),
  getOfferRow: vi.fn(),
  reserveOffer: vi.fn(),
  takeStaleReservation: vi.fn(),
  finishOffer: vi.fn(),
  releaseOffer: vi.fn(),
}));
vi.mock("@/lib/post-purchase/discount", () => ({ createMerciDiscount: vi.fn() }));
vi.mock("@/lib/post-purchase/live-check", () => ({ verifyLive: vi.fn() }));

import { getOrCreateOffer, checkoutUrl, OFFER_TTL_MS } from "@/lib/post-purchase/offer-service";
import { getSetting } from "@/lib/database";
import { fetchMerciOrder } from "@/lib/post-purchase/order";
import { loadCandidates, catalogueColour, getOfferRow, reserveOffer, takeStaleReservation, finishOffer, releaseOffer } from "@/lib/post-purchase/store";
import { createMerciDiscount } from "@/lib/post-purchase/discount";
import { verifyLive } from "@/lib/post-purchase/live-check";
import type { MerciPick } from "@/lib/post-purchase/offer-rules";

const NOW = Date.parse("2026-11-21T15:00:00Z");
const ORDER_GID = "gid://shopify/Order/6001";
const L = "Home Furnishings > Living Room Furniture";
const AUTH = { confirmationNumber: "ABC123XYZ" };

const order = {
  id: ORDER_GID,
  name: "#1150",
  email: "Client@Exemple.ca",
  createdAt: new Date(NOW - 60_000).toISOString(),
  cancelled: false,
  test: false,
  customerId: "gid://shopify/Customer/77",
  confirmationNumber: "ABC123XYZ",
  discountCodes: [] as string[],
  lines: [{ productId: "1", productType: `${L} > Sofas & Reclining Chairs > Single Sofas`, title: "Fauteuil", variantTitle: "Noir", price: 240.88 }],
};
const side = { variantId: "111", productId: "11", sku: "A-111", source: "aosom" as const, handle: "table-ronde", title: "Table d'appoint ronde", type: `${L} > Side Tables`, colour: "Black", price: 53.99, compareAt: 59.99, cost: 28, imageUrl: "https://cdn/x.jpg", pct: 10 };
const tray = { variantId: "222", productId: "22", sku: "A-222", source: "aosom" as const, handle: "plateau", title: "Plateau d'accoudoir", type: L, colour: null, price: 39.99, compareAt: null, cost: 20, imageUrl: "https://cdn/y.jpg", pct: 5 };

function settings(map: Record<string, string | null>) {
  vi.mocked(getSetting).mockImplementation(async (k: string) => map[k] ?? null);
}

describe("getOrCreateOffer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settings({ merci_offer_enabled: "1" });
    vi.mocked(getOfferRow).mockResolvedValue(null);
    vi.mocked(fetchMerciOrder).mockResolvedValue(order);
    vi.mocked(reserveOffer).mockResolvedValue(true);
    vi.mocked(finishOffer).mockResolvedValue(true);
    vi.mocked(loadCandidates).mockResolvedValue([side, tray]);
    vi.mocked(catalogueColour).mockResolvedValue("Black");
    // Live check passes everything through unchanged by default.
    vi.mocked(verifyLive).mockImplementation(async (ranked: MerciPick[]) => ranked);
    let i = 0;
    vi.mocked(createMerciDiscount).mockImplementation(async () => ({ code: `MERCI-CODE${++i}`, discountId: `gid://shopify/DiscountCodeNode/${i}` }));
  });

  it("creates one code per offer, stores them with a fixed 30-min expiry and returns checkout links", async () => {
    const out = await getOrCreateOffer("gid://shopify/OrderIdentity/6001", AUTH, NOW);
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    expect(out.body.expiresAt).toBe(new Date(NOW + OFFER_TTL_MS).toISOString());
    expect(out.body.offers).toHaveLength(2);
    expect(out.body.offers[0]).toMatchObject({
      title: "Table d'appoint ronde",
      pct: 10,
      discountedPrice: 48.6,
      checkoutUrlShopPay: "https://ameublodirect.ca/cart/111:1?discount=MERCI-CODE1&payment=shop_pay",
      checkoutUrl: "https://ameublodirect.ca/cart/111:1?discount=MERCI-CODE1",
    });
    expect(createMerciDiscount).toHaveBeenCalledWith({ variantId: "111", pct: 10, price: 53.99, orderName: "#1150" }, new Date(NOW), new Date(NOW + OFFER_TTL_MS));
    const claim = vi.mocked(reserveOffer).mock.calls[0][1];
    expect(vi.mocked(finishOffer).mock.calls[0][1]).toBe(claim);
    expect(vi.mocked(finishOffer).mock.calls[0][2]).toMatchObject({ status: "ready", expiresAt: Math.floor((NOW + OFFER_TTL_MS) / 1000) });
    expect(JSON.stringify(out.body)).not.toContain("DiscountCodeNode");
  });

  it("#2 shows what the LIVE re-check returns: live price/tier, and drops what it drops", async () => {
    vi.mocked(verifyLive).mockImplementation(async (ranked: MerciPick[]) =>
      ranked.filter((p) => p.variantId !== "111").map((p) => ({ ...p, price: 41.99, pct: 5, discountedPrice: 39.89 })),
    );
    const out = await getOrCreateOffer(ORDER_GID, AUTH, NOW);
    expect(out.status).toBe(200);
    if (out.status !== 200) return;
    expect(out.body.offers.map((o) => [o.title, o.price, o.pct, o.discountedPrice])).toEqual([["Plateau d'accoudoir", 41.99, 5, 39.89]]);
    expect(createMerciDiscount).toHaveBeenCalledTimes(1);
    expect(createMerciDiscount).toHaveBeenCalledWith(expect.objectContaining({ variantId: "222", price: 41.99, pct: 5 }), expect.any(Date), expect.any(Date));
    // The re-check got the anchor's price cap: max(50 % of 240.88, 50 $) = 120.44.
    expect(vi.mocked(verifyLive).mock.calls[0][1]).toBeCloseTo(120.44, 2);
  });

  it("#2 nothing survives the live re-check → 'none', no code", async () => {
    vi.mocked(verifyLive).mockResolvedValue([]);
    expect((await getOrCreateOffer(ORDER_GID, AUTH, NOW)).body).toEqual({ expiresAt: null, offers: [] });
    expect(vi.mocked(finishOffer).mock.calls[0][2]).toMatchObject({ status: "none" });
    expect(createMerciDiscount).not.toHaveBeenCalled();
  });

  it("#4 an order paid with a MERCI code gets no new offer", async () => {
    vi.mocked(fetchMerciOrder).mockResolvedValue({ ...order, discountCodes: ["merci-abcdefg"] });
    expect((await getOrCreateOffer(ORDER_GID, AUTH, NOW)).body).toEqual({ expiresAt: null, offers: [] });
    expect(reserveOffer).not.toHaveBeenCalled();
  });

  it("#5 refuses a caller that is not the buyer: wrong/missing confirmation number, or another customer's token", async () => {
    expect(await getOrCreateOffer(ORDER_GID, { confirmationNumber: "WRONG" }, NOW)).toEqual({ status: 403, body: { error: "order" } });
    expect(await getOrCreateOffer(ORDER_GID, {}, NOW)).toEqual({ status: 403, body: { error: "order" } });
    expect(await getOrCreateOffer(ORDER_GID, { ...AUTH, sub: "gid://shopify/Customer/999" }, NOW)).toEqual({ status: 403, body: { error: "order" } });
    expect(reserveOffer).not.toHaveBeenCalled();
    expect((await getOrCreateOffer(ORDER_GID, { ...AUTH, sub: "gid://shopify/Customer/77" }, NOW)).status).toBe(200);
  });

  it("#5 a reload also goes through the ownership check before the stored codes are returned", async () => {
    vi.mocked(getOfferRow).mockResolvedValue({ order_id: ORDER_GID, order_name: "#1150", status: "ready", expires_at: Math.floor(NOW / 1000) + 600, created_at: 1, offers: [{ ...side, discountedPrice: 48.59, why: "w", code: "MERCI-OLD", discountId: "d" }] });
    expect((await getOrCreateOffer(ORDER_GID, { confirmationNumber: "nope" }, NOW)).status).toBe(403);
  });

  it("is idempotent: a reload returns the SAME offer and the SAME expiry (the timer never resets)", async () => {
    const expiresAt = Math.floor((NOW + 10 * 60_000) / 1000);
    vi.mocked(getOfferRow).mockResolvedValue({
      order_id: ORDER_GID, order_name: "#1150", status: "ready", expires_at: expiresAt, created_at: 1,
      offers: [{ ...side, discountedPrice: 48.59, why: "w", code: "MERCI-OLD", discountId: "d" }],
    });
    const out = await getOrCreateOffer(ORDER_GID, AUTH, NOW + 5 * 60_000);
    expect(out).toMatchObject({ status: 200, body: { expiresAt: new Date(expiresAt * 1000).toISOString() } });
    if (out.status === 200) expect(out.body.offers[0].checkoutUrl).toContain("MERCI-OLD");
    expect(createMerciDiscount).not.toHaveBeenCalled();
    expect(reserveOffer).not.toHaveBeenCalled();
  });

  it("an expired offer is gone: empty, nothing recreated", async () => {
    vi.mocked(getOfferRow).mockResolvedValue({ order_id: ORDER_GID, order_name: "#1150", status: "ready", expires_at: Math.floor(NOW / 1000) - 1, created_at: 1, offers: [{ ...side, discountedPrice: 1, why: "w", code: "C", discountId: "d" }] });
    expect(await getOrCreateOffer(ORDER_GID, AUTH, NOW)).toEqual({ status: 200, body: { expiresAt: null, offers: [] } });
    expect(createMerciDiscount).not.toHaveBeenCalled();
  });

  it("kill switch OFF and no testers: nothing, without even reading the order", async () => {
    settings({});
    expect(await getOrCreateOffer(ORDER_GID, AUTH, NOW)).toEqual({ status: 200, body: { expiresAt: null, offers: [] } });
    expect(fetchMerciOrder).not.toHaveBeenCalled();
  });

  it("kill switch OFF: only test-allowlist emails get the offer", async () => {
    settings({ merci_offer_enabled: "0", merci_offer_test_emails: "qa@ameublodirect.ca, client@exemple.ca" });
    expect((await getOrCreateOffer(ORDER_GID, AUTH, NOW)).status).toBe(200);
    expect(createMerciDiscount).toHaveBeenCalled();

    vi.clearAllMocks();
    settings({ merci_offer_enabled: "0", merci_offer_test_emails: "qa@ameublodirect.ca" });
    vi.mocked(getOfferRow).mockResolvedValue(null);
    vi.mocked(fetchMerciOrder).mockResolvedValue(order);
    expect(await getOrCreateOffer(ORDER_GID, AUTH, NOW)).toEqual({ status: 200, body: { expiresAt: null, offers: [] } });
    expect(reserveOffer).not.toHaveBeenCalled();
  });

  it("202 while Shopify has not created the order yet", async () => {
    vi.mocked(fetchMerciOrder).mockResolvedValue(null);
    expect(await getOrCreateOffer(ORDER_GID, AUTH, NOW)).toEqual({ status: 202, body: { pending: true } });
  });

  it("refuses orders older than 2 h and cancelled orders", async () => {
    vi.mocked(fetchMerciOrder).mockResolvedValue({ ...order, createdAt: new Date(NOW - 3 * 3600_000).toISOString() });
    expect((await getOrCreateOffer(ORDER_GID, AUTH, NOW)).body).toEqual({ expiresAt: null, offers: [] });
    vi.mocked(fetchMerciOrder).mockResolvedValue({ ...order, cancelled: true });
    expect((await getOrCreateOffer(ORDER_GID, AUTH, NOW)).body).toEqual({ expiresAt: null, offers: [] });
    expect(reserveOffer).not.toHaveBeenCalled();
  });

  it("no good candidate: records 'none' and returns empty", async () => {
    vi.mocked(loadCandidates).mockResolvedValue([]);
    expect((await getOrCreateOffer(ORDER_GID, AUTH, NOW)).body).toEqual({ expiresAt: null, offers: [] });
    expect(vi.mocked(finishOffer).mock.calls[0][2]).toMatchObject({ status: "none" });
    expect(createMerciDiscount).not.toHaveBeenCalled();
  });

  it("a concurrent request holding the reservation → 202; a crashed one is taken over under a new claim", async () => {
    vi.mocked(reserveOffer).mockResolvedValue(false);
    vi.mocked(getOfferRow).mockResolvedValueOnce(null).mockResolvedValueOnce({ order_id: ORDER_GID, order_name: null, status: "pending", offers: [], expires_at: null, created_at: 1 });
    vi.mocked(takeStaleReservation).mockResolvedValue(false);
    expect(await getOrCreateOffer(ORDER_GID, AUTH, NOW)).toEqual({ status: 202, body: { pending: true } });

    vi.mocked(getOfferRow).mockResolvedValue(null);
    vi.mocked(takeStaleReservation).mockResolvedValue(true);
    expect((await getOrCreateOffer(ORDER_GID, AUTH, NOW)).status).toBe(200);
    const claim = vi.mocked(takeStaleReservation).mock.calls.at(-1)?.[1];
    expect(vi.mocked(finishOffer).mock.calls.at(-1)?.[1]).toBe(claim);
  });

  it("#8 a superseded request never overwrites: it returns the winner's offer and expiry", async () => {
    const winnerExpiry = Math.floor(NOW / 1000) + 1200;
    vi.mocked(finishOffer).mockResolvedValue(false);
    vi.mocked(getOfferRow)
      .mockResolvedValueOnce(null) // before reserving
      .mockResolvedValueOnce({ order_id: ORDER_GID, order_name: "#1150", status: "ready", expires_at: winnerExpiry, created_at: 1, offers: [{ ...tray, discountedPrice: 37.99, why: "w", code: "MERCI-WINNER", discountId: "d" }] });
    const out = await getOrCreateOffer(ORDER_GID, AUTH, NOW);
    expect(out).toMatchObject({ status: 200, body: { expiresAt: new Date(winnerExpiry * 1000).toISOString() } });
    if (out.status === 200) expect(out.body.offers[0].checkoutUrl).toContain("MERCI-WINNER");
  });

  it("all code creations fail → this request's reservation released, 502", async () => {
    vi.mocked(createMerciDiscount).mockRejectedValue(new Error("boom"));
    expect(await getOrCreateOffer(ORDER_GID, AUTH, NOW)).toEqual({ status: 502, body: { error: "code" } });
    expect(releaseOffer).toHaveBeenCalledWith(ORDER_GID, vi.mocked(reserveOffer).mock.calls[0][1]);
  });

  it("garbage order ids → empty", async () => {
    expect((await getOrCreateOffer("gid://shopify/Product/1", AUTH, NOW)).body).toEqual({ expiresAt: null, offers: [] });
    expect((await getOrCreateOffer({}, AUTH, NOW)).body).toEqual({ expiresAt: null, offers: [] });
  });
});

describe("checkoutUrl", () => {
  it("builds the cart permalink with quantity 1 and the code (and Shop Pay)", () => {
    expect(checkoutUrl("42", "MERCI-AB", true)).toBe("https://ameublodirect.ca/cart/42:1?discount=MERCI-AB&payment=shop_pay");
    expect(checkoutUrl("42", "MERCI-AB", false)).toBe("https://ameublodirect.ca/cart/42:1?discount=MERCI-AB");
  });
});
