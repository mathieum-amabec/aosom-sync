// Apply the gold "-X%" discount badge to snippets/card-product.liquid on the DRAFT.
// Guards against writing to the live theme; backs up; asserts exact replacement
// counts; verifies after write. Run under node-x64.
import { rest } from "./_shopify-lib.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

const DRAFT = "160749813865";
const LIVE = "160656818281"; // current main / published — NEVER write here
const KEY = "snippets/card-product.liquid";
const APPLY = process.argv.includes("--apply");
const OUT = "./.draft-scratch-cards";
mkdirSync(OUT, { recursive: true });

// Safety: verify the target is NOT the live theme (roles move on each publish).
const themes = (await (await rest(`/themes.json`)).json()).themes;
const target = themes.find((t) => String(t.id) === DRAFT);
if (!target) throw new Error(`Draft ${DRAFT} not found in themes.json`);
if (target.role === "main" || String(DRAFT) === String(LIVE)) {
  throw new Error(`ABORT: ${DRAFT} is the LIVE theme (role=${target.role}). Refusing to write.`);
}
console.log(`Target: ${DRAFT} role=${target.role} name="${target.name}"`);

// Fetch current asset.
const getRes = await rest(`/themes/${DRAFT}/assets.json?asset[key]=${encodeURIComponent(KEY)}`);
if (!getRes.ok) throw new Error(`GET ${KEY} failed: ${getRes.status}`);
let src = (await getRes.json()).asset.value;
const stamp = "2026-07-07";
writeFileSync(`${OUT}/card-product.BEFORE.${stamp}.liquid`, src);
console.log(`Backed up current (${src.length} bytes) -> card-product.BEFORE.${stamp}.liquid`);

if (src.includes("lc-discount-badge")) {
  console.log("Already applied (lc-discount-badge present). Nothing to do.");
  process.exit(0);
}

// --- Replacement 1: add the gold badge CSS rule to the {% style %} block ---
const styleAnchor = "  .popular-badge-card { background: #FEF3C7; color: #92400E; }";
const styleCount = src.split(styleAnchor).length - 1;
if (styleCount !== 1) throw new Error(`Expected 1 style anchor, found ${styleCount}`);
src = src.replace(
  styleAnchor,
  styleAnchor +
    "\n  .card__badge .lc-discount-badge { background: #D4A853; color: #1A2340; font-weight: 700; letter-spacing: .02em; }",
);

// --- Replacement 2: swap the generic "En solde" sale badge for the "-X%" gold badge ---
// Matches BOTH badge blocks (standard + card layout); preserves each block's
// whitespace via the (\s*>\s*) capture. Only the sale badge uses this scheme +
// on_sale text, so sold-out / populaire badges are untouched.
const badgeRe =
  /class="badge badge--bottom-left color-\{\{ settings\.sale_badge_color_scheme \}\}"(\s*>\s*)\{\{- 'products\.product\.on_sale' \| t -\}\}/g;
const badgeCount = (src.match(badgeRe) || []).length;
if (badgeCount !== 2) throw new Error(`Expected 2 sale-badge blocks, found ${badgeCount}`);
src = src.replace(badgeRe, 'class="badge badge--bottom-left lc-discount-badge"$1-{{ lc_card_disc_pct }}%');

writeFileSync(`${OUT}/card-product.AFTER.${stamp}.liquid`, src);
console.log(`Wrote preview -> card-product.AFTER.${stamp}.liquid (${src.length} bytes)`);

if (!APPLY) {
  console.log("\nDRY RUN (no --apply). Replacements validated: 1 style + 2 badge blocks.");
  process.exit(0);
}

// --- Write to the draft ---
const putRes = await rest(`/themes/${DRAFT}/assets.json`, {
  method: "PUT",
  body: JSON.stringify({ asset: { key: KEY, value: src } }),
});
if (!putRes.ok) throw new Error(`PUT ${KEY} failed: ${putRes.status} ${await putRes.text()}`);
console.log("PUT ok. Verifying...");

const verify = (await (await rest(`/themes/${DRAFT}/assets.json?asset[key]=${encodeURIComponent(KEY)}`)).json()).asset.value;
const okBadge = (verify.match(/-\{\{ lc_card_disc_pct \}\}%/g) || []).length === 2;
const okCss = verify.includes(".card__badge .lc-discount-badge");
const noOldSale = !verify.includes("color-{{ settings.sale_badge_color_scheme }}\"\n") || true; // informational
console.log(`Verify: css=${okCss} badges=${okBadge}`);
if (!okBadge || !okCss) throw new Error("Verification FAILED — badge markup not present after write.");
console.log("✅ Applied + verified on draft " + DRAFT);
