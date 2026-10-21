/**
 * Relance paiement abandonné — Klaviyo CAMPAIGN relay.
 *
 * WHY: the Klaviyo account never sends FLOW emails (verified 2026-10-20: the live "Abandoned
 * Checkout v3" flow got ~20 Checkout Started triggers and produced 0 sends / 0 skips / 0 drops,
 * like every other flow since the account exists), while CAMPAIGNS do go out — a one-recipient
 * test campaign to a never-subscribed profile was Sent + opened the same day. So instead of the
 * flow, this job reads Shopify's "Checkout Started" events from Klaviyo and, for each checkout
 * still unpaid after RELANCE_DELAY_MIN, sends that person a one-recipient campaign carrying their
 * own items and Shopify's recover link (stored as profile properties the template looks up).
 *
 * One reminder per checkout, at most one per profile per PROFILE_COOLDOWN_H. Nothing goes to a
 * profile that placed an order after the checkout, has no recover URL, or is an internal test.
 */
import { kv, metricEvents } from "./klaviyo-campaigns";

export const CHECKOUT_STARTED_METRIC = "Checkout Started";
export const PLACED_ORDER_METRIC = "Placed Order";
/** Wait this long after the checkout before reminding (the buyer may still be paying). */
export const RELANCE_DELAY_MIN = 30;
/** Only checkouts younger than this are reminded (older ones are a separate, manual decision). */
export const RELANCE_MAX_AGE_H = 36;
export const PROFILE_COOLDOWN_H = 72;
const INTERNAL_EMAIL = /^qa-|@ameublodirect\.ca$/i;

export const STATE_KEY = "relance_paiement_state";
export const ENABLED_KEY = "relance_paiement_enabled";
// v2: localized unsubscribe link (v1 printed "Unsubscribe" in the French email). A new key makes
// the next run create fresh Klaviyo templates instead of reusing the cached v1 ids.
export const TEMPLATES_KEY = "relance_paiement_templates_v2";

export interface CheckoutEvent {
  eventId: string;
  profileId: string;
  email: string | null;
  at: string; // ISO
  locale: "fr" | "en";
  recoverUrl: string | null;
  value: number;
  items: Array<{ title: string; quantity: number; price: number; image: string | null; handle: string | null }>;
}

export interface RelanceState {
  /** checkout event id → ISO time it was handled (sent, or skipped for good) */
  events: Record<string, string>;
  /** checkout event id → ISO time reminder #1 really went out (flow-relay's reminder #2 reads this) */
  sent: Record<string, string>;
  /** profile id → ISO time of the last reminder sent */
  profiles: Record<string, string>;
  /** campaigns whose final status is checked on the next run ("No Recipients" → retried) */
  pending: Array<{ campaignId: string; eventIds: string[]; profileIds: string[]; at: string }>;
}

export const emptyState = (): RelanceState => ({ events: {}, sent: {}, profiles: {}, pending: [] });

/** Drop bookkeeping older than 8 days so the settings row stays small. */
export function pruneState(s: RelanceState, now: Date): RelanceState {
  const min = now.getTime() - 8 * 24 * 3600e3;
  const keep = (o: Record<string, string> | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([, t]) => Date.parse(t) >= min));
  return { events: keep(s.events), sent: keep(s.sent), profiles: keep(s.profiles), pending: (s.pending ?? []).filter((p) => Date.parse(p.at) >= now.getTime() - 2 * 24 * 3600e3) };
}

/** Map a raw Klaviyo "Checkout Started" event (Shopify integration) to what we need. */
export function parseCheckoutEvent(ev: { id: string; attributes: { datetime: string; event_properties: Record<string, unknown> }; relationships?: { profile?: { data?: { id: string } } } }, email: string | null): CheckoutEvent | null {
  const p = ev.attributes.event_properties ?? {};
  const extra = (p.$extra ?? {}) as Record<string, unknown>;
  const profileId = ev.relationships?.profile?.data?.id;
  if (!profileId) return null;
  const lines = Array.isArray(extra.line_items) ? (extra.line_items as Array<Record<string, unknown>>) : [];
  const items = lines.map((l) => {
    const product = (l.product ?? {}) as { handle?: string; images?: Array<{ src?: string }> };
    const img = product.images?.[0]?.src ?? null;
    return {
      title: String(l.presentment_title ?? l.title ?? ""),
      quantity: Number(l.quantity ?? 1) || 1,
      price: Number(l.line_price ?? 0) || 0,
      image: img ? img.replace(/(\.[a-z]+)(\?|$)/i, "_x300$1$2") : null,
      handle: product.handle ?? null,
    };
  }).filter((i) => i.title);
  const locale = String(p["Customer Locale"] ?? "fr").toLowerCase().startsWith("en") ? "en" : "fr";
  const url = typeof extra.checkout_url === "string" && /^https:\/\//.test(extra.checkout_url) ? extra.checkout_url : null;
  return { eventId: ev.id, profileId, email, at: ev.attributes.datetime, locale, recoverUrl: url, value: Number(p.$value ?? 0) || 0, items };
}

export type SkipReason = "too-recent" | "too-old" | "done" | "ordered" | "cooldown" | "no-url" | "no-email" | "internal" | "no-items";

/** Decide which checkouts to remind now. `orderedAfter(profileId, iso)` = placed an order at/after iso. */
export function selectCandidates(
  events: CheckoutEvent[],
  state: RelanceState,
  orderedAfter: (profileId: string, iso: string) => boolean,
  now: Date,
): { send: CheckoutEvent[]; skipped: Array<{ eventId: string; reason: SkipReason; final: boolean }> } {
  const send: CheckoutEvent[] = [];
  const skipped: Array<{ eventId: string; reason: SkipReason; final: boolean }> = [];
  const picked = new Set<string>();
  // newest first, so a profile with several checkouts is reminded about the latest one
  for (const e of [...events].sort((a, b) => b.at.localeCompare(a.at))) {
    const age = now.getTime() - Date.parse(e.at);
    const skip = (reason: SkipReason, final: boolean) => skipped.push({ eventId: e.eventId, reason, final });
    if (state.events[e.eventId]) { skip("done", true); continue; }
    if (age < RELANCE_DELAY_MIN * 60e3) { skip("too-recent", false); continue; }
    if (age > RELANCE_MAX_AGE_H * 3600e3) { skip("too-old", true); continue; }
    if (!e.email) { skip("no-email", true); continue; }
    if (INTERNAL_EMAIL.test(e.email)) { skip("internal", true); continue; }
    if (!e.recoverUrl) { skip("no-url", true); continue; }
    if (!e.items.length) { skip("no-items", true); continue; }
    if (orderedAfter(e.profileId, e.at)) { skip("ordered", true); continue; }
    const last = state.profiles[e.profileId];
    if (picked.has(e.profileId) || (last && now.getTime() - Date.parse(last) < PROFILE_COOLDOWN_H * 3600e3)) { skip("cooldown", true); continue; }
    picked.add(e.profileId);
    send.push(e);
  }
  return { send, skipped };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (n: number, locale: "fr" | "en") => (locale === "fr" ? `${n.toFixed(2).replace(".", ",")} $` : `$${n.toFixed(2)}`);

/** The per-person block (items) stored on the profile and injected with `|safe`. */
export function renderItemsHtml(e: CheckoutEvent): string {
  return e.items.slice(0, 6).map((i) => `<tr>
<td width="110" style="padding:8px 12px 8px 0;vertical-align:top">${i.image ? `<img src="${esc(i.image)}" width="100" alt="" style="display:block;width:100px;height:auto;border-radius:6px">` : ""}</td>
<td style="padding:8px 0;vertical-align:top;font:15px/1.4 Arial,sans-serif;color:#222">${esc(i.title)}<br><span style="color:#666">${i.quantity > 1 ? `${i.quantity} × ` : ""}${money(i.price, e.locale)}</span></td>
</tr>`).join("\n");
}

const COPY = {
  fr: {
    subject: "Ton panier t'attend 🛒",
    preview: "Tes articles sont encore réservés dans ton panier.",
    title: "Tu as oublié quelque chose?",
    intro: "Tu as commencé une commande chez Ameublo Direct sans la terminer. Tes articles t'attendent :",
    cta: "Reprendre ma commande",
    perks: "✔ Livraison gratuite partout au Canada<br>✔ 10 % de rabais sur le moins cher de 2 articles, automatiquement au panier",
    help: "Une question avant de commander? Réponds simplement à ce courriel.",
    unsubscribe: "Se désabonner",
  },
  en: {
    subject: "Your cart is waiting 🛒",
    preview: "Your items are still in your cart.",
    title: "Forgot something?",
    intro: "You started an order at Ameublo Direct but didn't finish it. Your items are waiting:",
    cta: "Complete my order",
    perks: "✔ Free shipping anywhere in Canada<br>✔ 10% off the cheaper of 2 items, applied automatically in the cart",
    help: "A question before ordering? Just reply to this email.",
    unsubscribe: "Unsubscribe",
  },
} as const;

export function relanceSubject(locale: "fr" | "en"): { subject: string; preview: string } {
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
<tr><td style="padding:0 24px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%">{{ person|lookup:'relance_items_html'|safe }}</table></td></tr>
<tr><td align="center" style="padding:20px 24px"><a href="{{ person|lookup:'relance_url' }}" style="display:inline-block;background:#c8553d;color:#ffffff;text-decoration:none;font:bold 16px Arial,sans-serif;padding:14px 28px;border-radius:6px">${c.cta}</a></td></tr>
<tr><td style="padding:0 24px 16px;font:14px/1.6 Arial,sans-serif;color:#444">${c.perks}</td></tr>
<tr><td style="padding:0 24px 24px;font:14px/1.5 Arial,sans-serif;color:#666">${c.help}</td></tr>
</table>
<p style="font:12px/1.5 Arial,sans-serif;color:#888;max-width:560px">{{ organization.name }} · {{ organization.full_address }}<br>{% unsubscribe '${c.unsubscribe}' %}</p>
</td></tr></table></body></html>`;
}

// ─── Klaviyo IO ─────────────────────────────────────────────────────────
export { kv } from "./klaviyo-campaigns";

export async function metricId(name: string): Promise<string> {
  let path: string | null = "/metrics/?fields[metric]=name,integration";
  while (path) {
    const j: { data: Array<{ id: string; attributes: { name: string; integration?: { name?: string } } }>; links?: { next?: string } } = await kv("GET", path);
    const m = j.data.find((x) => x.attributes.name === name && /shopify/i.test(x.attributes.integration?.name ?? ""));
    if (m) return m.id;
    path = j.links?.next ? j.links.next.replace("https://a.klaviyo.com/api", "") : null;
  }
  throw new Error(`Métrique Klaviyo introuvable: ${name}`);
}

/** Back-compat name used by the one-off scripts. */
export const recentEvents = metricEvents;
