// Create the "Ameublo Direct — Google Shopping CA" Standard Shopping campaign via the
// Google Ads API, optimised for conversion VALUE rather than clicks.
//
// Object chain (all built through src/lib/google-ads-client.ts):
//   campaign_budget → campaign → locations + languages + ad_schedule + negative_keywords
//                              → ad_group → shopping ad + listing group ("all products")
//                              → sitelink assets (FR + EN) → campaign assets
//
// DRY-RUN BY DEFAULT and dry-run needs NO credentials: the client records every payload
// instead of sending it, so the full campaign can be reviewed before the Google Ads account
// even exists. `--apply` requires the complete GOOGLE_ADS_* set (see docs/GOOGLE-ADS-SETUP.md)
// and passes a conversion preflight first. Everything is created PAUSED either way — nothing
// spends until it is enabled by hand in the Google Ads UI.
//
// Run (x64 node — see CLAUDE.md "Windows ARM64"):
//   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/create-google-shopping-campaign.mts
//   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/create-google-shopping-campaign.mts --apply
//
// Flags:
//   --apply                   actually create (default: dry-run, sends nothing)
//   --daily-budget <cad>      daily budget in CAD (default 15)
//   --max-cpc <cad>           ad group CPC bid (default 1.50) — inert under smart bidding
//   --bidding <strategy>      maximize-conversion-value (default) | maximize-clicks | manual-cpc
//   --target-roas <n>         optional tROAS; omit until the account has conversion history
//   --safe-free-negatives     replace the bare "gratuit" negative with freebie-intent phrases
//                             (see the NEGATIVE KEYWORDS note below)
//   --skip-sitelinks          don't create the sitelink assets
//   --api-version <vNN>       override the Google Ads API version
//
// ── BIDDING ─────────────────────────────────────────────────────────────────────────────
// MAXIMIZE_CONVERSION_VALUE is smart bidding: Google sets every CPC from modelled conversion
// value. Two consequences the config below cannot work around:
//   • the ad group's max CPC is ignored (kept so a switch to manual-cpc is already correct);
//   • ad-schedule bid modifiers are ignored, so the "+20% evenings and weekends" does not
//     apply — the client drops the modifier rather than write a boost that never fires.
// It also needs conversion history to model value. The preflight refuses --apply when the
// account has no PURCHASE conversion action.
//
// ── NEGATIVE KEYWORDS ───────────────────────────────────────────────────────────────────
// The list is the specified one, verbatim. One term is worth knowing about: a PHRASE
// negative on "gratuit" also blocks "meubles patio livraison gratuite" — a high-intent
// commercial query, and the promise in our own "Livraison gratuite" sitelink. Pass
// --safe-free-negatives to swap it for freebie-intent phrases that keep that traffic.
//
// Supplier/competitor brand negatives are safe: verified against the live feed
// (/api/feeds/google, 2158 items) — g:brand is "Ameublo Direct" on 100% of items and no
// title contains Aosom/Outsunny/HOMCOM/PawHut, so none can be a query we want to win.

// IMPORTS: runtime values come from a DYNAMIC import, types from a type-only import.
// tsx transpiles src/**/*.ts to CJS, and node's ESM loader cannot see named exports through
// that boundary — a static `import { X } from "@/lib/…"` in a .mts fails at load with
// "does not provide an export named X". This is the same convention as
// scripts/generate-slideshow-batch.mts. `import type` is erased before runtime, so it is
// safe and still gives full type checking (these scripts ARE checked by `next build`).
import type {
  BiddingStrategy,
  NegativeKeyword,
  AdScheduleSlot,
  SitelinkInput,
  DayOfWeek,
  PlannedMutate,
} from "@/lib/google-ads-client";

const { GoogleAdsClient, readGoogleAdsCredentials, missingGoogleAdsEnv, isSmartBidding, toMicros } =
  await import("@/lib/google-ads-client");

/** The class arrives as a value, so its instance type is derived rather than imported. */
type AdsClient = InstanceType<typeof GoogleAdsClient>;

// ─── Constants ────────────────────────────────────────────────────────────────────────

const CAMPAIGN_NAME = "Ameublo Direct — Google Shopping CA";
const AD_GROUP_NAME = "Tous les produits";
const MERCHANT_CENTER_ID = "5804673777";
const FEED_LABEL = "CA";
const GEO_CANADA = "geoTargetConstants/2124";
const LANG_FRENCH = "languageConstants/1002";
const LANG_ENGLISH = "languageConstants/1000";
const STORE = "https://ameublodirect.ca";

// ─── CLI ──────────────────────────────────────────────────────────────────────────────

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
/** Print and exit. Flag parsing happens at module scope, where a thrown error would
 * escape main()'s catch and dump a raw stack trace instead of a readable message. */
function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}
function num(name: string, fallback: number): number {
  const raw = flag(name);
  if (raw === undefined) return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) fail(`--${name} must be a positive number (got "${raw}")`);
  return n;
}

const APPLY = has("apply");
const SKIP_SITELINKS = has("skip-sitelinks");
const SAFE_FREE = has("safe-free-negatives");
const DAILY_BUDGET_CAD = num("daily-budget", 15);
const MAX_CPC_CAD = num("max-cpc", 1.5);
/** undefined → the client's pinned default (GOOGLE_ADS_API_VERSION). */
const API_VERSION = flag("api-version");

const BIDDING_ARG = (flag("bidding") ?? "maximize-conversion-value").toLowerCase();
const TARGET_ROAS = flag("target-roas") ? num("target-roas", 0) : undefined;

function resolveBidding(): BiddingStrategy {
  switch (BIDDING_ARG) {
    case "maximize-conversion-value":
      return TARGET_ROAS ? { kind: "MAXIMIZE_CONVERSION_VALUE", targetRoas: TARGET_ROAS } : { kind: "MAXIMIZE_CONVERSION_VALUE" };
    case "maximize-clicks":
      return { kind: "MAXIMIZE_CLICKS", cpcBidCeilingMicros: toMicros(MAX_CPC_CAD) };
    case "manual-cpc":
      return { kind: "MANUAL_CPC" };
    default:
      fail(`--bidding must be maximize-conversion-value, maximize-clicks or manual-cpc (got "${BIDDING_ARG}")`);
  }
}

// ─── Campaign definition ──────────────────────────────────────────────────────────────

/** Spec list, verbatim. See the NEGATIVE KEYWORDS note above re: "gratuit". */
const SPEC_NEGATIVES = [
  "aosom", "outsunny", "homcom", "pawhut",
  "gratuit", "occasion",
  "walmart", "amazon", "ikea", "wayfair",
];

/** Freebie-intent replacements used by --safe-free-negatives. */
const FREEBIE_INTENT = ["meuble gratuit", "meubles gratuits", "a donner", "free furniture", "free stuff"];

function buildNegatives(): NegativeKeyword[] {
  const terms = SAFE_FREE
    ? [...SPEC_NEGATIVES.filter((t) => t !== "gratuit"), ...FREEBIE_INTENT]
    : SPEC_NEGATIVES;
  return terms.map((text) => ({ text, matchType: "PHRASE" as const }));
}

const WEEKDAYS: DayOfWeek[] = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"];
const WEEKEND: DayOfWeek[] = ["SATURDAY", "SUNDAY"];

/** 24/7 coverage; 18:00–22:00 on weekdays and all weekend carry the +20% modifier. */
function buildSchedule(): AdScheduleSlot[] {
  const weekday = WEEKDAYS.flatMap((dayOfWeek): AdScheduleSlot[] => [
    { dayOfWeek, startHour: 0, endHour: 18 },
    { dayOfWeek, startHour: 18, endHour: 22, bidModifier: 1.2 },
    { dayOfWeek, startHour: 22, endHour: 24 },
  ]);
  const weekend = WEEKEND.map((dayOfWeek): AdScheduleSlot => ({
    dayOfWeek,
    startHour: 0,
    endHour: 24,
    bidModifier: 1.2,
  }));
  return [...weekday, ...weekend];
}

// URLs verified 200 against the live storefront (2026-08-15). The EN locale ("Furnish
// Direct") is the same store under /en and reuses the FR handles.
const SITELINKS_FR: SitelinkInput[] = [
  { linkText: "Livraison gratuite", description1: "Livraison gratuite au Canada", description2: "Sur toute la boutique", finalUrl: `${STORE}/pages/politique-de-livraison` },
  { linkText: "Meubles de patio", description1: "Patio, jardin et terrasse", description2: "Collection extérieur", finalUrl: `${STORE}/collections/patio-mobilier` },
  { linkText: "Nouveaux arrivages", description1: "Les derniers produits", description2: "Ajoutés cette semaine", finalUrl: `${STORE}/collections/nouveaux-arrivages` },
  { linkText: "Rabais", description1: "Meilleures offres du moment", description2: "Rabais jusqu'à 50 %", finalUrl: `${STORE}/collections/rabais` },
];
const SITELINKS_EN: SitelinkInput[] = [
  { linkText: "Free shipping", description1: "Free shipping across Canada", description2: "On every order", finalUrl: `${STORE}/en/pages/politique-de-livraison` },
  { linkText: "Patio furniture", description1: "Patio, garden and deck", description2: "Outdoor collection", finalUrl: `${STORE}/en/collections/patio-mobilier` },
  { linkText: "New arrivals", description1: "The latest products", description2: "Added this week", finalUrl: `${STORE}/en/collections/nouveaux-arrivages` },
  { linkText: "Deals", description1: "Best offers right now", description2: "Up to 50% off", finalUrl: `${STORE}/en/collections/rabais` },
];

// ─── Reporting ────────────────────────────────────────────────────────────────────────

const indent = (s: string): string => s.split("\n").map((l) => `  ${l}`).join("\n");
const cad = (n: number): string => `$${n.toFixed(2)} CAD`;

/**
 * How the max-CPC value is actually treated, which differs per strategy — "smart bidding
 * ignores it" is true of MAXIMIZE_CONVERSION_VALUE but WRONG of MAXIMIZE_CLICKS, where the
 * same number becomes the campaign-level CPC ceiling (`target_spend.cpc_bid_ceiling_micros`)
 * even though the ad group's own `cpcBidMicros` is still ignored.
 */
function maxCpcNote(bidding: BiddingStrategy): string {
  switch (bidding.kind) {
    case "MANUAL_CPC":
      return "→ enchère de l'ad group (appliquée)";
    case "MAXIMIZE_CLICKS":
      return "→ plafond d'enchère de campagne (appliqué ; l'enchère d'ad group, elle, est ignorée)";
    case "MAXIMIZE_CONVERSION_VALUE":
      return "⚠ ignoré — Google fixe chaque enchère";
  }
}

function printPlan(plan: PlannedMutate[], bidding: BiddingStrategy, apiVersion: string): void {
  const smart = isSmartBidding(bidding);
  console.log("");
  console.log("═".repeat(78));
  console.log(`  ${APPLY ? "CRÉATION" : "DRY-RUN"} — ${CAMPAIGN_NAME}`);
  console.log("═".repeat(78));
  console.log("");
  console.log(`  Type             SHOPPING (Standard Shopping — annonces produit)`);
  console.log(`  Statut           PAUSED (tous les objets)`);
  console.log(`  Merchant Center  ${MERCHANT_CENTER_ID} (feed_label ${FEED_LABEL})`);
  console.log(`  Budget           ${cad(DAILY_BUDGET_CAD)} / jour`);
  console.log(`  Enchères         ${bidding.kind}${TARGET_ROAS ? ` (tROAS ${TARGET_ROAS})` : ""}`);
  console.log(`  Max CPC          ${cad(MAX_CPC_CAD)}  ${maxCpcNote(bidding)}`);
  console.log(`  Géo / Langues    Canada · français + anglais`);
  console.log(`  API              ${apiVersion}`);
  console.log("");

  for (const [i, step] of plan.entries()) {
    console.log(`─ ${i + 1}. ${step.step}  (${step.path}, ${step.operations.length} op)`);
    // Full pretty payload for the singleton steps; one compact line PER operation for the
    // bulk steps. Never a single "e.g." sample — the point of the dry-run is reviewing every
    // negative keyword and every schedule block, and a sample hides 16 of 17 of them.
    if (step.operations.length <= 2) {
      console.log(indent(JSON.stringify(step.operations, null, 2)));
    } else {
      for (const op of step.operations) console.log(indent(JSON.stringify(op)));
    }
    console.log("");
  }

  console.log("─ Avertissements ─────────────────────────────────────────────────────────────");
  if (smart) {
    console.log(`  ⚠ ${bidding.kind} ignore les modificateurs d'enchères : le +20% soir/weekend`);
    console.log(`    N'EST PAS appliqué (les blocs horaires sont créés sans modificateur, la`);
    console.log(`    couverture reste 24/7). Pour un vrai +20% : --bidding manual-cpc.`);
  }
  if (bidding.kind === "MAXIMIZE_CONVERSION_VALUE") {
    console.log(`  ⚠ Le max CPC de ${cad(MAX_CPC_CAD)} est ignoré — Google fixe chaque enchère.`);
    console.log(`    Le plafond n'est respecté que sous --bidding maximize-clicks ou manual-cpc.`);
  }
  if (!SAFE_FREE) {
    console.log(`  ⚠ Négatif "gratuit" (PHRASE) : bloque aussi « meubles patio livraison gratuite ».`);
    console.log(`    Pour garder ce trafic : --safe-free-negatives.`);
  }
  if (!SKIP_SITELINKS) {
    console.log(`  ⚠ Les sitelinks ne s'affichent PAS sur les annonces Shopping (Search only).`);
    console.log(`    Les promos Shopping viennent du flux Promotions Merchant Center.`);
  }
  console.log("");
  console.log("─ Non créé (impossible dans une campagne Shopping) ───────────────────────────");
  console.log("  ✗ Remarketing dynamique — exige une campagne Display / Demand Gen / PMax séparée.");
  console.log("  ✗ Audiences visiteurs / abandons de panier — Google ne peut pas lire un pixel");
  console.log("    Meta ou Pinterest. Il faut la balise Google/GA4 ou Customer Match.");
  console.log("");
}

// ─── Build ────────────────────────────────────────────────────────────────────────────

async function build(client: AdsClient, bidding: BiddingStrategy): Promise<string> {
  const budget = await client.createCampaignBudget({
    name: `${CAMPAIGN_NAME} — Budget`,
    amountMicros: toMicros(DAILY_BUDGET_CAD),
  });

  const campaign = await client.createCampaign({
    name: CAMPAIGN_NAME,
    budgetResourceName: budget,
    bidding,
    advertisingChannelType: "SHOPPING",
    status: "PAUSED",
    shoppingSetting: {
      merchantId: MERCHANT_CENTER_ID,
      feedLabel: FEED_LABEL,
      campaignPriority: 1, // MEDIUM
      enableLocal: false,
    },
    networkSettings: {
      targetGoogleSearch: true,
      targetSearchNetwork: true,
      targetContentNetwork: false,
      targetPartnerSearchNetwork: false,
    },
  });

  await client.addLocationTargets(campaign, [GEO_CANADA]);
  await client.addLanguageTargets(campaign, [LANG_FRENCH, LANG_ENGLISH]);
  await client.addAdSchedule(campaign, buildSchedule(), bidding);
  await client.addNegativeKeywords(campaign, buildNegatives());

  const adGroup = await client.createAdGroup({
    name: AD_GROUP_NAME,
    campaignResourceName: campaign,
    type: "SHOPPING_PRODUCT_ADS",
    status: "PAUSED",
    cpcBidMicros: toMicros(MAX_CPC_CAD),
  });
  await client.createShoppingAd(adGroup);

  if (!SKIP_SITELINKS) {
    await client.createSitelinks(campaign, [...SITELINKS_FR, ...SITELINKS_EN]);
  }

  return campaign;
}

/** Refuse to build a value-bidding campaign into an account that cannot measure value. */
async function preflight(client: AdsClient, bidding: BiddingStrategy): Promise<void> {
  const actions = await client.listConversionActions();
  console.log(`\n  Préflight — ${actions.length} action(s) de conversion ENABLED :`);
  for (const a of actions) {
    console.log(`    • ${a.name} — ${a.category}${a.primaryForGoal ? " (objectif principal)" : ""}`);
  }
  if (bidding.kind !== "MAXIMIZE_CONVERSION_VALUE") return;
  if (!actions.some((a) => a.category === "PURCHASE")) {
    throw new Error(
      "Aucune action de conversion PURCHASE active sur le compte.\n" +
        "  MAXIMIZE_CONVERSION_VALUE enchérirait à l'aveugle — la campagne dépenserait sans\n" +
        "  signal de valeur. Installer d'abord la balise Google + l'événement purchase\n" +
        "  (docs/GOOGLE-ADS-SETUP.md §7), ou relancer avec --bidding maximize-clicks.",
    );
  }
}

async function main(): Promise<void> {
  const bidding = resolveBidding();
  const creds = readGoogleAdsCredentials();

  if (APPLY && !creds) {
    throw new Error(
      `Credentials Google Ads absentes : ${missingGoogleAdsEnv().join(", ")}\n` +
        "  Le compte Google Ads n'est pas encore provisionné. Suivre docs/GOOGLE-ADS-SETUP.md —\n" +
        "  l'approbation du developer token prend 1 à 3 jours ouvrables et bloque tout appel.\n" +
        "  Le dry-run (sans --apply) fonctionne sans credentials.",
    );
  }

  const client = new GoogleAdsClient(creds, {
    dryRun: !APPLY,
    ...(API_VERSION ? { apiVersion: API_VERSION } : {}),
  });

  if (APPLY) await preflight(client, bidding);

  let campaign: string;
  try {
    campaign = await build(client, bidding);
  } catch (err) {
    // A mid-chain failure (e.g. the ad group POST rejects) leaves the budget and campaign
    // already created and PAUSED. Silently exiting would orphan them invisibly, so list
    // exactly what exists before rethrowing — those are the resources to delete or reuse.
    if (APPLY && client.plan.length > 0) {
      console.error("\n⚠ Objets DÉJÀ créés avant l'échec (tous PAUSED — à supprimer ou réutiliser) :");
      for (const step of client.plan) {
        for (const rn of step.resourceNames) console.error(`    ${step.step}: ${rn}`);
      }
    }
    throw err;
  }
  printPlan(client.plan, bidding, client.apiVersion);

  if (APPLY) {
    console.log(`✓ Campagne créée et PAUSED : ${campaign}`);
    console.log(`  Activer à la main dans Google Ads après revue. Rien n'a dépensé.\n`);
  } else {
    console.log("═".repeat(78));
    console.log("  Rien n'a été envoyé. Pour créer (tout restera PAUSED) :");
    console.log("    node --env-file=.env.local node_modules/tsx/dist/cli.mjs \\");
    console.log("      scripts/create-google-shopping-campaign.mts --apply");
    console.log("═".repeat(78));
    console.log("");
  }
}

main().catch((err: unknown) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
