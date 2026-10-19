/**
 * Margin guard (Mat, 2026-10-18: "aucun de nos produits ne devrait passer sous notre coût, malgré les rabais").
 *
 * The profit floor in sell-price-rule.ts keeps every Aosom price profitable as long as no item can get more than
 * MAX_DISCOUNT off. This daily check proves both halves against the live store:
 *
 *   1. DISCOUNTS — every ACTIVE Shopify discount: the most one item can lose to it, and whether discounts combine.
 *      Anything above MAX_DISCOUNT (or a discount we cannot bound: app discount, fixed amount without a minimum)
 *      breaks the floor's assumption and is flagged.
 *   2. PRICES — every variant of every active product against our cost (Aosom: wholesale + delivery from today's feed;
 *      Costway: feed price less the dropship discount). A variant that loses money with the biggest active discount
 *      and the card fees is flagged.
 *
 * Read-only: it reports (dashboard notification); the fix is the sell-price sync (Aosom) or a reprice (Costway).
 */
import { shopifyFetch, parseLinkHeader } from "@/lib/shopify-client";
import { createNotification, ensureSchema } from "@/lib/database";
import { fetchAosomCatalog } from "@/lib/csv-fetcher";
import { costOf } from "@/lib/costway/pricing";
import { MAX_DISCOUNT, netProfit } from "@/lib/sell-price-rule";

// ─── 1. Discounts ────────────────────────────────────────────────────────────

export interface DiscountInfo {
  title: string;
  typename: string;
  /** Percentage (0..1), or null. */
  percentage: number | null;
  /** Fixed amount in $, or null. */
  amount: number | null;
  /** True when a fixed amount comes off EACH item (vs once per order). */
  amountOnEachItem: boolean;
  /** Minimum subtotal in $, or null. */
  minSubtotal: number | null;
  combinesWithProduct: boolean;
  combinesWithOrder: boolean;
}

export interface DiscountVerdict {
  title: string;
  /** The most one item can lose to this discount (0..1), or null when it cannot be bounded. */
  maxPerItem: number | null;
  problem: string | null;
}

/** The most one item can lose to a discount, as a fraction of its price. Null = cannot be bounded. Free shipping: 0. */
export function maxPerItem(d: DiscountInfo): number | null {
  if (/FreeShipping/.test(d.typename)) return 0;
  if (/App/.test(d.typename)) return null;
  if (d.percentage != null) return d.percentage;
  if (d.amount != null) {
    // A fixed amount once per order weighs at most amount / minimum subtotal; per item, or without a minimum, it is
    // unbounded (a 20 $ item could lose 20 $).
    if (d.amountOnEachItem || !d.minSubtotal || d.minSubtotal <= 0) return null;
    return d.amount / d.minSubtotal;
  }
  return null;
}

export function evaluateDiscounts(active: DiscountInfo[], limit = MAX_DISCOUNT): { verdicts: DiscountVerdict[]; worst: number; problems: string[] } {
  const verdicts: DiscountVerdict[] = active.map((d) => {
    const m = maxPerItem(d);
    let problem: string | null = null;
    if (m === null) problem = `« ${d.title} » : rabais impossible à borner (montant fixe sans minimum, par article, ou rabais d'app)`;
    else if (m > limit + 1e-9) problem = `« ${d.title} » : jusqu'à ${Math.round(m * 100)} % sur un article (plancher calculé pour ${Math.round(limit * 100)} %)`;
    return { title: d.title, maxPerItem: m, problem };
  });
  const problems = verdicts.filter((v) => v.problem).map((v) => v.problem as string);
  // Discounts that may stack on the same item: worst case is their sum.
  const priced = active.filter((d) => !/FreeShipping/.test(d.typename));
  const stackable = priced.filter((d) => d.combinesWithProduct || d.combinesWithOrder);
  let worst = Math.max(0, ...verdicts.map((v) => v.maxPerItem ?? 1));
  if (stackable.length >= 2) {
    const sum = stackable.reduce((s, d) => s + (maxPerItem(d) ?? 1), 0);
    if (sum > limit + 1e-9) problems.push(`${stackable.length} rabais peuvent se cumuler (${stackable.map((d) => `« ${d.title} »`).join(", ")}) : jusqu'à ${Math.round(sum * 100)} % sur un article`);
    worst = Math.max(worst, sum);
  }
  return { verdicts, worst: Math.min(worst, 1), problems };
}

// ─── 2. Prices ───────────────────────────────────────────────────────────────

export interface PricedVariant {
  sku: string;
  handle: string;
  price: number;
  source: "aosom" | "costway";
}

export interface LossVariant extends PricedVariant {
  cost: number;
  /** What we keep with the worst discount and the card fees (negative = loss). */
  profit: number;
}

export function findLosses(variants: PricedVariant[], costs: ReadonlyMap<string, number>, discount: number): { losses: LossVariant[]; withoutCost: number } {
  const losses: LossVariant[] = [];
  let withoutCost = 0;
  for (const v of variants) {
    const cost = costs.get(v.sku);
    if (cost == null || !(cost > 0) || !(v.price > 0)) { withoutCost++; continue; }
    const profit = netProfit(v.price, cost, discount);
    if (profit < 0) losses.push({ ...v, cost, profit });
  }
  losses.sort((a, b) => a.profit - b.profit);
  return { losses, withoutCost };
}

// ─── Wiring ──────────────────────────────────────────────────────────────────

async function gql<T>(query: string): Promise<T> {
  const res = await shopifyFetch("/graphql.json", { method: "POST", body: JSON.stringify({ query }) });
  const j = (await res.json()) as { data?: T; errors?: unknown };
  if (!res.ok || j.errors || !j.data) throw new Error(`margin-guard GraphQL failed: ${JSON.stringify(j.errors ?? res.status).slice(0, 300)}`);
  return j.data;
}

const VALUE = `__typename ... on DiscountPercentage{percentage} ... on DiscountAmount{amount{amount} appliesOnEachItem} ... on DiscountOnQuantity{effect{__typename ... on DiscountPercentage{percentage} ... on DiscountAmount{amount{amount}}}}`;
const MIN = `minimumRequirement{__typename ... on DiscountMinimumSubtotal{greaterThanOrEqualToSubtotal{amount}}}`;
const CW = `combinesWith{productDiscounts orderDiscounts}`;

type RawValue = { __typename: string; percentage?: number; amount?: { amount: string }; appliesOnEachItem?: boolean; effect?: RawValue } | null;
type RawDiscount = {
  __typename: string;
  title?: string;
  status?: string;
  combinesWith?: { productDiscounts: boolean; orderDiscounts: boolean };
  minimumRequirement?: { __typename: string; greaterThanOrEqualToSubtotal?: { amount: string } } | null;
  customerGets?: { value: RawValue };
};

export function toDiscountInfo(x: RawDiscount): DiscountInfo {
  let v = x.customerGets?.value ?? null;
  if (v?.effect) v = v.effect;
  const min = x.minimumRequirement?.greaterThanOrEqualToSubtotal?.amount;
  return {
    title: x.title ?? "(sans titre)",
    typename: x.__typename,
    percentage: typeof v?.percentage === "number" ? v.percentage : null,
    amount: v?.amount ? Number(v.amount.amount) : null,
    amountOnEachItem: !!v?.appliesOnEachItem,
    minSubtotal: min != null ? Number(min) : null,
    combinesWithProduct: !!x.combinesWith?.productDiscounts,
    combinesWithOrder: !!x.combinesWith?.orderDiscounts,
  };
}

// Paginated: every Roue de bienvenue spin creates its own single-use code (live 72 h), so the active list can pass 100
// and a risky manual discount must not fall off the first page.
async function loadActiveDiscounts(): Promise<DiscountInfo[]> {
  const out: DiscountInfo[] = [];
  let after: string | null = null;
  for (let page = 0; page < 50; page++) {
    const d: { discountNodes: { nodes: Array<{ discount: RawDiscount }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } =
      await gql(discountsQuery(after));
    out.push(...d.discountNodes.nodes.map((n) => n.discount).filter((x) => x.status === "ACTIVE").map(toDiscountInfo));
    if (!d.discountNodes.pageInfo.hasNextPage || !d.discountNodes.pageInfo.endCursor) break;
    after = d.discountNodes.pageInfo.endCursor;
  }
  return out;
}

function discountsQuery(after: string | null): string {
  return `{ discountNodes(first: 100, query: "status:active"${after ? `, after: ${JSON.stringify(after)}` : ""}) { pageInfo { hasNextPage endCursor } nodes { discount { __typename
    ... on DiscountAutomaticBasic { title status ${CW} ${MIN} customerGets { value { ${VALUE} } } }
    ... on DiscountAutomaticBxgy { title status ${CW} customerGets { value { ${VALUE} } } }
    ... on DiscountAutomaticFreeShipping { title status ${CW} }
    ... on DiscountAutomaticApp { title status ${CW} }
    ... on DiscountCodeBasic { title status ${CW} ${MIN} customerGets { value { ${VALUE} } } }
    ... on DiscountCodeBxgy { title status ${CW} customerGets { value { ${VALUE} } } }
    ... on DiscountCodeFreeShipping { title status ${CW} }
    ... on DiscountCodeApp { title status ${CW} }
  } } } }`;
}

async function loadActiveVariants(): Promise<PricedVariant[]> {
  const out: PricedVariant[] = [];
  let pageInfo: string | null = null;
  for (let i = 0; i < 100; i++) {
    const params = new URLSearchParams({ limit: "250", fields: "handle,tags,variants" });
    if (pageInfo) params.set("page_info", pageInfo);
    else params.set("status", "active");
    const res = await shopifyFetch(`/products.json?${params}`);
    if (!res.ok) throw new Error(`margin-guard: products fetch failed ${res.status}`);
    const data = (await res.json()) as { products: Array<{ handle: string; tags: string; variants: Array<{ sku: string; price: string }> }> };
    for (const p of data.products) {
      const source = p.tags.split(",").map((t) => t.trim()).includes("src-c") ? "costway" : "aosom";
      for (const v of p.variants) if (v.sku) out.push({ sku: v.sku, handle: p.handle, price: Number(v.price), source });
    }
    pageInfo = parseLinkHeader(res.headers.get("Link"));
    if (!pageInfo) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return out;
}

async function loadCosts(): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  for (const p of await fetchAosomCatalog()) if (typeof p.cost === "number" && p.cost > 0) m.set(p.sku, p.cost);
  const db = await ensureSchema();
  const r = await db.execute(`SELECT internal_sku, price FROM costway_products WHERE internal_sku IS NOT NULL AND price > 0`);
  for (const row of r.rows) m.set(String(row.internal_sku), costOf(Number(row.price)));
  return m;
}

export interface MarginGuardReport {
  discounts: DiscountVerdict[];
  /** The most one item can lose today (all active discounts, stacking included). */
  worstDiscount: number;
  discountProblems: string[];
  variants: number;
  withoutCost: number;
  losses: LossVariant[];
  notified: boolean;
}

export async function runMarginGuard(opts: { notify?: boolean } = {}): Promise<MarginGuardReport> {
  const disc = evaluateDiscounts(await loadActiveDiscounts());
  const [variants, costs] = await Promise.all([loadActiveVariants(), loadCosts()]);
  // Prices are checked against the larger of the floor's assumption and what the store really allows today.
  const discount = Math.max(MAX_DISCOUNT, disc.worst);
  const { losses, withoutCost } = findLosses(variants, costs, discount);

  let notified = false;
  if (opts.notify !== false && (disc.problems.length > 0 || losses.length > 0)) {
    const lines = [...disc.problems];
    if (losses.length) {
      lines.push(
        `${losses.length} variante(s) à perte avec ${Math.round(discount * 100)} % de rabais + frais de carte — ` +
          losses.slice(0, 8).map((l) => `${l.handle} (${l.price} $, coût ${l.cost} $, ${l.profit} $)`).join(" ; "),
      );
    }
    await createNotification("warning", "Marge à vérifier", lines.join("\n"));
    notified = true;
  }
  return { discounts: disc.verdicts, worstDiscount: disc.worst, discountProblems: disc.problems, variants: variants.length, withoutCost, losses, notified };
}
