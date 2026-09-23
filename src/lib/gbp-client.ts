/**
 * Google Business Profile (GBP) API client — publishes weekly "local posts".
 *
 * Auth: OAuth2 refresh-token flow, same installed-app pattern as scripts/google-ads-oauth.mjs
 * (can reuse the same Cloud project client id/secret — only the scope differs). The access
 * token is short-lived and re-minted on every call; there is no caching here because this
 * client is called at most once a week (see api/cron/gbp-post).
 *
 * IMPORTANT — this is NOT a self-serve API like Meta's Graph API. Writing local posts
 * requires a Google-approved Business Profile API access request (Cloud Console form,
 * verified GBP active 60+ days, real business website, approval takes days to weeks) before
 * any of this can work end to end. See docs/GBP-SETUP.md. No-ops when unconfigured so the
 * generator pipeline can run (and store posts as pending_review) even before that access
 * exists — only the final publish call needs it.
 */
import { env } from "./config";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://mybusiness.googleapis.com/v4";
const REQUEST_TIMEOUT_MS = 20_000;

export function isGbpConfigured(): boolean {
  return env.hasGbp;
}

async function getAccessToken(): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.gbpClientId || "",
      client_secret: env.gbpClientSecret || "",
      refresh_token: env.gbpRefreshToken || "",
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`[gbp] token refresh failed: ${body.error_description || body.error || res.status}`);
  }
  return body.access_token as string;
}

export interface LocalPostInput {
  /** ≤1500 chars — Google truncates the preview at ~100 chars, aim for the hook up front. */
  summary: string;
  /** Absolute URL — the product page this post drives to. */
  actionUrl: string;
  /** Defaults to "SHOP"; falls back to "LEARN_MORE" if Google rejects SHOP for this account
   * type (some GBP categories don't support every CTA — see callGbp's retry). */
  actionType?: "SHOP" | "LEARN_MORE" | "ORDER";
  /** Public image URL — 1200x900 (4:3) JPG/PNG recommended, 10KB-5MB. */
  imageUrl?: string;
}

export interface LocalPostResult {
  name: string; // "accounts/{account}/locations/{location}/localPosts/{post}"
  searchUrl?: string;
}

/**
 * Publish a STANDARD local post. Throws on failure — callers (the approve route) are
 * expected to surface the error to whoever clicked approve, not swallow it silently, since
 * a failed real-world publish needs a human to know.
 */
export async function createLocalPost(input: LocalPostInput): Promise<LocalPostResult> {
  if (!isGbpConfigured()) {
    throw new Error("[gbp] not configured (missing OAuth credentials, account id, or location id) — see docs/GBP-SETUP.md");
  }
  const accessToken = await getAccessToken();
  const parent = `${env.gbpAccountId}/${env.gbpLocationId}`;

  const body: Record<string, unknown> = {
    languageCode: "fr",
    summary: input.summary,
    topicType: "STANDARD",
    callToAction: {
      actionType: input.actionType || "SHOP",
      url: input.actionUrl,
    },
  };
  if (input.imageUrl) {
    body.media = [{ mediaFormat: "PHOTO", sourceUrl: input.imageUrl }];
  }

  const res = await fetch(`${API_BASE}/${parent}/localPosts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`[gbp] createLocalPost ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = JSON.parse(text);
  return { name: data.name, searchUrl: data.searchUrl };
}
