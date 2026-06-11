// Chantier 4 — verify the catalog-fit uniform menu + hero buttons (read-only).
import { getAsset, gql } from "./_shopify-lib.mjs";
const T = "160213696617";
let ok = 0, bad = 0;
const check = (l, c, d = "") => { console.log(`${c ? "✅" : "❌"} ${l}${d ? " — " + d : ""}`); c ? ok++ : bad++; };

// menu structure
const mq = await gql(`{ menus(first:50){ nodes{ handle items{ title items{ title } } } } }`);
const menu = mq.data.menus.nodes.find((m) => m.handle === "preview-main-menu");
check("preview-main-menu exists", !!menu);
check("live main-menu untouched (still exists)", !!mq.data.menus.nodes.find((m) => m.handle === "main-menu"));
if (menu) {
  const titles = menu.items.map((i) => i.title);
  check("8 top items in order", JSON.stringify(titles) === JSON.stringify(
    ["Rabais 🔥", "Mobilier extérieur", "Meubles", "Animaux", "Enfants", "Jardin", "Coups de cœur", "Catalogue"]), titles.join(" | "));
  const kids = (t) => (menu.items.find((i) => i.title === t)?.items || []).length;
  check("Mobilier extérieur mega = 4", kids("Mobilier extérieur") === 4);
  check("Meubles mega = 4", kids("Meubles") === 4);
  check("Animaux mega = 3", kids("Animaux") === 3);
  check("Enfants mega = 2", kids("Enfants") === 2);
  check("Rabais/Jardin/Coups de cœur/Catalogue are direct (no children)",
    [kids("Rabais 🔥"), kids("Jardin"), kids("Coups de cœur"), kids("Catalogue")].every((n) => n === 0));
  check("Électronique + Déco dropped", !titles.includes("Électronique") && !titles.includes("Déco"));
}

// snippet
const mega = await getAsset("snippets/mega-menu.liquid", T);
check("mega-menu.liquid has 13 image cases", (mega.match(/images\.unsplash\.com/g) || []).length >= 13, `${(mega.match(/images\.unsplash\.com/g) || []).length}`);
check("mega uses navy overlay + hover scale + DM Sans Bold", mega.includes("rgba(27,42,74,.34)") && mega.includes("scale(1.02)") && mega.includes("font-weight:700"));
const hm = await getAsset("snippets/header-mega-menu.liquid", T);
check("header delegates to mega-menu", hm.includes("render 'mega-menu'"));

// liquid tag balance (gross-syntax sanity for the two edited snippets)
for (const [name, src] of [["mega-menu", mega], ["header-mega-menu", hm]]) {
  const bal = (o, c) => (src.match(new RegExp(`{%-?\\s*${o}\\b`, "g")) || []).length === (src.match(new RegExp(`{%-?\\s*${c}\\b`, "g")) || []).length;
  check(`${name}: for/endfor balanced`, bal("for", "endfor"));
  check(`${name}: if/endif balanced`, bal("if", "endif"));
  check(`${name}: case/endcase balanced`, bal("case", "endcase"));
}

// header-group
const hg = JSON.parse(await getAsset("sections/header-group.json", T));
check("header → preview-main-menu, mega", hg.sections.header.settings.menu === "preview-main-menu" && hg.sections.header.settings.menu_type_desktop === "mega");

// hero buttons
const hero = JSON.parse(await getAsset("templates/index.json", T)).sections.lc_hero.settings.custom_liquid;
check("hero primary navy + gold border", hero.includes(".lc-btn--navy{background:#1B2A4A") && hero.includes("border:2px solid #C17F3E"));
check("hero secondary white semi-transparent + navy text", hero.includes("lc-btn--ghost{background:rgba(255,255,255,.85);color:#1B2A4A"));
check("hero title + subtitle text-shadow", /\.lc-hero h1\{[^}]*text-shadow/.test(hero) && /\.lc-hero p\{[^}]*text-shadow/.test(hero));
check("hero bottom gradient overlay", hero.includes("linear-gradient(to top,rgba(0,0,0,.45)"));

console.log(`\n${ok} ✅  /  ${bad} ❌`);
process.exit(bad ? 1 : 0);
