// ÉTAPE 1 — read-only: list all themes with id/name/role. Does NOT publish anything.
import { rest, DRAFT_THEME_ID, LIVE_THEME_ID } from "./_shopify-lib.mjs";
const themes = (await (await rest("/themes.json")).json()).themes;
for (const t of themes) console.log(`${t.id}\t[${t.role}]\t${t.name}`);
console.log("\n--- GATE CHECK ---");
const preview = themes.find((t) => String(t.id) === DRAFT_THEME_ID);
const live = themes.find((t) => String(t.id) === LIVE_THEME_ID);
console.log(`draft   ${DRAFT_THEME_ID}: ${preview ? `"${preview.name}" role=${preview.role}` : "NOT FOUND"}`);
console.log(`live    ${LIVE_THEME_ID}: ${live ? `"${live.name}" role=${live.role}` : "NOT FOUND"}`);
// Gate on ROLES, never on names. Theme names here are historical labels that survive a
// publish — the live theme is currently called "DRAFT GOOGLE SHOPPING 2026-08-07" — so a
// name check either fails on a correct setup or passes on a wrong one.
const ok =
  preview && preview.role === "unpublished" &&
  live && live.role === "main";
console.log(`\nGATE: ${ok ? "PASS — matches stated expectation, safe to publish" : "FAIL — does NOT match, DO NOT publish"}`);
