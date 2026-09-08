// Read-only: inspect the draft header section settings (which linklist menu + desktop menu type).
import { rest, getDraftThemeId } from "./_shopify-lib.mjs";

// Theme ids are resolved from themes.json at run time — never hardcoded.
const DRAFT_THEME_ID = await getDraftThemeId();
const DRAFT = DRAFT_THEME_ID;
const res = await rest(`/themes/${DRAFT}/assets.json?asset[key]=${encodeURIComponent("sections/header-group.json")}`);
const j = JSON.parse((await res.json()).asset.value);
for (const [k, s] of Object.entries(j.sections || {})) {
  if (s.type && s.type.toLowerCase().includes("header")) {
    console.log("section:", k, "| type:", s.type);
    console.log("  menu:", s.settings?.menu);
    console.log("  menu_type_desktop:", s.settings?.menu_type_desktop);
  }
}
