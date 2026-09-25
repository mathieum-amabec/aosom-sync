/**
 * Daily read-only guard on the ad feeds (Google, Meta, Pinterest, Bing, Reddit all come out of
 * one mapper, shopifyToFeedItems). It protects the v0.5.92.24 fix: every multi-variant offer
 * must deep-link to ITS variant (`?variant={id}`) and show ITS assigned photo, single-variant
 * offers must stay bare, and the feed Google actually downloads must reflect that.
 *
 * Two layers, because the served feed reads Shopify through a 24 h Data Cache that nothing
 * refreshes after the daily sync — comparing it straight against live Shopify would raise false
 * alarms every morning:
 *  1. LOGIC (exhaustive, exact): the production mapper runs on a FRESH Shopify read and every
 *     item is checked against the invariants recomputed independently from the raw products.
 *     Any violation is a code/data regression → red.
 *  2. SERVED (what Google/Meta download): the production Google feed URL is fetched and
 *     compared item by item with layer 1. A small drift is the cache catching up (tolerated
 *     up to SERVED_DRIFT_MAX); beyond that, a feed with no `?variant=` links, or a volume drop
 *     against yesterday, is red. Five random multi-variant links are also opened on the real
 *     storefront to confirm the theme preselects that exact variant.
 *
 * NEVER writes to Shopify. Persists one summary row (settings.feed_integrity_audit) that
 * guard-status.ts turns into the dashboard / morning-report verdict.
 */
import { shopifyFetch } from "./shopify-client";
import { setSetting, getSetting } from "./database";
import { shopifyToFeedItems, type ShopifyFeedProduct } from "./feeds/source";
import type { FeedItem } from "./feeds/feed";
import { getPublicAppUrl } from "./config";

export const FEED_INTEGRITY_SETTING = "feed_integrity_audit";
/** Served items allowed to differ from a fresh generation (24 h cache lag) before it is red. */
export const SERVED_DRIFT_MAX = 0.05;
/** Day-over-day drops that are red: total items −10 %, `?variant=` links −20 %. */
export const TOTAL_DROP_MAX = 0.1;
export const VARIANT_LINK_DROP_MAX = 0.2;
export const LANDING_SAMPLE = 5;
const MAX_EXAMPLES = 10;

export type LogicViolationKind =
  | "missing_variant_link"
  | "wrong_variant_link"
  | "single_has_variant_link"
  | "image_mismatch";

export interface LogicCheck {
  items: number;
  multiItems: number;
  singleItems: number;
  variantLinks: number;
  ownImageItems: number;
  violations: Record<LogicViolationKind, number>;
  examples: Array<{ id: string; kind: LogicViolationKind; detail: string }>;
}

const stripQuery = (u: string) => u.split("?")[0];
const variantParam = (link: string): string | null => /[?&]variant=([^&#]+)/.exec(link)?.[1] ?? null;

/** Invariants recomputed from the raw Shopify products — deliberately NOT by calling back into
 *  the mapper, so a mapper regression cannot validate itself. */
export function checkFeedLogic(products: ShopifyFeedProduct[], items: FeedItem[]): LogicCheck {
  const bySku = new Map<string, { p: ShopifyFeedProduct; v: NonNullable<ShopifyFeedProduct["variants"]>[number]; multi: boolean }>();
  for (const p of products) {
    const vs = (p.variants ?? []).filter((v) => v.sku && String(v.sku).trim() !== "");
    for (const v of vs) if (!bySku.has(String(v.sku))) bySku.set(String(v.sku), { p, v, multi: vs.length > 1 });
  }
  const violations: Record<LogicViolationKind, number> = {
    missing_variant_link: 0, wrong_variant_link: 0, single_has_variant_link: 0, image_mismatch: 0,
  };
  const examples: LogicCheck["examples"] = [];
  const flag = (id: string, kind: LogicViolationKind, detail: string) => {
    violations[kind]++;
    if (examples.length < MAX_EXAMPLES) examples.push({ id, kind, detail });
  };
  let multiItems = 0, variantLinks = 0, ownImageItems = 0;
  for (const it of items) {
    const hit = bySku.get(it.id);
    if (!hit) continue; // cannot happen for mapper output; ignore rather than guess
    const { p, v, multi } = hit;
    const param = variantParam(it.link);
    if (param) variantLinks++;
    if (multi) {
      multiItems++;
      if (!param) flag(it.id, "missing_variant_link", it.link);
      else if (v.id != null && param !== String(v.id)) flag(it.id, "wrong_variant_link", `${param} ≠ ${v.id}`);
    } else if (param) {
      flag(it.id, "single_has_variant_link", it.link);
    }
    const images = (p.images ?? []).filter((i) => i.src);
    const own = v.image_id != null ? images.find((i) => i.id != null && String(i.id) === String(v.image_id)) : undefined;
    if (own) ownImageItems++;
    const expected = own ? own.src : images[0]?.src;
    if (expected && stripQuery(it.imageLink) !== stripQuery(expected)) {
      flag(it.id, "image_mismatch", `${stripQuery(it.imageLink).split("/").pop()} ≠ ${stripQuery(expected).split("/").pop()}`);
    }
  }
  return { items: items.length, multiItems, singleItems: items.length - multiItems, variantLinks, ownImageItems, violations, examples };
}

export interface ServedItem { id: string; link: string; imageLink: string }

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** Items of the served Google RSS feed (only the three fields the guard compares). */
export function parseGoogleFeed(xml: string): ServedItem[] {
  const out: ServedItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const body = m[1];
    const tag = (t: string) => { const x = new RegExp(`<${t}>([^<]*)</${t}>`).exec(body); return x ? decodeXml(x[1].trim()) : ""; };
    const id = tag("g:id");
    if (id) out.push({ id, link: tag("link"), imageLink: tag("g:image_link") });
  }
  return out;
}

export interface ServedCheck {
  items: number;
  variantLinks: number;
  /** Items whose link or image differ from a fresh generation (cache lag or a stale deploy). */
  drifted: number;
  driftRatio: number;
  missing: number;
  examples: Array<{ id: string; detail: string }>;
}

export function compareServedFeed(served: ServedItem[], fresh: FeedItem[]): ServedCheck {
  const freshById = new Map(fresh.map((i) => [i.id, i]));
  let drifted = 0;
  const examples: ServedCheck["examples"] = [];
  for (const s of served) {
    const f = freshById.get(s.id);
    if (!f) continue; // item already gone from Shopify: that is the cache, counted via `missing` inversely
    const linkDiff = s.link !== f.link;
    const imgDiff = stripQuery(s.imageLink) !== stripQuery(f.imageLink);
    if (linkDiff || imgDiff) {
      drifted++;
      if (examples.length < MAX_EXAMPLES) examples.push({ id: s.id, detail: linkDiff ? `lien ${s.link}` : `image ${stripQuery(s.imageLink).split("/").pop()}` });
    }
  }
  const servedIds = new Set(served.map((s) => s.id));
  const missing = fresh.filter((f) => !servedIds.has(f.id)).length;
  return {
    items: served.length,
    variantLinks: served.filter((s) => variantParam(s.link)).length,
    drifted,
    driftRatio: served.length ? drifted / served.length : 0,
    missing,
    examples,
  };
}

/** Selected variant id rendered by the storefront theme (Dawn: `<script data-selected-variant>`). */
export function extractSelectedVariantId(html: string): string | null {
  const m = /<script[^>]*data-selected-variant[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  try {
    const v = JSON.parse(m[1]) as { id?: unknown };
    return v && v.id != null ? String(v.id) : null;
  } catch {
    return null;
  }
}

export type LandingOutcome = "ok" | "wrong_variant" | "no_marker" | "unreachable";
export interface LandingCheck { id: string; link: string; expected: string; outcome: LandingOutcome; got?: string | null }

export interface FeedIntegrityDeps {
  fetchProducts: () => Promise<ShopifyFeedProduct[]>;
  /** Body of the served Google feed, or null when the public URL is unknown. */
  fetchServedFeed: () => Promise<string | null>;
  fetchLanding: (url: string) => Promise<string | null>;
  previous: () => Promise<FeedIntegrityResult | null>;
  random?: () => number;
  now?: () => number;
}

export interface FeedIntegrityResult {
  auditedAt: number;
  ok: boolean;
  /** Human-readable red reasons (French — shown as-is in the dashboard and the email). */
  reasons: string[];
  logic: LogicCheck;
  served: ServedCheck | null;
  landing: LandingCheck[];
  volume: { previousItems: number | null; previousVariantLinks: number | null };
}

const pct = (x: number) => `${Math.round(x * 100)} %`;

export async function runFeedIntegrityAudit(deps: FeedIntegrityDeps): Promise<FeedIntegrityResult> {
  const random = deps.random ?? Math.random;
  const reasons: string[] = [];

  // 1. Logic on fresh data.
  const products = await deps.fetchProducts();
  const fresh = shopifyToFeedItems(products);
  const logic = checkFeedLogic(products, fresh);
  const v = logic.violations;
  if (v.missing_variant_link) reasons.push(`${v.missing_variant_link} offre(s) multi-variantes sans lien ?variant=`);
  if (v.wrong_variant_link) reasons.push(`${v.wrong_variant_link} lien(s) ?variant= vers la mauvaise variante`);
  if (v.single_has_variant_link) reasons.push(`${v.single_has_variant_link} offre(s) à variante unique avec un ?variant= inattendu`);
  if (v.image_mismatch) reasons.push(`${v.image_mismatch} offre(s) dont la photo ne correspond pas à la variante`);

  // 2. Served feed + volume.
  const xml = await deps.fetchServedFeed();
  let served: ServedCheck | null = null;
  const prev = await deps.previous();
  if (xml == null) {
    reasons.push("flux Google publié introuvable (URL publique de l'app inconnue)");
  } else {
    const items = parseGoogleFeed(xml);
    served = compareServedFeed(items, fresh);
    if (served.items === 0) reasons.push("le flux Google publié est vide");
    else {
      if (logic.multiItems > 0 && served.variantLinks === 0) reasons.push("le flux Google publié n'a plus aucun lien ?variant=");
      if (served.driftRatio > SERVED_DRIFT_MAX) {
        reasons.push(`${served.drifted} offres du flux publié (${pct(served.driftRatio)}) diffèrent des données actuelles — cache ou déploiement en retard`);
      }
    }
    const pItems = prev?.served?.items ?? null;
    const pLinks = prev?.served?.variantLinks ?? null;
    if (pItems && served.items < pItems * (1 - TOTAL_DROP_MAX)) {
      reasons.push(`le flux publié a chuté de ${pItems} à ${served.items} offres (${pct(1 - served.items / pItems)}) depuis la veille`);
    }
    if (pLinks && served.variantLinks < pLinks * (1 - VARIANT_LINK_DROP_MAX)) {
      reasons.push(`les liens ?variant= ont chuté de ${pLinks} à ${served.variantLinks} (${pct(1 - served.variantLinks / pLinks)}) depuis la veille`);
    }
  }

  // 3. Real storefront loads: does the theme preselect the advertised variant?
  const landing: LandingCheck[] = [];
  const candidates = fresh.filter((i) => variantParam(i.link));
  const pool = [...candidates];
  for (let k = 0; k < LANDING_SAMPLE && pool.length; k++) {
    const it = pool.splice(Math.floor(random() * pool.length), 1)[0];
    const expected = variantParam(it.link)!;
    const html = await deps.fetchLanding(it.link);
    if (html == null) { landing.push({ id: it.id, link: it.link, expected, outcome: "unreachable" }); continue; }
    const got = extractSelectedVariantId(html);
    landing.push({ id: it.id, link: it.link, expected, got, outcome: got == null ? "no_marker" : got === expected ? "ok" : "wrong_variant" });
  }
  const wrong = landing.filter((l) => l.outcome === "wrong_variant").length;
  const noMarker = landing.filter((l) => l.outcome === "no_marker").length;
  const unreachable = landing.filter((l) => l.outcome === "unreachable").length;
  if (wrong) reasons.push(`${wrong}/${landing.length} page(s) produit n'ouvrent pas la variante annoncée`);
  if (noMarker) reasons.push(`${noMarker}/${landing.length} page(s) produit sans variante présélectionnée lisible (thème modifié ?)`);
  if (landing.length && unreachable > landing.length / 2) reasons.push(`${unreachable}/${landing.length} page(s) produit injoignables`);

  return {
    auditedAt: Math.floor((deps.now ? deps.now() : Date.now()) / 1000),
    ok: reasons.length === 0,
    reasons,
    logic,
    served,
    landing,
    volume: { previousItems: prev?.served?.items ?? null, previousVariantLinks: prev?.served?.variantLinks ?? null },
  };
}

// ── production dependencies ──────────────────────────────────────────────────
const FEED_FIELDS = "id,title,handle,vendor,status,product_type,body_html,images,variants,published_at,options";

async function fetchProductsFresh(): Promise<ShopifyFeedProduct[]> {
  const out: ShopifyFeedProduct[] = [];
  let endpoint: string | null = `/products.json?limit=250&fields=${FEED_FIELDS}`;
  while (endpoint) {
    const res = await shopifyFetch(endpoint); // plain fetch: not the feed's 24 h Data Cache
    if (!res.ok) throw new Error(`Shopify fetch failed: ${res.status}`);
    const data = (await res.json()) as { products?: ShopifyFeedProduct[] };
    out.push(...(data.products ?? []));
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1];
    endpoint = next ? next.replace(/^https:\/\/[^/]+\/admin\/api\/[^/]+/, "") : null;
  }
  return out;
}

async function fetchText(url: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store", headers: { "User-Agent": "aosom-sync feed-integrity guard" } });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const productionFeedIntegrityDeps: FeedIntegrityDeps = {
  fetchProducts: fetchProductsFresh,
  fetchServedFeed: async () => {
    const base = getPublicAppUrl();
    if (!base) return null;
    const xml = await fetchText(`${base}/api/feeds/google`, 120_000);
    if (xml == null) throw new Error("flux Google publié injoignable");
    return xml;
  },
  fetchLanding: (url) => fetchText(url, 20_000),
  previous: async () => {
    const raw = await getSetting(FEED_INTEGRITY_SETTING);
    try { return raw ? (JSON.parse(raw) as FeedIntegrityResult) : null; } catch { return null; }
  },
};

/** Persist the result (landing/examples included — the row stays small: ≤ 10 examples each). */
export async function persistFeedIntegrityAudit(result: FeedIntegrityResult): Promise<void> {
  await setSetting(FEED_INTEGRITY_SETTING, JSON.stringify(result));
}
