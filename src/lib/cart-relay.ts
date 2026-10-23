/**
 * Panier abandonné — Klaviyo CAMPAIGN relay (reminder for ADDED-TO-CART shoppers).
 *
 * Same reason and same machinery as relance-paiement.ts: the Klaviyo flow « Abandoned Cart (FR/EN)
 * » (Wcjr3F) stays a DRAFT, and this job replaces it. It reads Shopify's « Added to Cart » events
 * from Klaviyo and, for each identified shopper who added something, did NOT start a checkout nor
 * order afterwards, and whose cart is between CART_DELAY_H and CART_MAX_AGE_H old, sends ONE
 * one-recipient campaign (list → campaign, see klaviyo-campaigns.ts) carrying their items.
 *
 * Checkout abandoners belong to relance-paiement (a Checkout Started after the cart event excludes
 * the cart here). No discount, no promo code — free shipping across Canada is the only argument.
 *
 * OFF by default: nothing is sent until settings `cart_relay_enabled` = "1".
 */
import { kv, type RawEvent } from "./klaviyo-campaigns";
import { esc, money } from "./relance-paiement";

export const ADDED_TO_CART_METRIC = "Added to Cart";
export const ADDED_TO_CART_ID = "SmdQyJ";
/** Wait this long after the last add-to-cart (the shopper may still be browsing / checking out). */
export const CART_DELAY_H = 3;
/** Older carts are not reminded (stale emails are worse than none). */
export const CART_MAX_AGE_H = 48;
/** One email per profile per this window, across this relay AND relance-paiement. */
export const PROFILE_COOLDOWN_H = 7 * 24;
export const MAX_PER_RUN = 25;
export const MAX_PER_DAY = 60;
const INTERNAL_EMAIL = /^qa-|^ops-|@ameublodirect\.ca$/i;
const STORE_ORIGIN = "https://ameublodirect.ca";

export const ENABLED_KEY = "cart_relay_enabled";
export const STATE_KEY = "cart_relay_state";
export const TEMPLATES_KEY = "cart_relay_templates_v1";

export interface CartItem { title: string; quantity: number; price: number | null; image: string | null; url: string | null; variantId: string }
export interface CartEvent { eventId: string; profileId: string; email: string | null; at: string; locale: "fr" | "en" | null; item: CartItem }
export interface Cart {
  cartId: string; eventIds: string[]; profileId: string; email: string | null;
  firstAt: string; at: string; locale: "fr" | "en"; items: CartItem[]; url: string;
}

export interface CartRelayState {
  /** Added-to-cart event id → ISO time it was handled (sent, or skipped for good) */
  events: Record<string, string>;
  /** profile id → ISO time of the last cart email */
  profiles: Record<string, string>;
  /** ISO times of every send in the last 24 h (the per-day cap) */
  sentLog: string[];
  pending: Array<{ campaignId: string; eventIds: string[]; profileIds: string[]; at: string }>;
}
export const emptyState = (): CartRelayState => ({ events: {}, profiles: {}, sentLog: [], pending: [] });

export function pruneState(s: CartRelayState, now: Date): CartRelayState {
  const min = now.getTime() - 8 * 24 * 3600e3;
  const keep = (o: Record<string, string> | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([, t]) => Date.parse(t) >= min));
  return {
    events: keep(s.events), profiles: keep(s.profiles),
    sentLog: (s.sentLog ?? []).filter((t) => Date.parse(t) >= now.getTime() - 24 * 3600e3),
    pending: (s.pending ?? []).filter((p) => Date.parse(p.at) >= now.getTime() - 2 * 24 * 3600e3),
  };
}

/** Keep only https links to the shop and serve them from the public domain (not *.myshopify.com). */
export function storefrontUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || !/(^|\.)(ameublodirect\.ca|myshopify\.com)$/i.test(u.hostname)) return null;
    return STORE_ORIGIN + u.pathname + (u.searchParams.get("variant") ? `?variant=${encodeURIComponent(u.searchParams.get("variant")!)}` : "");
  } catch { return null; }
}

/** Map a raw « Added to Cart » event (Shopify integration) to what we need. */
export function parseCartEvent(ev: RawEvent, email: string | null): CartEvent | null {
  const p = ev.attributes.event_properties ?? {};
  const profileId = ev.relationships?.profile?.data?.id;
  const title = String(p["Product Name"] ?? "").trim();
  if (!profileId || !title) return null;
  const img = typeof p.ImageURL === "string" && /^https:\/\/cdn\.shopify\.com\//.test(p.ImageURL) ? p.ImageURL : null;
  const price = Number(p.Price);
  const variantId = String(p.VariantID ?? p.ProductID ?? ev.id);
  const url = storefrontUrl(p.URL);
  const variantName = String(p["Variant Name"] ?? "").trim();
  const rawLocale = p["Customer Locale"];
  const locale = typeof rawLocale === "string" ? (rawLocale.toLowerCase().startsWith("en") ? "en" : "fr")
    : typeof p.URL === "string" && /\/en(\/|$)/.test(new URL(p.URL, STORE_ORIGIN).pathname) ? "en" : null;
  return {
    eventId: ev.id, profileId, email, at: ev.attributes.datetime, locale,
    item: {
      // « Default Title » is Shopify's name for a product without options
      title: variantName && !/^default title$/i.test(variantName) ? `${title} — ${variantName}` : title,
      quantity: Math.max(1, Number(p.Quantity ?? 1) || 1),
      price: Number.isFinite(price) && price > 0 ? price : null, // never invent a price
      image: img ? img.replace(/(\.[a-z]+)(\?|$)/i, "_x300$1$2") : null,
      url, variantId,
    },
  };
}

export type SkipReason = "done" | "too-recent" | "too-old" | "no-email" | "internal" | "checkout-after" | "ordered" | "cooldown" | "relance-paiement" | "no-consent";

export interface SelectCtx {
  state: CartRelayState;
  /** relance-paiement's `profiles` map (profile id → ISO of its last checkout reminder) */
  relanceProfiles: Record<string, string>;
  /** a Checkout Started / Placed Order by this profile at or after iso */
  checkoutAfter: (profileId: string, iso: string) => boolean;
  orderedAfter: (profileId: string, iso: string) => boolean;
  /** subscription check; only asked for carts that passed every other rule */
  canEmail: (profileId: string) => boolean;
  /** profile locale from Klaviyo when the event does not tell */
  profileLocale?: (profileId: string) => "fr" | "en" | null;
  limit?: number;
}

/** Group the events of each profile into one cart (the profile's add-to-carts inside the max age). */
export function groupCarts(events: CartEvent[], now: Date, profileLocale?: SelectCtx["profileLocale"]): Cart[] {
  const by = new Map<string, CartEvent[]>();
  for (const e of events) by.set(e.profileId, [...(by.get(e.profileId) ?? []), e]);
  const carts: Cart[] = [];
  for (const [profileId, list] of by) {
    const sorted = [...list].sort((a, b) => b.at.localeCompare(a.at)); // newest first
    const newest = sorted[0];
    // the cart = every add since the profile's previous quiet gap of CART_MAX_AGE_H (here: inside the window)
    const inCart = sorted.filter((e) => Date.parse(newest.at) - Date.parse(e.at) <= CART_MAX_AGE_H * 3600e3);
    const seen = new Set<string>();
    const items: CartItem[] = [];
    for (const e of inCart) {
      if (seen.has(e.item.variantId)) continue; // same variant added twice → one line
      seen.add(e.item.variantId); items.push(e.item);
    }
    const locale = newest.locale ?? inCart.find((e) => e.locale)?.locale ?? profileLocale?.(profileId) ?? "fr";
    carts.push({
      cartId: newest.eventId, eventIds: inCart.map((e) => e.eventId), profileId, email: newest.email,
      firstAt: inCart[inCart.length - 1].at, at: newest.at, locale, items,
      url: items.find((i) => i.url)?.url ?? `${STORE_ORIGIN}/cart`,
    });
  }
  return carts;
}

/** Decide which carts to remind now. */
export function selectCarts(
  events: CartEvent[], ctx: SelectCtx, now: Date,
): { send: Cart[]; skipped: Array<{ cartId: string; eventIds: string[]; reason: SkipReason; final: boolean }> } {
  const send: Cart[] = [];
  const skipped: Array<{ cartId: string; eventIds: string[]; reason: SkipReason; final: boolean }> = [];
  const limit = ctx.limit ?? MAX_PER_RUN;
  for (const c of groupCarts(events, now, ctx.profileLocale).sort((a, b) => a.at.localeCompare(b.at))) {
    const skip = (reason: SkipReason, final: boolean) => skipped.push({ cartId: c.cartId, eventIds: c.eventIds, reason, final });
    const age = now.getTime() - Date.parse(c.at);
    if (c.eventIds.every((id) => ctx.state.events[id])) { skip("done", true); continue; }
    if (age < CART_DELAY_H * 3600e3) { skip("too-recent", false); continue; }
    if (age > CART_MAX_AGE_H * 3600e3) { skip("too-old", true); continue; }
    if (!c.email) { skip("no-email", true); continue; }
    if (INTERNAL_EMAIL.test(c.email)) { skip("internal", true); continue; }
    // 5 min tolerance: Shopify timestamps differ slightly between event types
    const from = new Date(Date.parse(c.firstAt) - 5 * 60e3).toISOString();
    if (ctx.orderedAfter(c.profileId, from)) { skip("ordered", true); continue; }
    if (ctx.checkoutAfter(c.profileId, from)) { skip("checkout-after", true); continue; }
    const cooled = (iso?: string) => !!iso && now.getTime() - Date.parse(iso) < PROFILE_COOLDOWN_H * 3600e3;
    if (cooled(ctx.relanceProfiles[c.profileId])) { skip("relance-paiement", true); continue; }
    if (cooled(ctx.state.profiles[c.profileId])) { skip("cooldown", true); continue; }
    if (!ctx.canEmail(c.profileId)) { skip("no-consent", true); continue; }
    if (send.length >= limit) { skip("too-recent", false); continue; } // over the cap: retried next run
    send.push(c);
  }
  return { send, skipped };
}

/** Klaviyo `subscriptions.email.marketing` → may we email this profile? Unknown → no. */
export function subscriptionAllows(sub: unknown): boolean {
  const m = (sub as { email?: { marketing?: { can_receive_email_marketing?: boolean; consent?: string; suppression?: unknown[] } } } | null | undefined)?.email?.marketing;
  if (!m) return false;
  if (m.can_receive_email_marketing !== true) return false;
  if (String(m.consent ?? "").toUpperCase() === "UNSUBSCRIBED") return false;
  return !(Array.isArray(m.suppression) && m.suppression.length);
}

// ─── rendering ──────────────────────────────────────────────────────────

/** The per-person block (items) stored on the profile and injected with `|safe`. */
export function renderItemsHtml(c: Pick<Cart, "items" | "locale">): string {
  return c.items.slice(0, 6).map((i) => {
    const title = i.url ? `<a href="${esc(i.url)}" style="color:#222;text-decoration:none">${esc(i.title)}</a>` : esc(i.title);
    const detail = [i.quantity > 1 ? `${i.quantity} ×` : "", i.price !== null ? money(i.price, c.locale) : ""].filter(Boolean).join(" ");
    return `<tr>
<td width="110" style="padding:8px 12px 8px 0;vertical-align:top">${i.image ? `<img src="${esc(i.image)}" width="100" alt="" style="display:block;width:100px;height:auto;border-radius:6px">` : ""}</td>
<td style="padding:8px 0;vertical-align:top;font:15px/1.4 Arial,sans-serif;color:#222">${title}${detail ? `<br><span style="color:#666">${detail}</span>` : ""}</td>
</tr>`;
  }).join("\n");
}

const COPY = {
  fr: {
    subject: "Tu as laissé quelque chose dans ton panier 🛒",
    preview: "Ton choix t'attend chez Ameublo Direct.",
    title: "Ton choix t'attend",
    intro: "Tu as ajouté ces articles à ton panier chez Ameublo Direct. On te les a gardés de côté :",
    cta: "Reprendre où j'en étais",
    perks: "✔ Livraison gratuite partout au Canada",
    help: "Une question avant de commander? Réponds simplement à ce courriel.",
    unsubscribe: "Se désabonner",
  },
  en: {
    subject: "You left something in your cart 🛒",
    preview: "Your pick is waiting at Ameublo Direct.",
    title: "Your pick is waiting",
    intro: "You added these items to your cart at Ameublo Direct. We kept them aside for you:",
    cta: "Pick up where I left off",
    perks: "✔ Free shipping anywhere in Canada",
    help: "A question before ordering? Just reply to this email.",
    unsubscribe: "Unsubscribe",
  },
} as const;

export function cartSubject(locale: "fr" | "en"): { subject: string; preview: string } {
  return { subject: COPY[locale].subject, preview: COPY[locale].preview };
}

/** Klaviyo CODE template: per-person content comes from profile properties. */
export function buildTemplateHtml(locale: "fr" | "en"): string {
  const c = COPY[locale];
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#f4f1ec">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px">
<tr><td style="padding:24px 24px 8px;font:bold 20px Arial,sans-serif;color:#222">Ameublo Direct</td></tr>
<tr><td style="padding:8px 24px;font:bold 22px/1.3 Arial,sans-serif;color:#222">${c.title}</td></tr>
<tr><td style="padding:0 24px 8px;font:15px/1.5 Arial,sans-serif;color:#444">${c.intro}</td></tr>
<tr><td style="padding:0 24px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%">{{ person|lookup:'cart_relay_items_html'|safe }}</table></td></tr>
<tr><td align="center" style="padding:20px 24px"><a href="{{ person|lookup:'cart_relay_url' }}" style="display:inline-block;background:#c8553d;color:#ffffff;text-decoration:none;font:bold 16px Arial,sans-serif;padding:14px 28px;border-radius:6px">${c.cta}</a></td></tr>
<tr><td style="padding:0 24px 16px;font:14px/1.6 Arial,sans-serif;color:#444">${c.perks}</td></tr>
<tr><td style="padding:0 24px 24px;font:14px/1.5 Arial,sans-serif;color:#666">${c.help}</td></tr>
</table>
<p style="font:12px/1.5 Arial,sans-serif;color:#888;max-width:560px">{{ organization.name }} · {{ organization.full_address }}<br>{% unsubscribe '${c.unsubscribe}' %}</p>
</td></tr></table></body></html>`;
}

// ─── Klaviyo IO ─────────────────────────────────────────────────────────

/** Subscription status + locale of the given profiles (100 per call). Missing profile → absent. */
export async function fetchProfileInfo(ids: string[]): Promise<Map<string, { allowed: boolean; locale: "fr" | "en" | null }>> {
  const out = new Map<string, { allowed: boolean; locale: "fr" | "en" | null }>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const j = await kv<{ data: Array<{ id: string; attributes: { locale?: string | null; subscriptions?: unknown } }> }>(
      "GET", `/profiles/?filter=${encodeURIComponent(`any(id,[${chunk.map((x) => `"${x}"`).join(",")}])`)}&additional-fields[profile]=subscriptions&fields[profile]=locale&page[size]=100`);
    for (const p of j.data) {
      const l = typeof p.attributes.locale === "string" ? (p.attributes.locale.toLowerCase().startsWith("en") ? "en" : "fr") : null;
      out.set(p.id, { allowed: subscriptionAllows(p.attributes.subscriptions), locale: l });
    }
  }
  return out;
}
