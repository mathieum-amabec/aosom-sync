// Homepage redesign deploy — dry-run by default, --apply to push to LIVE theme.
//
//   node-x64 scripts/apply-homepage-redesign.mjs            # dry-run (diff only)
//   node-x64 scripts/apply-homepage-redesign.mjs --apply    # push to theme 160213696617
//
// Changes (all on templates/index.json + 2 new assets):
//   ASSET  assets/lc-home.css                 (new)
//   ASSET  assets/lc-home.js                  (new)
//   SECT   lc_hero.custom_liquid              (replace)
//   SECT   cat_tiles.custom_liquid            (replace)
//   SECT   lc_story1 / lc_story2 / why_us     (inject ' lc-reveal' class — Étape 4)
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rest, getAsset, putAsset } from "./_shopify-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const THEME_ID = "160213696617";
const APPLY = process.argv.includes("--apply");

const read = (p) => readFileSync(join(ROOT, p), "utf8");
const LC_HOME_CSS = read("shopify-theme/assets/lc-home.css");
const LC_HOME_JS = read("shopify-theme/assets/lc-home.js");
const HERO_HTML = read("shopify-theme/home/lc_hero.liquid").replace(/\r\n/g, "\n");
const CAT_HTML = read("shopify-theme/home/cat_tiles.liquid").replace(/\r\n/g, "\n");

// Inject ' lc-reveal' into a wrapper class, idempotent.
function addReveal(html, fromClass) {
  if (html.includes("lc-reveal")) return html; // already done
  return html.replace(`class="${fromClass}"`, `class="${fromClass} lc-reveal"`);
}

function gitDiff(label, oldStr, newStr) {
  const tmp = join(ROOT, ".dryrun-tmp");
  mkdirSync(tmp, { recursive: true });
  const a = join(tmp, "old.txt"), b = join(tmp, "new.txt");
  writeFileSync(a, oldStr); writeFileSync(b, newStr);
  let out = "";
  try {
    out = execFileSync("git", ["diff", "--no-index", "--no-color", "--", a, b], { encoding: "utf8" });
  } catch (e) { out = e.stdout || ""; } // git diff exits 1 when files differ
  rmSync(tmp, { recursive: true, force: true });
  const body = out.split("\n").slice(4).join("\n"); // drop the diff/index/+++/--- header noise
  console.log(`\n===== DIFF: ${label} =====`);
  console.log(body.trim() ? body : "(no change)");
}

const raw = await getAsset("templates/index.json", THEME_ID);
const tpl = JSON.parse(raw);
const S = tpl.sections;

// --- theme.liquid: homepage-scoped preload of the hero image (LCP) ---
const themeLiquid = await getAsset("layout/theme.liquid", THEME_ID);
const CANON = '<link rel="canonical" href="{{ canonical_url }}">';
const PRELOAD =
  '\n    {%- if request.page_type == \'index\' -%}\n' +
  '      <link rel="preload" as="image" href="{{ \'lc-hero.jpg\' | asset_url }}" fetchpriority="high">\n' +
  '    {%- endif -%}';
let newThemeLiquid = themeLiquid;
if (themeLiquid.includes("'lc-hero.jpg' | asset_url }}\" fetchpriority")) {
  // already injected — no-op
} else if (themeLiquid.includes(CANON)) {
  newThemeLiquid = themeLiquid.replace(CANON, CANON + PRELOAD);
} else {
  throw new Error("theme.liquid: canonical anchor not found — aborting (won't blind-inject into LIVE layout).");
}

// Build new values
const newHero = HERO_HTML;
const newCat = CAT_HTML;
const newStory1 = addReveal(S.lc_story1.settings.custom_liquid, "page-width lc-story");
const newStory2 = addReveal(S.lc_story2.settings.custom_liquid, "page-width lc-story");
const newWhy = addReveal(S.why_us.settings.custom_liquid, "lc-why-wrap");

// --- Report ---
console.log(`THEME ${THEME_ID} — mode: ${APPLY ? "APPLY (LIVE)" : "DRY-RUN"}\n`);
console.log("NEW ASSET assets/lc-home.css :", LC_HOME_CSS.split("\n").length, "lines");
console.log("NEW ASSET assets/lc-home.js  :", LC_HOME_JS.split("\n").length, "lines");

gitDiff("sections.lc_hero.custom_liquid", S.lc_hero.settings.custom_liquid, newHero);
gitDiff("sections.cat_tiles.custom_liquid", S.cat_tiles.settings.custom_liquid, newCat);
gitDiff("sections.lc_story1.custom_liquid (reveal)", S.lc_story1.settings.custom_liquid, newStory1);
gitDiff("sections.lc_story2.custom_liquid (reveal)", S.lc_story2.settings.custom_liquid, newStory2);
gitDiff("sections.why_us.custom_liquid (reveal)", S.why_us.settings.custom_liquid, newWhy);
gitDiff("layout/theme.liquid (hero preload)", themeLiquid, newThemeLiquid);

if (!APPLY) {
  console.log("\nDRY-RUN complete. Nothing was written. Re-run with --apply to deploy.");
  process.exit(0);
}

// --- Apply ---
// 1) Backup current index.json
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = join(ROOT, "shopify-theme", "backups");
mkdirSync(backupDir, { recursive: true });
writeFileSync(join(backupDir, `index.json.${stamp}.bak`), raw);
writeFileSync(join(backupDir, `theme.liquid.${stamp}.bak`), themeLiquid);
console.log(`\nBackup saved: shopify-theme/backups/index.json.${stamp}.bak`);
console.log(`Backup saved: shopify-theme/backups/theme.liquid.${stamp}.bak`);

// 2) Upload assets first (so the liquid references resolve immediately)
await putAsset("assets/lc-home.css", LC_HOME_CSS, THEME_ID);
console.log("PUT assets/lc-home.css OK");
await putAsset("assets/lc-home.js", LC_HOME_JS, THEME_ID);
console.log("PUT assets/lc-home.js OK");

// 3) Patch sections + PUT index.json
S.lc_hero.settings.custom_liquid = newHero;
S.cat_tiles.settings.custom_liquid = newCat;
S.lc_story1.settings.custom_liquid = newStory1;
S.lc_story2.settings.custom_liquid = newStory2;
S.why_us.settings.custom_liquid = newWhy;
await putAsset("templates/index.json", JSON.stringify(tpl, null, 2), THEME_ID);
console.log("PUT templates/index.json OK");

// 4) Patch theme.liquid (hero preload) if changed
if (newThemeLiquid !== themeLiquid) {
  await putAsset("layout/theme.liquid", newThemeLiquid, THEME_ID);
  console.log("PUT layout/theme.liquid OK");
} else {
  console.log("layout/theme.liquid unchanged (preload already present)");
}
console.log("\nAPPLY complete. Verify https://ameublodirect.ca/ (hard refresh).");
