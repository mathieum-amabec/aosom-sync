/**
 * register-en-translations — register missing EN title translations for the
 * taxonomy category COLLECTIONS (46) and the taxonomie-categories MENU items (41)
 * via the Shopify Translations API (translationsRegister). Store is FR-primary
 * with EN published; these entities had no EN title, so EN shoppers saw French
 * category names in nav and on collection pages.
 *
 * ZERO theme edits — data (translations) only, all through the Admin GraphQL API.
 *
 * USAGE (x64 Node, prod creds, through tsx):
 *   # dry-run (default — resolves EN + digests, prints plan, NO writes):
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/register-en-translations.mts
 *   # apply:
 *   …scripts/register-en-translations.mts --apply
 *
 * RATE LIMIT: all Admin API calls serialized to ~1.9 req/s (520ms gap).
 */

const STORE = "27u5y2-kp.myshopify.com";
const API = "2025-01";
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN ?? "";
const APPLY = process.argv.includes("--apply") && !process.argv.includes("--dry-run");

// ── throttle + GraphQL ───────────────────────────────────────────────────────
let lastReq = 0;
async function gql(query: string, variables?: Record<string, unknown>): Promise<any> {
  const wait = 520 - (Date.now() - lastReq);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReq = Date.now();
  const res = await fetch(`https://${STORE}/admin/api/${API}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

// ── EN dictionaries ──────────────────────────────────────────────────────────
// Collections keyed by HANDLE (user-provided mappings + logical fills for the
// unlisted ones, marked GEN).
const COLLECTION_EN: Record<string, string> = {
  "enfants": "Kids & Toys",
  "nouveaux-arrivages": "New Arrivals",
  "meubles-deco": "Furniture & Decor",
  "meubles-salon": "Living Room Furniture",
  "meubles-chambre": "Bedroom Furniture",
  "meubles-cuisine-salle-a-manger": "Kitchen & Dining Furniture",
  "meubles-rangement": "Storage & Organization",
  "meubles-salle-de-bain": "Bathroom Furniture", // GEN
  "meubles-decoration": "Home Decor",
  "deco-saisonniere": "Seasonal & Christmas Decor", // GEN
  "exterieur-et-jardin": "Outdoor & Garden",
  "patio-mobilier": "Patio Furniture",
  "patio-chaises-longues": "Loungers & Deck Chairs", // GEN
  "patio-ombrage": "Patio Shade",
  "jardin-jardinage": "Garden & Gardening",
  "exterieur-bbq": "BBQ & Outdoor Cooking",
  "exterieur-foyers": "Outdoor Fire Pits", // GEN
  "patio-balancoires-hamacs": "Swings & Hammocks", // GEN
  "exterieur-camping": "Camping & Outdoors",
  "electro-climatisation-ventilation": "Air Conditioning & Fans",
  "electro-petit-electromenager": "Small Appliances",
  "animaux": "Pet Accessories",
  "animaux-chiens": "Dog Accessories",
  "animaux-chats": "Cat Accessories",
  "animaux-petits": "Small Animals",
  "animaux-oiseaux": "Bird Accessories",
  "enfants-jouets": "Toys", // GEN
  "enfants-jeux-exterieur": "Outdoor Play",
  "enfants-meubles": "Kids Furniture",
  "bureau-et-travail": "Office & Work",
  "bureau-chaises": "Office Chairs",
  "bureau-bureaux": "Desks",
  "bureau-rangement": "Office Storage",
  "sport-et-loisirs": "Sports & Leisure",
  "sport-exercice": "Exercise Equipment",
  "sport-velos-trottinettes": "Bikes & Scooters", // GEN
  "sport-equipe": "Team Sports", // GEN
  "sport-salle-de-jeux": "Game Room",
  "bricolage-et-outils": "DIY & Tools",
  "sante-et-beaute": "Health & Beauty",
  "gazebos-et-pergolas": "Gazebos & Pergolas",
  "jardin-eclairage": "Garden Lighting",
  "jardin-decoration": "Garden Decor",
  "piscines-et-spas": "Pools & Spas",
  "electro-chauffage": "Heating",
  "enfants-vehicules": "Kids Ride-Ons",
};

// Menu items keyed by FR LABEL (menu uses concise labels vs the collection titles).
const MENU_EN: Record<string, string> = {
  "Meubles & Déco": "Furniture & Decor",
  "Salon": "Living Room",
  "Chambre": "Bedroom",
  "Cuisine & Salle à manger": "Kitchen & Dining",
  "Rangement": "Storage",
  "Salle de bain": "Bathroom",
  "Décoration": "Home Decor",
  "Déco saisonnière & Noël": "Seasonal & Christmas Decor",
  "Extérieur & Jardin": "Outdoor & Garden",
  "Mobilier de patio": "Patio Furniture",
  "Gazébos & Pergolas": "Gazebos & Pergolas",
  "Chaises longues & Transats": "Loungers & Deck Chairs",
  "Parasols & Ombrage": "Patio Shade",
  "Jardinage & Serres": "Garden & Gardening",
  "BBQ & Grils": "BBQ & Outdoor Cooking",
  "Foyers extérieurs": "Outdoor Fire Pits",
  "Balançoires & Hamacs": "Swings & Hammocks",
  "Camping & Plein air": "Camping & Outdoors",
  "Animaux": "Pets",
  "Chiens": "Dogs",
  "Chats": "Cats",
  "Petits animaux": "Small Animals",
  "Oiseaux": "Birds",
  "Enfants & Jouets": "Kids & Toys",
  "Jouets": "Toys",
  "Jeux d’extérieur": "Outdoor Play",
  "Meubles pour enfants": "Kids Furniture",
  "Bureau & Travail": "Office & Work",
  "Chaises de bureau": "Office Chairs",
  "Bureaux & Postes de travail": "Desks",
  "Rangement de bureau": "Office Storage",
  "Sports & Loisirs": "Sports & Leisure",
  "Équipement d’exercice": "Exercise Equipment",
  "Vélos & Trottinettes": "Bikes & Scooters",
  "Sports d’équipe": "Team Sports",
  "Salle de jeux": "Game Room",
  "Électro & Tech": "Appliances & Tech",
  "Climatisation & Ventilation": "Air Conditioning & Fans",
  "Petit électroménager": "Small Appliances",
  "Bricolage & Outils": "DIY & Tools",
  "Santé & Beauté": "Health & Beauty",
};

interface Target { gid: string; label: string; en: string; digest?: string; alreadyEn?: boolean; }

async function collectionTargets(): Promise<Target[]> {
  const out: Target[] = [];
  let after: string | null = null;
  for (let pg = 0; pg < 10; pg++) {
    const q = `{ collections(first:100${after ? `, after:"${after}"` : ""}){ pageInfo{ hasNextPage endCursor } edges{ node{ id handle title translations(locale:"en"){ key } } } } }`;
    const d = await gql(q);
    const edges = d.data?.collections?.edges ?? [];
    for (const e of edges) {
      const hasEn = (e.node.translations ?? []).some((t: any) => t.key === "title");
      if (hasEn) continue;
      const en = COLLECTION_EN[e.node.handle];
      if (!en) { console.warn(`⚠ no EN mapping for collection handle "${e.node.handle}" (${e.node.title}) — SKIPPED`); continue; }
      out.push({ gid: e.node.id, label: `${e.node.handle} · ${e.node.title}`, en });
    }
    if (!d.data?.collections?.pageInfo?.hasNextPage) break;
    after = d.data.collections.pageInfo.endCursor;
  }
  return out;
}

async function menuTargets(): Promise<Target[]> {
  // Menu item labels are translated as LINK resources (gid://shopify/Link/…),
  // NOT MenuItem. Discover LINK resources whose FR title is one of our taxonomy
  // labels; the digest comes inline. (This also covers identical labels in other
  // menus, giving a consistent EN nav — harmless since only taxonomy labels match.)
  const out: Target[] = [];
  let after: string | null = null;
  for (let pg = 0; pg < 5; pg++) {
    const q = `{ translatableResources(first:250, resourceType: LINK${after ? `, after:"${after}"` : ""}){ pageInfo{ hasNextPage endCursor } nodes{ resourceId translatableContent{ key value digest } } } }`;
    const d = await gql(q);
    for (const n of d.data?.translatableResources?.nodes ?? []) {
      const c = (n.translatableContent ?? []).find((x: any) => x.key === "title");
      if (!c) continue;
      const en = MENU_EN[c.value];
      if (!en) continue; // only taxonomy labels
      out.push({ gid: n.resourceId, label: `menu · ${c.value}`, en, digest: c.digest });
    }
    if (!d.data?.translatableResources?.pageInfo?.hasNextPage) break;
    after = d.data.translatableResources.pageInfo.endCursor;
  }
  return out;
}

/** Fetch the "title"-key digest for targets that don't already have one (collections). */
async function attachDigests(targets: Target[]): Promise<void> {
  const need = targets.filter((t) => !t.digest);
  for (let i = 0; i < need.length; i += 100) {
    const batch = need.slice(i, i + 100);
    const ids = batch.map((t) => `"${t.gid}"`).join(",");
    const q = `{ translatableResourcesByIds(first:100, resourceIds:[${ids}]){ nodes{ resourceId translatableContent{ key digest } } } }`;
    const d = await gql(q);
    if (d.errors) console.warn("digest query errors:", JSON.stringify(d.errors));
    const byId = new Map<string, any>();
    for (const n of d.data?.translatableResourcesByIds?.nodes ?? []) byId.set(n.resourceId, n);
    for (const t of batch) {
      const node = byId.get(t.gid);
      const c = (node?.translatableContent ?? []).find((x: any) => x.key === "title");
      t.digest = c?.digest;
      if (!t.digest) console.warn(`⚠ no "title" translatable digest for ${t.label}`);
    }
  }
}

async function register(t: Target): Promise<{ ok: boolean; err?: string }> {
  const mut = `mutation($id:ID!,$tr:[TranslationInput!]!){ translationsRegister(resourceId:$id, translations:$tr){ userErrors{ field message } translations{ key value locale } } }`;
  const d = await gql(mut, { id: t.gid, tr: [{ locale: "en", key: "title", value: t.en, translatableContentDigest: t.digest }] });
  const ue = d.data?.translationsRegister?.userErrors ?? d.errors;
  if (ue && ue.length) return { ok: false, err: JSON.stringify(ue) };
  return { ok: true };
}

async function main(): Promise<void> {
  console.log(`\n🌐 register-en-translations — ${APPLY ? "APPLY" : "DRY-RUN (no writes)"}\n`);
  const cols = await collectionTargets();
  const menu = await menuTargets();
  const all = [...cols, ...menu];
  console.log(`Collections missing EN: ${cols.length} | Menu items missing EN: ${menu.length} | total: ${all.length}\n`);
  await attachDigests(all);

  console.log("PLAN (label → EN):");
  for (const t of all) console.log(`  ${t.digest ? " " : "✗"} ${t.label}  →  "${t.en}"`);

  const ready = all.filter((t) => t.digest && !t.alreadyEn);
  const already = all.filter((t) => t.alreadyEn).length;
  const noDigest = all.filter((t) => !t.digest).length;
  console.log(`\n${ready.length} ready to register` +
    `${already ? `, ${already} already have EN (skipped)` : ""}` +
    `${noDigest ? `, ${noDigest} no digest (skipped)` : ""}.`);

  if (!APPLY) { console.log("\nDRY-RUN — re-run with --apply to register."); return; }

  let ok = 0, fail = 0;
  for (const t of ready) {
    const r = await register(t);
    if (r.ok) { ok++; if (ok % 20 === 0) console.log(`  …${ok}/${ready.length}`); }
    else { fail++; console.log(`  ✗ ${t.label}: ${r.err}`); }
  }
  console.log(`\n=== DONE — registered ${ok}/${ready.length} (failed ${fail}) ===`);
}

main().catch((e) => { console.error(e); process.exit(1); });
