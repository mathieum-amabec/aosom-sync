// Read-only: current Shopify Markets, shop locales, and connected domains.
// Used to decide whether a second (EN) market for furnishdirect.ca can be created.
import { gql, rest } from "./_shopify-lib.mjs";

const q = `
  query {
    markets(first: 50) {
      nodes {
        id name handle primary enabled
        webPresence { id rootUrls { url locale } subfolderSuffix }
        regions(first: 100) { nodes { __typename ... on MarketRegionCountry { code name } } }
      }
    }
    shopLocales { locale name primary published }
    shop { name primaryDomain { host url } }
  }
`;

const { data } = await gql(q);

console.log("=== SHOP ===");
console.log(data.shop.name, "|", data.shop.primaryDomain.url);

console.log("\n=== LOCALES ===");
for (const l of data.shopLocales) {
  console.log(`  ${l.locale}${l.primary ? " (primary)" : ""}  published=${l.published}  ${l.name}`);
}

console.log("\n=== MARKETS ===");
for (const m of data.markets.nodes) {
  const regions = (m.regions?.nodes ?? []).map((r) => r.code).join(",");
  const urls = (m.webPresence?.rootUrls ?? []).map((u) => `${u.locale}:${u.url}`).join(" ");
  console.log(`  "${m.name}" handle=${m.handle} primary=${m.primary} enabled=${m.enabled}`);
  console.log(`    id=${m.id}`);
  console.log(`    regions=[${regions}]`);
  console.log(`    webPresence: ${urls || "(none)"}  subfolderSuffix=${m.webPresence?.subfolderSuffix ?? "-"}`);
}

console.log("\n=== CONNECTED DOMAINS (REST /domains.json) ===");
const res = await rest("/domains.json");
if (res.ok) {
  const { domains } = await res.json();
  for (const d of domains) {
    console.log(`  ${d.host}  primary=${d.primary}  ssl=${d.ssl_enabled}  locales=${JSON.stringify(d.localization || {})}`);
  }
  const fd = domains.find((d) => /furnishdirect\.ca/i.test(d.host));
  console.log("\n  furnishdirect.ca connected? ->", fd ? "YES" : "NO");
} else {
  console.log("  /domains.json ->", res.status, await res.text());
}
