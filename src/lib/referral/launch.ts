/**
 * Launch of the programme de parrainage (used by scripts/referral-launch.mts): who is eligible, and the Klaviyo calls
 * that put each enrolled customer's codes on their profile and in the FR/EN list the « Un petit merci » campaign goes to.
 *
 * Eligible (CASL): a buyer of the last 2 years (existing business relationship, implied consent) OR an email
 * subscriber — minus anyone unsubscribed/invalid on Shopify and anyone unsubscribed or suppressed in Klaviyo.
 * Adding a profile to a list does NOT change its consent: nobody is subscribed by this script.
 */
import { shopifyFetch } from "@/lib/shopify-client";
import { env } from "@/lib/config";
import { normalizeEmail, type AddressLike } from "./rules";
import { suppressionBlocks } from "@/lib/email/consent";

export const BUYER_WINDOW_DAYS = 730;

export interface LaunchCustomer {
  id: string;
  email: string | null;
  phone: string | null;
  locale: string | null;
  /** Shopify emailMarketingConsent.marketingState (SUBSCRIBED, NOT_SUBSCRIBED, UNSUBSCRIBED, PENDING, REDACTED, INVALID). */
  marketingState: string | null;
  addresses: AddressLike[];
}

export type LaunchSource = "buyer" | "subscriber" | "buyer+subscriber";

export type LaunchDecision =
  | { ok: true; source: LaunchSource }
  | { ok: false; reason: "no-email" | "shopify-unsubscribed" | "not-buyer-nor-subscriber" | "already-enrolled" | "klaviyo-suppressed" };

const SHOPIFY_EXCLUDED = new Set(["UNSUBSCRIBED", "REDACTED", "INVALID"]);

/** Shopify-side eligibility (Klaviyo is checked afterwards, only for those who pass, to spare API calls). */
export function shopifyEligibility(c: LaunchCustomer, recentBuyers: ReadonlySet<string>, enrolled: { customerIds: ReadonlySet<string>; emailKeys: ReadonlySet<string> }): LaunchDecision {
  const key = normalizeEmail(c.email);
  if (!key) return { ok: false, reason: "no-email" };
  if (enrolled.customerIds.has(c.id) || enrolled.emailKeys.has(key)) return { ok: false, reason: "already-enrolled" };
  const state = (c.marketingState ?? "").toUpperCase();
  if (SHOPIFY_EXCLUDED.has(state)) return { ok: false, reason: "shopify-unsubscribed" };
  const buyer = recentBuyers.has(c.id);
  const subscriber = state === "SUBSCRIBED";
  if (!buyer && !subscriber) return { ok: false, reason: "not-buyer-nor-subscriber" };
  return { ok: true, source: buyer && subscriber ? "buyer+subscriber" : buyer ? "buyer" : "subscriber" };
}

// ─── Shopify reads ───────────────────────────────────────────────────────────

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await shopifyFetch("/graphql.json", { method: "POST", body: JSON.stringify({ query, variables }) });
  const j = (await res.json()) as { data?: T; errors?: unknown };
  if (!res.ok || j.errors || !j.data) throw new Error(`referral launch GraphQL failed: ${JSON.stringify(j.errors ?? res.status).slice(0, 300)}`);
  return j.data;
}

/** Customer GIDs with a real (not test, not cancelled) order since `sinceIso`. */
export async function fetchRecentBuyerIds(sinceIso: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < 200; page++) {
    const d: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ cancelledAt: string | null; test: boolean; customer: { id: string } | null }> } } = await gql(
      `query refBuyers($q: String!, $a: String) { orders(first: 250, after: $a, query: $q) { pageInfo { hasNextPage endCursor } nodes { createdAt cancelledAt test customer { id } } } }`,
      { q: `created_at:>=${sinceIso.replace(/\.\d{3}Z$/, "Z")}`, a: after },
    );
    for (const n of d.orders.nodes) if (n.customer && !n.test && !n.cancelledAt) ids.add(n.customer.id);
    if (!d.orders.pageInfo.hasNextPage || !d.orders.pageInfo.endCursor) break;
    after = d.orders.pageInfo.endCursor;
  }
  return ids;
}

export async function fetchAllCustomers(): Promise<LaunchCustomer[]> {
  const out: LaunchCustomer[] = [];
  let after: string | null = null;
  for (let page = 0; page < 400; page++) {
    const d: {
      customers: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: Array<{ id: string; email: string | null; phone: string | null; locale: string | null; emailMarketingConsent: { marketingState: string } | null; addresses: AddressLike[] }>;
      };
    } = await gql(
      `query refCustomers($a: String) { customers(first: 250, after: $a) { pageInfo { hasNextPage endCursor } nodes { id email phone locale emailMarketingConsent { marketingState } addresses(first: 10) { address1 address2 city zip countryCodeV2 phone } } } }`,
      { a: after },
    );
    for (const n of d.customers.nodes) {
      out.push({ id: n.id, email: n.email, phone: n.phone, locale: n.locale, marketingState: n.emailMarketingConsent?.marketingState ?? null, addresses: n.addresses ?? [] });
    }
    if (!d.customers.pageInfo.hasNextPage || !d.customers.pageInfo.endCursor) break;
    after = d.customers.pageInfo.endCursor;
  }
  return out;
}

// ─── Klaviyo ─────────────────────────────────────────────────────────────────

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const KLAVIYO_REVISION = "2025-10-15";

async function klaviyo(method: "GET" | "POST", path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> | null; error?: string }> {
  const key = env.klaviyoApiKey;
  if (!key) return { ok: false, status: 0, json: null, error: "Klaviyo not configured" };
  try {
    const res = await fetch(`${KLAVIYO_BASE}${path}`, {
      method,
      headers: { Authorization: `Klaviyo-API-Key ${key}`, revision: KLAVIYO_REVISION, "Content-Type": "application/vnd.api+json", Accept: "application/vnd.api+json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, ...(res.ok ? {} : { error: text.slice(0, 300) }) };
  } catch (err) {
    return { ok: false, status: 0, json: null, error: err instanceof Error ? err.message : String(err) };
  }
}

interface KlaviyoMarketing {
  consent?: string;
  suppression?: Array<{ reason?: string }>;
}

/**
 * True when this profile must not be emailed: unsubscribed, or on a suppression list (bounce, spam complaint…).
 * `ownEmail` (--via resend, we send it ourselves): the suppression we applied to stay under Klaviyo's free-plan cap
 * (reason USER_SUPPRESSED, see src/lib/email/consent.ts) does not block; the person's own opt-outs still do, and our
 * unsubscribes are re-checked in Turso at send time.
 */
export function klaviyoBlocks(marketing: KlaviyoMarketing | null | undefined, opts: { ownEmail?: boolean } = {}): boolean {
  if (!marketing) return false;
  if ((marketing.consent ?? "").toUpperCase() === "UNSUBSCRIBED") return true;
  if (opts.ownEmail) return suppressionBlocks(marketing.suppression);
  return Array.isArray(marketing.suppression) && marketing.suppression.length > 0;
}

/**
 * Klaviyo's verdict for an email: "blocked", "ok" (no profile = nothing blocks), or "error" (unknown — the script then
 * EXCLUDES the customer: the safe side is to miss one, never to email someone who opted out).
 */
export async function klaviyoStatus(email: string, opts: { ownEmail?: boolean } = {}): Promise<"ok" | "blocked" | "error"> {
  const filter = encodeURIComponent(`equals(email,"${email.replace(/"/g, "")}")`);
  const r = await klaviyo("GET", `/profiles/?filter=${filter}&additional-fields[profile]=subscriptions`);
  if (!r.ok || !r.json) return "error";
  const data = r.json.data as Array<{ attributes?: { subscriptions?: { email?: { marketing?: KlaviyoMarketing } } } }> | undefined;
  if (!data || data.length === 0) return "ok";
  return data.some((p) => klaviyoBlocks(p.attributes?.subscriptions?.email?.marketing, opts)) ? "blocked" : "ok";
}

export interface ReferralProfileProps {
  code: string;
  code_ami: string;
  langue: "fr" | "en";
  code_expire: string;
  code_ami_expire: string;
}

/** profile-import body: creates or updates the profile with the `parrainage` property, no consent change. */
export function profileImportBody(email: string, props: ReferralProfileProps) {
  return {
    data: {
      type: "profile",
      attributes: { email, properties: { parrainage: props } },
    },
  };
}

/** Upsert the profile's `parrainage` property; returns the Klaviyo profile id. */
export async function upsertReferralProfile(email: string, props: ReferralProfileProps): Promise<{ ok: boolean; profileId?: string; error?: string }> {
  const r = await klaviyo("POST", "/profile-import/", profileImportBody(email, props));
  const id = (r.json?.data as { id?: string } | undefined)?.id;
  return r.ok && id ? { ok: true, profileId: id } : { ok: false, error: r.error ?? `status ${r.status}` };
}

/** Add a profile to a list (membership only — consent is untouched). */
export async function addProfileToList(listId: string, profileId: string): Promise<{ ok: boolean; error?: string }> {
  const r = await klaviyo("POST", `/lists/${encodeURIComponent(listId)}/relationships/profiles/`, { data: [{ type: "profile", id: profileId }] });
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? `status ${r.status}` };
}
