/**
 * Meta Conversions API (CAPI) — server-side events sent in addition to the browser pixel, as Meta recommends
 * ("redundant setup"). Browser and server share the same `event_id` so Meta counts each event once:
 *  - Purchase: the Shopify Custom Web Pixel sends `eid = checkout.token`; the orders/paid webhook sends
 *    `event_id = order.checkout_token` (same value).
 *  - ViewContent / AddToCart: the storefront ScriptTag generates one id per event and sends it both to fbq
 *    (`eventID`) and to /api/capi/event.
 * Customer data (email, phone, name, address) is SHA-256 hashed after Meta's normalisation rules; IP, user agent,
 * fbp and fbc are sent as-is (Meta requires them unhashed).
 */
import crypto from "crypto";
import { env } from "@/lib/config";

export const CAPI_VERSION = "v21.0";

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Meta normalisation rules (https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters). */
export const normalize = {
  email: (v: string) => v.trim().toLowerCase(),
  /** digits only, with country code; a bare 10-digit North-American number gets the leading 1. */
  phone: (v: string) => {
    const d = v.replace(/\D/g, "");
    return d.length === 10 ? `1${d}` : d;
  },
  name: (v: string) => v.trim().toLowerCase(),
  city: (v: string) => v.toLowerCase().replace(/[^\p{L}]/gu, ""),
  state: (v: string) => v.trim().toLowerCase().slice(0, 2),
  zip: (v: string) => v.replace(/\s|-/g, "").toLowerCase(),
  country: (v: string) => v.trim().toLowerCase().slice(0, 2),
};

export interface UserDataInput {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  country?: string | null;
  externalId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  fbp?: string | null;
  fbc?: string | null;
}

const present = (v: string | null | undefined): v is string => typeof v === "string" && v.trim() !== "";

export function buildUserData(i: UserDataInput): Record<string, unknown> {
  const u: Record<string, unknown> = {};
  const hashed = (key: string, v: string | null | undefined, fn: (s: string) => string) => {
    if (!present(v)) return;
    const n = fn(v);
    if (n) u[key] = [sha256(n)];
  };
  hashed("em", i.email, normalize.email);
  hashed("ph", i.phone, normalize.phone);
  hashed("fn", i.firstName, normalize.name);
  hashed("ln", i.lastName, normalize.name);
  hashed("ct", i.city, normalize.city);
  hashed("st", i.state, normalize.state);
  hashed("zp", i.zip, normalize.zip);
  hashed("country", i.country, normalize.country);
  hashed("external_id", i.externalId, (s) => s.trim());
  if (present(i.ip)) u.client_ip_address = i.ip.trim();
  if (present(i.userAgent)) u.client_user_agent = i.userAgent.trim();
  if (present(i.fbp)) u.fbp = i.fbp.trim();
  if (present(i.fbc)) u.fbc = i.fbc.trim();
  return u;
}

export interface CapiEvent {
  event_name: string;
  event_time: number;
  event_id: string;
  event_source_url?: string;
  action_source: "website";
  user_data: Record<string, unknown>;
  custom_data?: Record<string, unknown>;
}

export interface CapiResult {
  ok: boolean;
  status: number;
  received?: number;
  error?: string;
}

/** POST /{pixel}/events. `testEventCode` routes events to Events Manager → Test events only (no ad impact). */
export async function sendCapiEvents(
  events: CapiEvent[],
  opts: { testEventCode?: string | null; fetchImpl?: typeof fetch; pixelId?: string; accessToken?: string } = {},
): Promise<CapiResult> {
  const pixelId = opts.pixelId ?? env.metaPixelId;
  if (!pixelId || !/^\d+$/.test(pixelId)) return { ok: false, status: 0, error: "pixel id not configured" };
  let token = opts.accessToken;
  if (!token) {
    if (!env.hasMetaAccessToken) return { ok: false, status: 0, error: "META_ACCESS_TOKEN not set" };
    token = env.metaAccessToken;
  }
  const f = opts.fetchImpl ?? fetch;
  const body: Record<string, unknown> = { data: events };
  if (opts.testEventCode) body.test_event_code = opts.testEventCode;
  const res = await f(`https://graph.facebook.com/${CAPI_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: { events_received?: number; error?: { message?: string } } | null = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) return { ok: false, status: res.status, error: json?.error?.message ?? `HTTP ${res.status}` };
  return { ok: true, status: res.status, received: json?.events_received ?? events.length };
}

// ── Shopify order → Purchase ─────────────────────────────────────────────────────────────────────────────────
export interface ShopifyOrderLike {
  id: number | string;
  checkout_token?: string | null;
  created_at: string;
  processed_at?: string | null;
  total_price: string | number;
  currency?: string;
  presentment_currency?: string;
  financial_status?: string | null;
  test?: boolean;
  email?: string | null;
  phone?: string | null;
  customer?: { id?: number | string; email?: string | null; phone?: string | null; first_name?: string | null; last_name?: string | null } | null;
  billing_address?: { first_name?: string | null; last_name?: string | null; city?: string | null; province_code?: string | null; zip?: string | null; country_code?: string | null; phone?: string | null } | null;
  shipping_address?: { first_name?: string | null; last_name?: string | null; city?: string | null; province_code?: string | null; zip?: string | null; country_code?: string | null; phone?: string | null } | null;
  client_details?: { browser_ip?: string | null; user_agent?: string | null } | null;
  line_items?: Array<{ sku?: string | null; quantity?: number; price?: string | number }>;
  order_status_url?: string | null;
}

/** Shopify checkout token == the Custom Web Pixel's `checkout.token` == the browser Purchase `eid`. */
export function purchaseEventId(o: Pick<ShopifyOrderLike, "id" | "checkout_token">): string {
  return o.checkout_token && String(o.checkout_token).trim() ? String(o.checkout_token) : `order_${o.id}`;
}

export function purchaseEventFromOrder(o: ShopifyOrderLike): CapiEvent {
  const addr = o.billing_address ?? o.shipping_address ?? null;
  const items = (o.line_items ?? []).filter((li) => present(li.sku));
  let sourceUrl = "https://ameublodirect.ca/";
  try { if (o.order_status_url) sourceUrl = `${new URL(o.order_status_url).origin}/`; } catch { /* keep default */ }
  const t = new Date(o.processed_at || o.created_at).getTime();
  return {
    event_name: "Purchase",
    event_time: Math.floor((Number.isFinite(t) ? t : Date.now()) / 1000),
    event_id: purchaseEventId(o),
    event_source_url: sourceUrl,
    action_source: "website",
    user_data: buildUserData({
      email: o.email || o.customer?.email,
      phone: o.phone || o.customer?.phone || addr?.phone,
      firstName: o.customer?.first_name || addr?.first_name,
      lastName: o.customer?.last_name || addr?.last_name,
      city: addr?.city,
      state: addr?.province_code,
      zip: addr?.zip,
      country: addr?.country_code,
      externalId: o.customer?.id != null ? String(o.customer.id) : null,
      ip: o.client_details?.browser_ip,
      userAgent: o.client_details?.user_agent,
    }),
    custom_data: {
      value: Number(o.total_price) || 0,
      currency: (o.presentment_currency || o.currency || "CAD").toUpperCase(),
      content_type: "product",
      content_ids: items.map((li) => String(li.sku)),
      contents: items.map((li) => ({ id: String(li.sku), quantity: li.quantity ?? 1, item_price: Number(li.price) || 0 })),
      num_items: items.reduce((n, li) => n + (li.quantity ?? 0), 0),
      order_id: String(o.id),
    },
  };
}

export const isPaidOrder = (o: Pick<ShopifyOrderLike, "financial_status" | "test">) =>
  !o.test && (o.financial_status === "paid" || o.financial_status === "partially_paid");

// ── feature flags / idempotency (settings table + tiny sent-log) ─────────────────────────────────────────────
import { ensureSchema, getSetting } from "@/lib/database";

export async function capiConfig(): Promise<{ enabled: boolean; testEventCode: string | null }> {
  const [enabled, code] = await Promise.all([getSetting("capi_enabled"), getSetting("capi_test_event_code")]);
  return { enabled: enabled === "1", testEventCode: code && code.trim() ? code.trim() : null };
}

let tableReady = false;
async function db() {
  const client = await ensureSchema();
  if (!tableReady) {
    await client.execute(`CREATE TABLE IF NOT EXISTS capi_events_sent (event_id TEXT NOT NULL, event_name TEXT NOT NULL, sent_at TEXT NOT NULL, PRIMARY KEY (event_id, event_name))`);
    tableReady = true;
  }
  return client;
}
export async function alreadySent(eventId: string, eventName: string): Promise<boolean> {
  const c = await db();
  const r = await c.execute({ sql: `SELECT 1 FROM capi_events_sent WHERE event_id = ? AND event_name = ?`, args: [eventId, eventName] });
  return r.rows.length > 0;
}
export async function markSent(eventId: string, eventName: string): Promise<void> {
  const c = await db();
  await c.execute({ sql: `INSERT OR IGNORE INTO capi_events_sent (event_id, event_name, sent_at) VALUES (?, ?, ?)`, args: [eventId, eventName, new Date().toISOString()] });
}
