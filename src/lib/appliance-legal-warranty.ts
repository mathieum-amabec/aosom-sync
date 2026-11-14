/**
 * LPC art. 38.1 (in force 2026-10-05) — legal warranty of good working order:
 *   6 years: refrigerators (incl. mini / beverage / wine fridges), freezers, cooking ranges, air conditioners, heat pumps
 *   5 years: washers, dryers, dishwashers
 * Art. 38.8 requires the duration near the price; the theme shows it from the product tag
 * `garantie-legale-6ans` / `garantie-legale-5ans`, and never offers the paid Garantie Tranquillité on them.
 *
 * Classification is deliberately conservative and keyword-based on handle + title + product type
 * (FR handles/titles are what the importer writes; types come from the supplier taxonomy). It reproduces
 * the 65-product manual review of 2026-11-02 exactly (tests/appliance-legal-warranty.test.ts).
 */
import { shopifyFetch } from "@/lib/shopify-client";
import { createNotification } from "@/lib/database";
export const LEGAL_WARRANTY_TAGS = { 6: "garantie-legale-6ans", 5: "garantie-legale-5ans" } as const;
export type LegalYears = 5 | 6;

export interface ApplianceCandidate {
  handle: string;
  title?: string | null;
  productType?: string | null;
  tags?: string[] | string | null;
}

// Furniture / accessories / toys whose words overlap an appliance name.
const NOT_APPLIANCE =
  /jouet|toy|enfant|kids|meuble|cabinet|armoire|support|stand|housse|cover|etagere|shelf|rangement|organisateur|panier|sechoir-a-linge|seche-linge-pliant|drying-rack|foyer|fireplace|deshumidif|dehumidif|ventilateur|fan\b|glacons|ice-maker|micro-onde|microwave|pizza|espresso|cafe/;

const SIX = [
  /refrigerateur|frigo|fridge|refrigerator/,
  /congel|freezer/, // includes supplier typos (congeleteur, congeleuro)
  /refroidisseur-a-(vin|boissons?)|wine-cooler|beverage-cooler|cellier/,
  /climatiseur|air-conditioner|mini-split|thermopompe|heat-pump/,
  /^cuisiniere-(electrique|au-gaz|a-induction)|range-oven/,
];
const FIVE = [
  /laveuse|machine-a-laver|washing-machine|washer/,
  /secheuse|clothes-dryer|dryer-machine/,
  /lave-vaisselle|dishwasher/,
];

function slug(s: string | null | undefined): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}

export function classifyAppliance(p: ApplianceCandidate): LegalYears | null {
  const handle = slug(p.handle);
  const type = slug(p.productType);
  const tags = Array.isArray(p.tags) ? p.tags : String(p.tags ?? "").split(",");
  const tagText = slug(tags.join(" "));
  // The handle (FR, from the title) is the primary signal; the supplier type backs it up.
  const hay = `${handle} ${type}`;
  // Portable ACs often "also dehumidify": an air conditioner wins over the dehumidifier exclusion.
  if (/climatiseur|air-conditioner|mini-split|thermopompe|heat-pump/.test(hay) && !/jouet|toy|housse|cover|support|stand/.test(handle)) return 6;
  if (NOT_APPLIANCE.test(handle)) return null;
  if (FIVE.some((re) => re.test(hay))) return 5;
  if (SIX.some((re) => re.test(hay))) return 6;
  // 12 V compressor car fridges are sold as "glacière" but tagged as refrigerators.
  if (/glaciere/.test(handle) && /refrigerat|frigo|fridge/.test(tagText)) return 6;
  return null;
}

// ── daily guard ─────────────────────────────────────────────────────────────────────────────────

export interface ApplianceGuardReport {
  activeProducts: number;
  /** Appliances already carrying the right tag. */
  alreadyTagged: number;
  /** Newly tagged this run (handle → years). */
  tagged: Array<{ handle: string; years: LegalYears }>;
  /** Tagged in Shopify but not recognised by the classifier (left untouched — a human tagged it). */
  manualOnly: string[];
  failed: Array<{ handle: string; error: string }>;
  notified: boolean;
}

const MAX_TAGS_PER_RUN = 60;

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  await new Promise((r) => setTimeout(r, 400)); // ≤ 2 req/s
  const res = await shopifyFetch("/graphql.json", { method: "POST", body: JSON.stringify({ query, variables }) });
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: unknown };
  if (json.errors || !json.data) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

/**
 * Tags every ACTIVE art. 38.1 appliance with its legal-warranty tag (additive only — never removes a tag,
 * so a manual tag always wins). New imports get the tag within a day, which makes the theme show
 * "Garantie légale de bon fonctionnement : N ans" near the price and hides the paid warranty offer.
 */
export async function runApplianceLegalWarrantyGuard(opts: { dryRun?: boolean; notify?: boolean } = {}): Promise<ApplianceGuardReport> {
  type Node = { id: string; handle: string; title: string; productType: string; tags: string[] };
  const nodes: Node[] = [];
  let cursor: string | null = null;
  do {
    const d: { products: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: Node[] } } = await gql(
      `query($c: String) { products(first: 250, after: $c, query: "status:active") {
         pageInfo { hasNextPage endCursor } nodes { id handle title productType tags } } }`,
      { c: cursor },
    );
    nodes.push(...d.products.nodes);
    cursor = d.products.pageInfo.hasNextPage ? d.products.pageInfo.endCursor : null;
  } while (cursor);

  const all = Object.values(LEGAL_WARRANTY_TAGS) as string[];
  const report: ApplianceGuardReport = { activeProducts: nodes.length, alreadyTagged: 0, tagged: [], manualOnly: [], failed: [], notified: false };
  for (const p of nodes) {
    const years = classifyAppliance(p);
    const has = p.tags.filter((t) => all.includes(t));
    if (!years) {
      if (has.length) report.manualOnly.push(p.handle);
      continue;
    }
    if (has.length) { report.alreadyTagged++; continue; } // any legal tag present: a human or an earlier run decided
    if (report.tagged.length >= MAX_TAGS_PER_RUN) break;
    if (!opts.dryRun) {
      try {
        const r: { tagsAdd: { userErrors: Array<{ message: string }> } } = await gql(
          `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
          { id: p.id, tags: [LEGAL_WARRANTY_TAGS[years]] },
        );
        if (r.tagsAdd.userErrors.length) throw new Error(r.tagsAdd.userErrors.map((e) => e.message).join("; "));
      } catch (err) {
        report.failed.push({ handle: p.handle, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
    }
    report.tagged.push({ handle: p.handle, years });
  }

  if (!opts.dryRun && opts.notify !== false && (report.tagged.length || report.failed.length)) {
    const lines = [
      ...report.tagged.map((t) => `✓ ${t.handle} → garantie légale ${t.years} ans`),
      ...report.failed.map((f) => `✗ ${f.handle} : ${f.error}`),
    ];
    await createNotification(
      report.failed.length ? "warning" : "info",
      "Électroménagers : garantie légale affichée",
      `${report.tagged.length} nouvel(s) électroménager(s) tagué(s) (art. 38.1 LPC, durée affichée près du prix, garantie payante masquée).\n${lines.join("\n")}`,
    );
    report.notified = true;
  }
  return report;
}
