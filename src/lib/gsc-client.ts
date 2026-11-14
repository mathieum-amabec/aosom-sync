/**
 * Google Search Console client (read-only) — service-account auth, no extra dependency.
 *
 * Why a service account and not OAuth: the project's OAuth refresh tokens die after ~7 days while the consent screen is
 * in "Testing" (see the Google Ads token), which would silently break a daily SEO import. A service account has no
 * expiry; it only needs to be added as a (Restricted) user of the Search Console property.
 *
 * Env:
 *   GSC_SERVICE_ACCOUNT_JSON  the service-account key JSON, as-is or base64-encoded (Vercel env, never committed)
 *   GSC_SITE_URL              the property exactly as Search Console lists it: "sc-domain:ameublodirect.ca" (domain
 *                             property) or "https://ameublodirect.ca/" (URL-prefix property)
 *
 * Unconfigured → every call reports `configured: false` instead of throwing, so the cron and the page degrade to a
 * "not connected" state with the setup steps.
 */
import { createSign } from "node:crypto";

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/webmasters/v3";

export interface GscConfig {
  clientEmail: string;
  privateKey: string;
  siteUrl: string;
}

export type GscConfigResult = { configured: true; config: GscConfig } | { configured: false; missing: string[] };

export function readGscConfig(env: Record<string, string | undefined> = process.env): GscConfigResult {
  const missing: string[] = [];
  const raw = env.GSC_SERVICE_ACCOUNT_JSON?.trim();
  const site = env.GSC_SITE_URL?.trim();
  if (!raw) missing.push("GSC_SERVICE_ACCOUNT_JSON");
  if (!site) missing.push("GSC_SITE_URL");
  if (missing.length) return { configured: false, missing };
  let parsed: { client_email?: string; private_key?: string };
  try {
    const text = raw!.startsWith("{") ? raw! : Buffer.from(raw!, "base64").toString("utf8");
    parsed = JSON.parse(text);
  } catch {
    return { configured: false, missing: ["GSC_SERVICE_ACCOUNT_JSON (illisible)"] };
  }
  if (!parsed.client_email || !parsed.private_key) return { configured: false, missing: ["GSC_SERVICE_ACCOUNT_JSON (client_email / private_key manquants)"] };
  return { configured: true, config: { clientEmail: parsed.client_email, privateKey: parsed.private_key.replace(/\\n/g, "\n"), siteUrl: site! } };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

/** RS256-signed JWT assertion for the service-account token exchange. */
export function buildJwtAssertion(cfg: Pick<GscConfig, "clientEmail" | "privateKey">, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: cfg.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  return `${header}.${claim}.${b64url(signer.sign(cfg.privateKey))}`;
}

type FetchLike = typeof fetch;
let cached: { token: string; exp: number; email: string } | null = null;

export async function getAccessToken(cfg: GscConfig, fetchImpl: FetchLike = fetch): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.email === cfg.clientEmail && cached.exp - 60 > now) return cached.token;
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: buildJwtAssertion(cfg, now) }),
  });
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new Error(`Google token exchange failed: ${res.status} ${json.error ?? ""} ${json.error_description ?? ""}`.trim());
  cached = { token: json.access_token, exp: now + (json.expires_in ?? 3600), email: cfg.clientEmail };
  return json.access_token;
}

export function resetGscTokenCache(): void {
  cached = null;
}

export interface SearchRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchQuery {
  startDate: string;
  endDate: string;
  dimensions: Array<"date" | "page" | "query" | "country" | "device">;
  rowLimit?: number;
  startRow?: number;
  type?: "web" | "image" | "video" | "news" | "discover" | "googleNews";
}

async function apiFetch(cfg: GscConfig, path: string, init: RequestInit, fetchImpl: FetchLike): Promise<Response> {
  const token = await getAccessToken(cfg, fetchImpl);
  return fetchImpl(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
}

/** One page of Search Analytics rows (max 25,000 per call). */
export async function querySearchAnalytics(cfg: GscConfig, q: SearchQuery, fetchImpl: FetchLike = fetch): Promise<SearchRow[]> {
  const res = await apiFetch(
    cfg,
    `/sites/${encodeURIComponent(cfg.siteUrl)}/searchAnalytics/query`,
    { method: "POST", body: JSON.stringify({ startDate: q.startDate, endDate: q.endDate, dimensions: q.dimensions, rowLimit: q.rowLimit ?? 25000, startRow: q.startRow ?? 0, type: q.type ?? "web", dataState: "final" }) },
    fetchImpl,
  );
  if (!res.ok) throw new Error(`Search Analytics query failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { rows?: SearchRow[] };
  return json.rows ?? [];
}

/** Every row for a query, following startRow pagination up to `maxRows`. */
export async function queryAll(cfg: GscConfig, q: SearchQuery, maxRows = 50000, fetchImpl: FetchLike = fetch): Promise<SearchRow[]> {
  const out: SearchRow[] = [];
  const page = 25000;
  while (out.length < maxRows) {
    const rows = await querySearchAnalytics(cfg, { ...q, rowLimit: Math.min(page, maxRows - out.length), startRow: out.length }, fetchImpl);
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

export interface SiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

/** Properties the service account can see — the connection test. */
export async function listSites(cfg: GscConfig, fetchImpl: FetchLike = fetch): Promise<SiteEntry[]> {
  const res = await apiFetch(cfg, "/sites", { method: "GET" }, fetchImpl);
  if (!res.ok) throw new Error(`Search Console sites list failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { siteEntry?: SiteEntry[] };
  return json.siteEntry ?? [];
}
