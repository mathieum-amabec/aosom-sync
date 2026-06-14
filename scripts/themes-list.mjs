// ÉTAPE 1 — read-only: list all themes with id/name/role. Does NOT publish anything.
import { rest } from "./_shopify-lib.mjs";
const themes = (await (await rest("/themes.json")).json()).themes;
for (const t of themes) console.log(`${t.id}\t[${t.role}]\t${t.name}`);
console.log("\n--- GATE CHECK ---");
const preview = themes.find((t) => String(t.id) === "160213696617");
const live = themes.find((t) => String(t.id) === "160059195497");
console.log(`preview 160213696617: ${preview ? `"${preview.name}" role=${preview.role}` : "NOT FOUND"}`);
console.log(`live    160059195497: ${live ? `"${live.name}" role=${live.role}` : "NOT FOUND"}`);
const ok =
  preview && preview.name === "Copie de Copie de Trade v2" && preview.role === "unpublished" &&
  live && live.name === "Copie de Trade v2" && live.role === "main";
console.log(`\nGATE: ${ok ? "PASS — matches stated expectation, safe to publish" : "FAIL — does NOT match, DO NOT publish"}`);
