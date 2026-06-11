// Chantier 3 — verify the nav + hero changes on the preview theme (read-only).
import { getAsset, gql } from "./_shopify-lib.mjs";
const T = "160213696617";
let ok = 0, bad = 0;
const check = (label, cond, detail = "") => { console.log(`${cond ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`); cond ? ok++ : bad++; };

// header-group.json
const hg = JSON.parse(await getAsset("sections/header-group.json", T));
const hs = hg.sections.header.settings;
check("header points at preview-main-menu", hs.menu === "preview-main-menu", `menu=${hs.menu}`);
check("desktop menu type = mega", hs.menu_type_desktop === "mega");
check("sticky header enabled", !!hs.sticky_header_type && hs.sticky_header_type !== "none", hs.sticky_header_type);

// preview-main-menu structure
const mq = await gql(`{ menus(first:50){ nodes{ handle title items{ title url items{ title url } } } } }`);
const menu = mq.data.menus.nodes.find((m) => m.handle === "preview-main-menu");
check("preview-main-menu exists", !!menu);
if (menu) {
  const titles = menu.items.map((i) => i.title);
  const expected = ["Rabais 🔥", "Mobilier extérieur", "Meubles", "Jardin", "Animaux", "Déco", "Catalogue"];
  check("7 top categories in order", JSON.stringify(titles) === JSON.stringify(expected), titles.join(" | "));
  const mob = menu.items.find((i) => i.title === "Mobilier extérieur");
  const meu = menu.items.find((i) => i.title === "Meubles");
  check("Mobilier extérieur has 4 mega children", (mob?.items?.length || 0) === 4, (mob?.items || []).map((c) => c.title).join(", "));
  check("Meubles has 4 mega children", (meu?.items?.length || 0) === 4, (meu?.items || []).map((c) => c.title).join(", "));
  check("live main-menu still exists (untouched)", !!mq.data.menus.nodes.find((m) => m.handle === "main-menu"));
}

// snippets
const mega = await getAsset("snippets/mega-menu.liquid", T);
check("mega-menu.liquid present", mega.includes("lc-mega"));
check("mega-menu has Unsplash image cases", (mega.match(/images\.unsplash\.com/g) || []).length >= 8, `${(mega.match(/images\.unsplash\.com/g) || []).length} images`);
check("mega-menu uses navy + gold", mega.includes("#1B2A4A") && mega.includes("#C17F3E"));
const hm = await getAsset("snippets/header-mega-menu.liquid", T);
check("header-mega-menu delegates to mega-menu", hm.includes("render 'mega-menu'"));

// hero
const idx = JSON.parse(await getAsset("templates/index.json", T));
const hero = idx.sections.lc_hero.settings.custom_liquid;
check("hero headline updated", hero.includes("votre image"));
check("hero subtitle updated", hero.includes("Mobilier moderne, livraison gratuite"));
check("hero has 2 CTAs (navy + gold)", hero.includes("lc-btn--navy") && hero.includes("lc-btn--gold"));
check("hero CTAs link all + rabais", hero.includes('href="/collections/all"') && hero.includes('href="/collections/rabais"'));
check("hero floating badge present", hero.includes("lc-hero-badge") && hero.includes("Retours 30 jours"));

console.log(`\n${ok} ✅  /  ${bad} ❌`);
process.exit(bad ? 1 : 0);
