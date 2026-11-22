/**
 * Offre de remerciement — the request flow behind POST /api/merci/offer, kept out of the route so it can be tested.
 *
 *   token ok → kill switch / test allowlist → order read via Admin API (202 while Shopify has not created it yet)
 *   → idempotent reservation (one offer per order; expiry fixed once, so the 30-min timer never resets)
 *   → rules → one single-use code per offered variant → stored → returned.
 *
 * Settings: `merci_offer_enabled` = "1" turns it on for everyone (default OFF); `merci_offer_test_emails`
 * (comma list) shows it to those order emails while it is OFF, for QA on real orders.
 */
import { getSetting } from "@/lib/database";
import { pickOffers } from "./offer-rules";
import { fetchMerciOrder, toOrderGid, type MerciOrder } from "./order";
import { loadCandidates, catalogueColour, getOfferRow, reserveOffer, takeStaleReservation, finishOffer, releaseOffer, type StoredOffer, type OfferRow } from "./store";
import { createMerciDiscount } from "./discount";

export const OFFER_TTL_MS = 30 * 60_000;
/** Only orders this fresh get an offer (the page is shown right after payment; reloads later show nothing new). */
export const MAX_ORDER_AGE_MS = 2 * 3600_000;
/** A 'pending' row older than this is a crashed request. */
export const STALE_PENDING_S = 90;
export const STORE_BASE = "https://ameublodirect.ca";

export interface PublicOffer {
  title: string;
  imageUrl: string;
  url: string;
  price: number;
  compareAt: number | null;
  discountedPrice: number;
  pct: number;
  why: string;
  checkoutUrlShopPay: string;
  checkoutUrl: string;
}

export type OfferOutcome =
  | { status: 200; body: { expiresAt: string | null; offers: PublicOffer[] } }
  | { status: 202; body: { pending: true } }
  | { status: 502; body: { error: string } };

const EMPTY: OfferOutcome = { status: 200, body: { expiresAt: null, offers: [] } };

/** Cart permalink straight to checkout with the code applied; `shopPay` asks for the Shop Pay checkout. */
export function checkoutUrl(variantId: string, code: string, shopPay: boolean): string {
  const q = new URLSearchParams({ discount: code });
  if (shopPay) q.set("payment", "shop_pay");
  return `${STORE_BASE}/cart/${variantId}:1?${q.toString()}`;
}

export function toPublic(offers: StoredOffer[]): PublicOffer[] {
  return offers.map((o) => ({
    title: o.title,
    imageUrl: o.imageUrl,
    url: `${STORE_BASE}/products/${o.handle}`,
    price: o.price,
    compareAt: o.compareAt,
    discountedPrice: o.discountedPrice,
    pct: o.pct,
    why: o.why,
    checkoutUrlShopPay: checkoutUrl(o.variantId, o.code, true),
    checkoutUrl: checkoutUrl(o.variantId, o.code, false),
  }));
}

function fromRow(row: OfferRow, nowMs: number): OfferOutcome {
  if (row.status !== "ready" || !row.expires_at || row.expires_at * 1000 <= nowMs || !row.offers.length) return EMPTY;
  return { status: 200, body: { expiresAt: new Date(row.expires_at * 1000).toISOString(), offers: toPublic(row.offers) } };
}

function parseList(v: string | null): Set<string> {
  return new Set((v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

export async function getOrCreateOffer(rawOrderId: unknown, nowMs = Date.now()): Promise<OfferOutcome> {
  const gid = toOrderGid(rawOrderId);
  if (!gid) return EMPTY;

  const enabled = (await getSetting("merci_offer_enabled")) === "1";
  const testers = parseList(await getSetting("merci_offer_test_emails"));
  if (!enabled && testers.size === 0) return EMPTY;

  // An offer already decided for this order: same products, same codes, same expiry.
  const existing = await getOfferRow(gid);
  if (existing && existing.status !== "pending") return fromRow(existing, nowMs);

  const order: MerciOrder | null = await fetchMerciOrder(gid);
  if (!order) return { status: 202, body: { pending: true } };
  if (!enabled && !testers.has((order.email ?? "").toLowerCase())) return EMPTY;
  if (order.cancelled) return EMPTY;
  if (nowMs - new Date(order.createdAt).getTime() > MAX_ORDER_AGE_MS) return EMPTY;

  const nowSec = Math.floor(nowMs / 1000);
  if (!(await reserveOffer(gid, nowSec))) {
    const again = await getOfferRow(gid);
    if (again && again.status !== "pending") return fromRow(again, nowMs);
    if (!(await takeStaleReservation(gid, STALE_PENDING_S, nowSec))) return { status: 202, body: { pending: true } };
  }

  try {
    const catalogue = await loadCandidates();
    const anchorPid = [...order.lines].sort((a, b) => b.price - a.price)[0]?.productId ?? null;
    const anchorColour = anchorPid ? await catalogueColour(anchorPid) : null;
    const { picks } = pickOffers(order.lines, catalogue, { now: new Date(nowMs), anchorColour });
    if (!picks.length) {
      await finishOffer(gid, { orderName: order.name, status: "none", offers: [], expiresAt: null });
      return EMPTY;
    }

    const now = new Date(nowMs);
    const endsAt = new Date(nowMs + OFFER_TTL_MS);
    const stored: StoredOffer[] = [];
    for (const p of picks) {
      try {
        const { code, discountId } = await createMerciDiscount({ variantId: p.variantId, pct: p.pct, orderName: order.name }, now, endsAt);
        stored.push({
          title: p.title, imageUrl: p.imageUrl, handle: p.handle, variantId: p.variantId, price: p.price, compareAt: p.compareAt,
          discountedPrice: p.discountedPrice, pct: p.pct, why: p.why, code, discountId,
        });
      } catch (err) {
        console.error(`[merci] code creation failed for ${order.name} variant ${p.variantId}: ${err}`);
      }
    }
    if (!stored.length) {
      await releaseOffer(gid);
      return { status: 502, body: { error: "code" } };
    }
    const expiresAt = Math.floor(endsAt.getTime() / 1000);
    await finishOffer(gid, { orderName: order.name, status: "ready", offers: stored, expiresAt });
    return { status: 200, body: { expiresAt: endsAt.toISOString(), offers: toPublic(stored) } };
  } catch (err) {
    await releaseOffer(gid).catch(() => {});
    throw err;
  }
}
