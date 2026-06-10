import { getAsset } from "./_shopify-lib.mjs";
const PREVIEW = "160213696617";

// Try to find the Judge.me public token + review totals from the live storefront.
const html = await (await fetch(`https://ameublodirect.ca/?cb=${Date.now()}`)).text();
const tokenMatches = [...html.matchAll(/(public_token|shop_token|api[_-]?token|jdgm[_-]?\w*token)["'\s:=]+([A-Za-z0-9_\-]{6,})/gi)].map((m) => `${m[1]}=${m[2]}`);
console.log("token-ish matches:", [...new Set(tokenMatches)].slice(0, 8).join(" | ") || "(none in static HTML)");
const jdgmVars = [...html.matchAll(/jdgm[A-Za-z_]*\s*[:=]\s*["']?([^"',;}\s]{1,40})/g)].map((m) => m[0]).slice(0, 8);
console.log("jdgm vars:", jdgmVars.join(" | ") || "(none)");
const countMatch = html.match(/data-number-of-reviews=["'](\d+)["']/i) || html.match(/"reviews_count"\s*:\s*(\d+)/i);
console.log("reviews count in HTML:", countMatch ? countMatch[1] : "(none — rendered client-side)");

// Dump the testimonials multicolumn section fully.
const idx = JSON.parse(await getAsset("templates/index.json", PREVIEW));
for (const [id, sec] of Object.entries(idx.sections)) {
  const blob = JSON.stringify(sec);
  if (/anonyme/i.test(blob)) {
    console.log(`\n=== section ${id} [${sec.type}] heading="${sec.settings?.heading || ""}" ===`);
    const order = sec.block_order || Object.keys(sec.blocks || {});
    for (const bid of order) {
      const b = sec.blocks[bid];
      console.log(`  [${b.type}] ${JSON.stringify(b.settings).slice(0, 220)}`);
    }
  }
}
