// Check the home renders for any liquid error (public = published theme; preview
// param falls back to published without a staff session — both should be clean).
import { getDraftThemeId } from "./_shopify-lib.mjs";

// Theme ids are resolved from themes.json at run time — never hardcoded.
const DRAFT_THEME_ID = await getDraftThemeId();
for (const path of ["/", `/?preview_theme_id=${DRAFT_THEME_ID}`]) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`https://ameublodirect.ca${path}${sep}cb=${Date.now()}`, { cache: "no-store" });
  const h = await r.text();
  const hasErr = /liquid error/i.test(h);
  const hasNotPag = /not paginateable/i.test(h);
  console.log(`${path} -> status ${r.status} | "liquid error": ${hasErr} | "not paginateable": ${hasNotPag}`);
}
