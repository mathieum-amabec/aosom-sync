/**
 * Daily read-only sweep of the live Shopify catalog for the three defects found in
 * the 2026-09 catalog content investigation:
 *  - English body_html (diff-engine bug, fixed v0.5.92.3 — this is the ongoing
 *    tripwire in case of a regression or a manual edit that reintroduces it)
 *  - a forbidden supplier brand name leaking into body_html
 *  - duplicate EN/FR "Couleur" option values on the same product (variant-merger.ts
 *    fix, fix/color-option-en-fr-duplicate — same tripwire purpose)
 *
 * Detect-only, matching the price-audit / image-compliance "journalise et notifie
 * sans bloquer" convention: this module NEVER writes to Shopify. The write-time
 * guards that stop new instances of these three defects live at the point content
 * is generated (content-generator.ts's stripSupplierBrands + language check) and
 * where color is derived (variant-merger.ts's translateColor) — this sweep exists
 * to catch drift on the existing catalog (a manual Shopify edit, a future code
 * regression, an import that bypassed the normal pipeline), not to replace those
 * guards.
 */
import { shopifyFetch } from "./shopify-client";
import { translateColor } from "./variant-merger";
import { detectDescriptionLanguage, forbiddenBrandsIn } from "./catalog-guard";
import { setSetting } from "./database";

const CATALOG_CONSISTENCY_SETTING = "catalog_consistency_audit";
/** Cap the persisted issue list so the settings row stays small; totals above are exact. */
const MAX_PERSISTED_ISSUES = 200;

export type CatalogIssueKind = "english_description" | "brand_leak" | "duplicate_color_option";

export interface CatalogConsistencyIssue {
  shopifyId: string;
  handle: string;
  title: string;
  kind: CatalogIssueKind;
  detail: string;
}

export interface CatalogConsistencyResult {
  auditedAt: number;
  totalActive: number;
  englishDescriptions: number;
  brandLeaks: number;
  duplicateColorOptions: number;
  issues: CatalogConsistencyIssue[];
}

interface RawShopifyVariant {
  sku: string;
  option1: string | null;
  option2: string | null;
  option3: string | null;
}

interface RawShopifyOption {
  name: string;
  values: string[];
}

interface RawShopifyProduct {
  id: number;
  title: string;
  handle: string;
  status: string;
  body_html: string;
  options: RawShopifyOption[];
  variants: RawShopifyVariant[];
}

function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  const m = header.match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
}

/** Strip the scheme+host+api-version prefix Shopify's Link header includes, so the
 * URL can be re-passed to shopifyFetch (which adds that same prefix itself). */
function toEndpoint(nextUrl: string): string {
  return nextUrl.replace(/^https:\/\/[^/]+\/admin\/api\/[^/]+/, "");
}

async function fetchActiveProductsForAudit(): Promise<RawShopifyProduct[]> {
  const out: RawShopifyProduct[] = [];
  let endpoint: string | null =
    "/products.json?limit=250&fields=id,title,handle,status,body_html,options,variants";
  while (endpoint) {
    const res = await shopifyFetch(endpoint);
    if (!res.ok) throw new Error(`Shopify fetch failed: ${res.status}`);
    const data = await res.json();
    for (const p of (data.products ?? []) as RawShopifyProduct[]) {
      if (p.status === "active") out.push(p);
    }
    const next = parseNextLink(res.headers.get("link") ?? res.headers.get("Link"));
    endpoint = next ? toEndpoint(next) : null;
  }
  return out;
}

/**
 * A "Couleur" option carries two (or more) distinct raw values that translateColor()
 * — the same function the import pipeline and daily sync use — collapses to the same
 * French spelling. That means the product shows two swatches for one color.
 */
export function detectDuplicateColorOption(product: RawShopifyProduct): string | null {
  const colorOption = (product.options ?? []).find((o) => /^couleur$/i.test(o.name));
  if (!colorOption) return null;
  const values = [...new Set(colorOption.values)];
  if (values.length < 2) return null;

  const byCanonical = new Map<string, string[]>();
  for (const v of values) {
    const fr = translateColor(v);
    const list = byCanonical.get(fr) ?? [];
    list.push(v);
    byCanonical.set(fr, list);
  }
  for (const [fr, raws] of byCanonical) {
    if (raws.length > 1) return `${raws.map((r) => `"${r}"`).join(" + ")} both translate to "${fr}"`;
  }
  return null;
}

export async function runCatalogConsistencyAudit(): Promise<CatalogConsistencyResult> {
  const products = await fetchActiveProductsForAudit();
  const issues: CatalogConsistencyIssue[] = [];
  let englishDescriptions = 0;
  let brandLeaks = 0;
  let duplicateColorOptions = 0;

  for (const p of products) {
    const base = { shopifyId: String(p.id), handle: p.handle, title: p.title };

    const { lang } = detectDescriptionLanguage(p.body_html);
    if (lang === "EN") {
      englishDescriptions++;
      issues.push({ ...base, kind: "english_description", detail: "body_html reads as English" });
    }

    const leaks = forbiddenBrandsIn(p.body_html);
    if (leaks.length > 0) {
      brandLeaks++;
      issues.push({ ...base, kind: "brand_leak", detail: `leaks: ${leaks.join(", ")}` });
    }

    const dupDetail = detectDuplicateColorOption(p);
    if (dupDetail) {
      duplicateColorOptions++;
      issues.push({ ...base, kind: "duplicate_color_option", detail: dupDetail });
    }
  }

  return {
    auditedAt: Math.floor(Date.now() / 1000),
    totalActive: products.length,
    englishDescriptions,
    brandLeaks,
    duplicateColorOptions,
    issues: issues.slice(0, MAX_PERSISTED_ISSUES),
  };
}

/** Persist a compact summary to `settings` (same convention as price-audit's
 * PRICE_AUDIT_SETTING) so the dashboard can show the last audit without re-running
 * the Shopify sweep. */
export async function persistCatalogConsistencyAudit(result: CatalogConsistencyResult): Promise<void> {
  await setSetting(CATALOG_CONSISTENCY_SETTING, JSON.stringify(result));
}

export { CATALOG_CONSISTENCY_SETTING };
