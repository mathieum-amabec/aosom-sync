/**
 * Klaviyo API client (revision 2023-10-15).
 *
 * A thin, rate-limited wrapper over the two server-side calls aosom-sync needs:
 * - `identifyProfile(email, props)` — create/locate a profile (upsert-ish).
 * - `trackEvent(metric, email, props)` — record a metric performed by a profile.
 *
 * Every Klaviyo event MUST be attached to a profile (a real recipient with an
 * email). aosom-sync's catalog/sync jobs have no customer in scope, so this
 * client is a ready capability, NOT wired into import-pipeline/job1 — the
 * browse/cart/price-drop flows are driven by Klaviyo's onsite tracking +
 * Shopify catalog sync (see docs/KLAVIYO-SETUP.md). Use this client only where a
 * real recipient email is available (e.g. a future price-drop "notify me" list).
 *
 * No-ops (returns `{ ok: false, skipped: true }`) when KLAVIYO_API_KEY is unset,
 * so callers can be wired defensively without breaking when the key is absent.
 */
import { env } from "./config";

const KLAVIYO_BASE = "https://a.klaviyo.com/api";
const KLAVIYO_REVISION = "2023-10-15";
const REQUEST_TIMEOUT_MS = 10_000;
// 10 requests/second max → enforce a 100ms minimum gap between requests.
const MIN_INTERVAL_MS = 100;

export interface KlaviyoResult {
  ok: boolean;
  /** True when the call was skipped because no API key is configured. */
  skipped?: boolean;
  status?: number;
  error?: string;
}

export function isKlaviyoConfigured(): boolean {
  return !!env.klaviyoApiKey;
}

// Basic RFC-ish email sanity check — Klaviyo rejects events without a valid
// profile identifier, so fail fast rather than burning a request.
function isValidEmail(email: string): boolean {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ─── Rate limiting ──────────────────────────────────────────────────────
// Serialize requests through a promise chain and space them ≥ MIN_INTERVAL_MS
// apart so we never exceed 10 req/s, even under concurrent callers.
let chain: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function schedule<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  });
  // Keep the chain alive even if one request rejects.
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function klaviyoPost(path: string, body: unknown): Promise<KlaviyoResult> {
  const key = env.klaviyoApiKey;
  if (!key) {
    return { ok: false, skipped: true };
  }
  return schedule(async () => {
    try {
      const res = await fetch(`${KLAVIYO_BASE}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Klaviyo-API-Key ${key}`,
          revision: KLAVIYO_REVISION,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      // 409 on profile create = the profile already exists; that's success for
      // an upsert-style identify.
      if (res.ok || res.status === 409) {
        return { ok: true, status: res.status };
      }
      return { ok: false, status: res.status, error: `Klaviyo ${res.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/**
 * Create or locate a Klaviyo profile for `email`, setting custom properties.
 * Treats a 409 (already exists) as success.
 */
export async function identifyProfile(
  email: string,
  properties: Record<string, unknown> = {},
): Promise<KlaviyoResult> {
  if (!isValidEmail(email)) {
    return { ok: false, error: "invalid email" };
  }
  return klaviyoPost("/profiles/", {
    data: {
      type: "profile",
      attributes: {
        email,
        ...(Object.keys(properties).length > 0 ? { properties } : {}),
      },
    },
  });
}

/**
 * Record that the profile identified by `email` performed `metric`, with
 * optional event properties. Requires a valid recipient email.
 */
export async function trackEvent(
  metric: string,
  email: string,
  properties: Record<string, unknown> = {},
): Promise<KlaviyoResult> {
  if (!metric || !metric.trim()) {
    return { ok: false, error: "metric name required" };
  }
  if (!isValidEmail(email)) {
    return { ok: false, error: "invalid email" };
  }
  return klaviyoPost("/events/", {
    data: {
      type: "event",
      attributes: {
        properties,
        metric: { data: { type: "metric", attributes: { name: metric } } },
        profile: { data: { type: "profile", attributes: { email } } },
      },
    },
  });
}

async function klaviyoGet(url: string): Promise<{ ok: boolean; json?: Record<string, unknown> }> {
  const key = env.klaviyoApiKey;
  if (!key) return { ok: false };
  return schedule(async () => {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Klaviyo-API-Key ${key}`, revision: KLAVIYO_REVISION, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return res.ok ? { ok: true, json: (await res.json()) as Record<string, unknown> } : { ok: false };
    } catch {
      return { ok: false };
    }
  });
}

/**
 * Units our store sold per Shopify product id, from Klaviyo's "Ordered Product" events (one per order line, written by
 * the Shopify integration). Used where the Shopify token cannot read orders (no read_orders scope). `days` bounds the
 * window; `maxPages` bounds the cost. Never throws: an empty map when Klaviyo is not configured or unreachable.
 */
export async function fetchOrderedProductUnits(days = 365, maxPages = 20): Promise<Map<string, number>> {
  const units = new Map<string, number>();
  const metrics = await klaviyoGet(`${KLAVIYO_BASE}/metrics/`);
  const list = (metrics.json?.data ?? []) as Array<{ id: string; attributes?: { name?: string } }>;
  const metric = list.find((m) => m.attributes?.name === "Ordered Product");
  if (!metric) return units;
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  let url: string | null =
    `${KLAVIYO_BASE}/events/?filter=${encodeURIComponent(`equals(metric_id,"${metric.id}"),greater-than(datetime,${since})`)}`;
  for (let page = 0; url && page < maxPages; page++) {
    const r = await klaviyoGet(url);
    if (!r.ok || !r.json) break;
    for (const e of (r.json.data ?? []) as Array<{ attributes?: { event_properties?: Record<string, unknown> } }>) {
      const p = e.attributes?.event_properties ?? {};
      const id = p.ProductID;
      if (id === undefined || id === null || id === "") continue;
      const qty = Number(p.Quantity ?? 1);
      units.set(String(id), (units.get(String(id)) ?? 0) + (Number.isFinite(qty) && qty > 0 ? qty : 1));
    }
    url = ((r.json.links ?? {}) as { next?: string | null }).next ?? null;
  }
  return units;
}
