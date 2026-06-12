import { rest, getAsset } from "./_shopify-lib.mjs";
const PREVIEW = "160213696617";

const themes = (await (await rest("/themes.json")).json()).themes;
console.log("=== THEMES ===");
for (const t of themes) console.log(`${t.id} "${t.name}" [${t.role}]`);

const target = themes.find((x) => String(x.id) === PREVIEW);
console.log(`\nTarget preview ${PREVIEW}: ${target ? `"${target.name}" [${target.role}]` : "NOT FOUND"}`);

const idx = JSON.parse(await getAsset("templates/index.json", PREVIEW));
console.log("\n=== index.json ORDER ===");
console.log(idx.order.join("\n"));
console.log("\n=== index.json SECTION TYPES (in order) ===");
for (const id of idx.order) {
  const s = idx.sections[id];
  console.log(`  ${id} -> ${s ? s.type : "MISSING"}`);
}
