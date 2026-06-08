// Bind furnishdirect.ca → English on the Canada market.
//
// Prereq (manual, once): connect furnishdirect.ca as a domain in Shopify Admin
// (Settings → Domains → Connect existing domain) and wait for SSL. See
// docs/FURNISHDIRECT-DOMAIN-SETUP.md for the DNS records.
//
// What this does: a Shopify market can hold MORE THAN ONE web presence, one per
// domain. The Canada market already has ameublodirect.ca → FR. This adds a SECOND
// web presence on the same Canada market bound to furnishdirect.ca with
// defaultLocale = en, so EN visitors land on furnishdirect.ca and FR stays on
// ameublodirect.ca. No second market is created (CA can only belong to one market).
//
// Usage (run under x64 node — see CLAUDE.md / [[aosom-sync-arm64-dev]]):
//   node scripts/bind-furnishdirect-domain.mjs                 # dry-run (default): prints the mutation it would send
//   node scripts/bind-furnishdirect-domain.mjs --apply         # actually create the web presence
//   node scripts/bind-furnishdirect-domain.mjs --domain-id gid://shopify/Domain/123 [--apply]
//
// Safe to run before the domain is connected: it preflights and exits with
// instructions instead of mutating anything.
import { gql, rest } from "./_shopify-lib.mjs";

const APPLY = process.argv.includes("--apply");
const domainIdArg = (() => {
  const i = process.argv.indexOf("--domain-id");
  return i !== -1 ? process.argv[i + 1] : process.env.FURNISHDIRECT_DOMAIN_ID || null;
})();

const EN_LOCALE = "en";
const TARGET_HOST = "furnishdirect.ca";

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

// ── 1. Preflight: scopes ────────────────────────────────────────────────
const scopeQ = `query { currentAppInstallation { accessScopes { handle } } }`;
const scopeRes = await gql(scopeQ);
const scopes = new Set((scopeRes.data?.currentAppInstallation?.accessScopes ?? []).map((s) => s.handle));
console.log("Scopes:", [...scopes].filter((s) => s.includes("market")).join(", ") || "(no market scopes)");
if (!scopes.has("read_markets") || !scopes.has("write_markets")) {
  fail("Token is missing read_markets/write_markets. Re-grant the app scopes, then retry.");
}

// ── 2. Find the Canada (primary) market + its existing web presences ────
const marketsQ = `
  query {
    markets(first: 50) {
      nodes {
        id name handle primary enabled
        webPresences(first: 10) { nodes { id defaultLocale { locale } domain { id host } rootUrls { url locale } } }
        regions(first: 50) { nodes { __typename ... on MarketRegionCountry { code } } }
      }
    }
    shopLocales { locale published }
  }`;
const m = await gql(marketsQ);
const markets = m.data?.markets?.nodes ?? [];
const canada =
  markets.find((mk) => mk.primary && (mk.regions?.nodes ?? []).some((r) => r.code === "CA")) ||
  markets.find((mk) => (mk.regions?.nodes ?? []).some((r) => r.code === "CA"));
if (!canada) fail("Could not find the Canada market. Run scripts/markets-status.mjs to inspect.");

console.log(`\nCanada market: "${canada.name}" (${canada.id})`);
const existing = canada.webPresences?.nodes ?? [];
for (const wp of existing) {
  const urls = (wp.rootUrls ?? []).map((u) => `${u.locale}:${u.url}`).join(" ");
  console.log(`  web presence ${wp.id} domain=${wp.domain?.host ?? "(subfolder)"} default=${wp.defaultLocale?.locale} ${urls}`);
}
if (existing.some((wp) => wp.domain?.host?.toLowerCase() === TARGET_HOST)) {
  console.log(`\n✓ ${TARGET_HOST} is already bound to the Canada market. Nothing to do.`);
  process.exit(0);
}

// ── 3. Verify EN locale is published ────────────────────────────────────
const enPublished = (m.data?.shopLocales ?? []).some((l) => l.locale === EN_LOCALE && l.published);
if (!enPublished) fail(`Locale "${EN_LOCALE}" is not published on the shop — publish it before binding a domain to it.`);

// ── 4. Resolve the furnishdirect.ca domain id ───────────────────────────
let domainId = domainIdArg;
if (!domainId) {
  // REST /domains.json is gone on some API versions (returns 404) — tolerate that.
  const res = await rest("/domains.json");
  if (res.ok) {
    const { domains } = await res.json();
    const fd = (domains ?? []).find((d) => new RegExp(`(^|\\.)${TARGET_HOST.replace(".", "\\.")}$`, "i").test(d.host));
    if (fd) domainId = `gid://shopify/Domain/${fd.id}`;
  }
}
if (!domainId) {
  console.log(
    `\n⏸  ${TARGET_HOST} is not connected yet (or its domain id could not be auto-discovered).\n` +
      `   1) Point DNS at Shopify (A @ → 23.227.38.65, CNAME www → shops.myshopify.com).\n` +
      `   2) Shopify Admin → Settings → Domains → Connect existing domain → ${TARGET_HOST}; wait for SSL.\n` +
      `   3) Re-run this script (optionally pass --domain-id gid://shopify/Domain/XXX).`,
  );
  process.exit(0);
}
console.log(`\nDomain to bind: ${domainId}`);

// ── 5. Create the EN web presence on the Canada market ──────────────────
const mutation = `
  mutation marketWebPresenceCreate($marketId: ID!, $webPresence: MarketWebPresenceCreateInput!) {
    marketWebPresenceCreate(marketId: $marketId, webPresence: $webPresence) {
      market { id name webPresences(first: 10) { nodes { id domain { host } defaultLocale { locale } } } }
      userErrors { field message }
    }
  }`;
const variables = {
  marketId: canada.id,
  webPresence: { domainId, defaultLocale: EN_LOCALE },
};

if (!APPLY) {
  console.log("\n── DRY RUN (pass --apply to execute) ──");
  console.log("mutation:", mutation.trim());
  console.log("variables:", JSON.stringify(variables, null, 2));
  process.exit(0);
}

console.log("\nApplying marketWebPresenceCreate …");
const out = await gql(mutation, variables);
const result = out.data?.marketWebPresenceCreate;
if (result?.userErrors?.length) {
  fail("Shopify returned userErrors: " + JSON.stringify(result.userErrors, null, 2));
}
console.log("✓ Created. Canada market web presences now:");
for (const wp of result?.market?.webPresences?.nodes ?? []) {
  console.log(`  ${wp.id} domain=${wp.domain?.host} default=${wp.defaultLocale?.locale}`);
}
