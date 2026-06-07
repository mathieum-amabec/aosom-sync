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
