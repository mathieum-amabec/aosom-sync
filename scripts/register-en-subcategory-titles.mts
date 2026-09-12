/**
 * register-en-subcategory-titles — register missing EN title translations for the
 * subcategory COLLECTIONS that feed the landing page's popular-subcategory tile
 * grid, plus the Judge.me all-reviews page the section links to.
 *
 * WHY ALL OF THEM, not just today's eight tiles: the grid is re-ranked weekly by
 * /api/cron/trend-scores, so any of the ~74 rankable subcategory collections can
 * take a tile on any given Monday. Audited 2026-09-11, 40 of the 74 had NO EN
 * title at all — today's eight happen to be translated, so the gap would only
 * have surfaced weeks later as French labels on furnishdirect.ca.
 *
 * ZERO theme edits, zero product edits — Translations API only
 * (`translationsRegister`), the same mechanism as
 * scripts/register-en-translations.mts.
 *
 * USAGE (x64 Node, prod creds, through tsx):
 *   # dry-run (default — resolves digests, prints the plan, NO writes):
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/register-en-subcategory-titles.mts
 *   # apply:
 *   …scripts/register-en-subcategory-titles.mts --apply
 *
 * RATE LIMIT: all Admin API calls serialised to ~1.9 req/s (520 ms gap).
 */

const STORE = "27u5y2-kp.myshopify.com";
const API = "2025-01";
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
const APPLY = process.argv.includes("--apply") && !process.argv.includes("--dry-run");
const LOCALE = "en";

if (!TOKEN) throw new Error("SHOPIFY_ACCESS_TOKEN missing (use --env-file=.env.local)");

interface GqlEnvelope<T> {
  data?: T;
  errors?: { message: string }[];
}

let lastReq = 0;
async function gql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<GqlEnvelope<T>> {
  const wait = 520 - (Date.now() - lastReq);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
  const res = await fetch(`https://${STORE}/admin/api/${API}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return res.json() as Promise<GqlEnvelope<T>>;
}

/**
 * EN titles, keyed by collection HANDLE. Plain retail category names — no
 * supplier brand may appear in client-facing copy, and none does here.
 */
const EN_TITLES: Record<string, string> = {
  // Bureau / office
  "bureau-bureaux-ordinateur": "Computer Desks",
  "bureau-bureaux-ecriture": "Writing Desks",
  "bureau-chaises-travail": "Task Chairs",
  "bureau-fauteuils-massants": "Massage Office Chairs",
  // Chambre / bedroom
  "chambre-tables-de-chevet": "Bedside Tables",
  "chambre-coiffeuses": "Dressing & Vanity Tables",
  "chambre-miroirs": "Mirrors",
  "chambre-bases-de-lit": "Bed Frames & Bases",
  // Cuisine & salle à manger / kitchen & dining
  "cuisine-tables-a-manger": "Dining Tables",
  "cuisine-chaises-salle-a-manger": "Dining Chairs",
  "cuisine-ensembles-table-chaises": "Dining Table Sets",
  "cuisine-tabourets-bar": "Bar Stools",
  "cuisine-tables-bar": "Bar Tables",
  "cuisine-ensembles-bar": "Bar Sets",
  "cuisine-bars-cabinets": "Bars & Bar Cabinets",
  "cuisine-ilots-chariots": "Kitchen Islands & Carts",
  // Salon / living room
  "salon-tables-basses": "Coffee Tables",
  "salon-tables-appoint": "Side Tables",
  "salon-tables-console": "Console Tables",
  "salon-meubles-tv": "TV Stands",
  "salon-sectionnels": "Sectional Sofas",
  "salon-causeuses": "Loveseats",
  "salon-canapes-3-places": "3-Seater Sofas",
  "salon-canapes-simples": "Single Sofas",
  "salon-fauteuils-appoint": "Accent Chairs",
  "salon-fauteuils-releveurs": "Electric Power Lift Chairs",
  "salon-cloisons-paravents": "Room Dividers & Screens",
  // Rangement / storage
  "rangement-armoires": "Storage Cabinets",
  "rangement-garde-manger": "Kitchen Pantries",
  "rangement-bibliotheques": "Bookshelves & Bookcases",
  "rangement-penderies": "Clothing Storage",
  "rangement-range-chaussures": "Shoe Storage",
  "rangement-poufs-bancs": "Storage Ottomans & Benches",
  // Patio & jardin / outdoor
  "patio-remises-jardin": "Garden Sheds",
  "patio-bacs-galvanises": "Galvanized Raised Garden Beds",
  "patio-parasols-droits": "Straight Patio Umbrellas",
  "patio-parasols-deportes": "Cantilever Patio Umbrellas",
  "patio-bases-parasol": "Umbrella Bases",
  "patio-gazebos-toit-rigide": "Hardtop Gazebos",
  "patio-gazebos-toit-souple": "Soft Top Gazebos",
};

/** The Judge.me all-reviews page the homepage reviews section links to. */
const PAGE_TITLES: Record<string, string> = {
  "avis-clients": "Customer Reviews",
};

interface TranslatableField {
  key: string;
  value?: string;
  digest?: string;
}

/** Resolve id + FR title digest for every published collection, keyed by handle. */
async function loadCollections(): Promise<
  Map<string, { id: string; title: string; digest: string; existingEn?: string }>
> {
  const out = new Map<string, { id: string; title: string; digest: string; existingEn?: string }>();
  let cursor: string | null = null;
  for (;;) {
    const res: GqlEnvelope<{
      collections: {
        pageInfo: { hasNextPage: boolean; endCursor: string };
        nodes: Array<{
          id: string;
          handle: string;
          title: string;
          translations: Array<{ key: string; value: string }>;
        }>;
      };
    }> = await gql(
      `query($c: String) {
        collections(first: 100, after: $c) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id handle title
            translations(locale: "${LOCALE}") { key value }
          }
        }
      }`,
      { c: cursor },
    );
    if (res.errors?.length) throw new Error(JSON.stringify(res.errors).slice(0, 400));
    const page = res.data?.collections;
    if (!page) break;
    for (const n of page.nodes) {
      out.set(n.handle, {
        id: n.id,
        title: n.title,
        digest: "",
        existingEn: n.translations.find((t) => t.key === "title")?.value,
      });
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return out;
}

/** Resolve id + FR title digest for every page, keyed by handle. */
async function loadPages(): Promise<Map<string, { id: string; title: string; digest: string; existingEn?: string }>> {
  const res: GqlEnvelope<{
    pages: {
      nodes: Array<{
        id: string;
        handle: string;
        title: string;
        translations: Array<{ key: string; value: string }>;
      }>;
    };
  }> = await gql(
    `{
      pages(first: 100) {
        nodes {
          id handle title
          translations(locale: "${LOCALE}") { key value }
        }
      }
    }`,
  );
  if (res.errors?.length) throw new Error(JSON.stringify(res.errors).slice(0, 400));
  const out = new Map<string, { id: string; title: string; digest: string; existingEn?: string }>();
  for (const n of res.data?.pages.nodes ?? []) {
    out.set(n.handle, {
      id: n.id,
      title: n.title,
      digest: "",
      existingEn: n.translations.find((t) => t.key === "title")?.value,
    });
  }
  return out;
}

/**
 * Resolve the "title" translatable digest for a batch of resource gids.
 * `translatableContent` lives on TranslatableResource, not on Collection/Page,
 * so it has to be fetched through `translatableResourcesByIds`.
 */
async function loadTitleDigests(gids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < gids.length; i += 100) {
    const batch = gids.slice(i, i + 100);
    const res: GqlEnvelope<{
      translatableResourcesByIds: {
        nodes: Array<{ resourceId: string; translatableContent: TranslatableField[] }>;
      };
    }> = await gql(
      `query($ids: [ID!]!) {
        translatableResourcesByIds(first: 100, resourceIds: $ids) {
          nodes { resourceId translatableContent { key digest } }
        }
      }`,
      { ids: batch },
    );
    if (res.errors?.length) throw new Error(JSON.stringify(res.errors).slice(0, 400));
    for (const n of res.data?.translatableResourcesByIds.nodes ?? []) {
      const digest = n.translatableContent.find((c) => c.key === "title")?.digest;
      if (digest) out.set(n.resourceId, digest);
    }
  }
  return out;
}

async function registerTitle(resourceId: string, value: string, digest: string): Promise<string[]> {
  const res: GqlEnvelope<{ translationsRegister: { userErrors: { message: string }[] } }> = await gql(
    `mutation($id: ID!, $t: [TranslationInput!]!) {
      translationsRegister(resourceId: $id, translations: $t) {
        userErrors { field message }
      }
    }`,
    {
      id: resourceId,
      t: [{ key: "title", locale: LOCALE, value, translatableContentDigest: digest }],
    },
  );
  const errs = [
    ...(res.errors ?? []).map((e) => e.message),
    ...(res.data?.translationsRegister.userErrors ?? []).map((e) => e.message),
  ];
  return errs;
}

async function main(): Promise<void> {
  const collections = await loadCollections();
  const pages = await loadPages();

  interface Plan {
    kind: "collection" | "page";
    handle: string;
    id: string;
    fr: string;
    en: string;
    digest: string;
  }
  const plan: Plan[] = [];
  const skipped: string[] = [];
  const unknown: string[] = [];

  for (const [handle, en] of Object.entries(EN_TITLES)) {
    const c = collections.get(handle);
    if (!c) {
      unknown.push(`collection ${handle}`);
      continue;
    }
    if (c.existingEn?.trim()) {
      skipped.push(`${handle} (already "${c.existingEn}")`);
      continue;
    }
    plan.push({ kind: "collection", handle, id: c.id, fr: c.title, en, digest: c.digest });
  }

  for (const [handle, en] of Object.entries(PAGE_TITLES)) {
    const p = pages.get(handle);
    if (!p) {
      unknown.push(`page ${handle}`);
      continue;
    }
    if (p.existingEn?.trim()) {
      skipped.push(`${handle} (already "${p.existingEn}")`);
      continue;
    }
    plan.push({ kind: "page", handle, id: p.id, fr: p.title, en, digest: p.digest });
  }

  const digests = await loadTitleDigests(plan.map((p) => p.id));
  const noDigest = plan.filter((p) => !digests.get(p.id)).map((p) => p.handle);
  for (const p of plan) p.digest = digests.get(p.id) ?? "";

  console.log(`to register : ${plan.length}`);
  if (noDigest.length) console.log(`NO DIGEST   : ${noDigest.join(", ")}`);
  console.log(`already set : ${skipped.length}`);
  if (unknown.length) console.log(`NOT FOUND   : ${unknown.join(", ")}`);
  for (const p of plan) {
    console.log(`  [${p.kind}] ${p.handle.padEnd(34)} "${p.fr}" → "${p.en}"`);
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Re-run with --apply.");
    return;
  }

  let ok = 0;
  const failed: string[] = [];
  for (const p of plan) {
    if (!p.digest) { failed.push(`${p.handle}: no title digest`); continue; }
    const errs = await registerTitle(p.id, p.en, p.digest);
    if (errs.length) failed.push(`${p.handle}: ${errs.join("; ")}`);
    else ok++;
  }
  console.log(`\nregistered=${ok} failed=${failed.length}`);
  failed.forEach((f) => console.log(`  FAIL ${f}`));
}

await main();
