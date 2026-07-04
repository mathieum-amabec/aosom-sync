// Clean the "Voyez-le chez vous" carousel on the DRAFT theme 160656818281 ONLY (role-gated).
// Vetting found 9/10 videos carry burned-in English text / supplier logos. Clean no-text (-WEB-NT)
// cuts verified for 4; socle already clean. The other 5 have NO verified-clean version -> removed.
// Result: a clean 5-card carousel (parasol, tente, socle, chaise, cage-bois — all no-text).
// Dry-run writes /tmp orig+new for diff; --apply PUTs + verifies.
//   node scripts/homepage-video-carousel-clean.mjs [--apply]
import { readFileSync, writeFileSync } from "node:fs";
const env = (() => { const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8"); const e = {}; for (const l of raw.split(/\r?\n/)) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (!m) continue; let v = m[2].trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); e[m[1]] = v; } return e; })();
const STORE = "27u5y2-kp.myshopify.com", API = "2024-01", TOKEN = env.SHOPIFY_ACCESS_TOKEN;
if (!TOKEN) { console.error("FATAL no token"); process.exit(2); }
const DRAFT = "160656818281", LIVE = "160606093417", KEY = "sections/home-video-showcase.liquid";
const APPLY = process.argv.includes("--apply");
const H = { "X-Shopify-Access-Token": TOKEN, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (m, p, b) => fetch(`https://${STORE}/admin/api/${API}${p}`, { method: m, headers: H, body: b ? JSON.stringify(b) : undefined });
function must(c, m) { if (!c) { console.error("ASSERT FAIL: " + m); process.exit(1); } }
function repl(src, find, rep, label) { must(src.includes(find), `not found: ${label}`); return src.split(find).join(rep); }

const themes = (await (await api("GET", "/themes.json")).json()).themes;
const d = themes.find((t) => String(t.id) === DRAFT), l = themes.find((t) => String(t.id) === LIVE);
must(d && d.role !== "main", "draft must be non-main"); must(l && l.role === "main", "live must be main");
console.log(`Gate OK — draft "${d.name}". ${APPLY ? "*** APPLY ***" : "--- DRY RUN ---"}`);

const orig = (await (await api("GET", `/themes/${DRAFT}/assets.json?asset[key]=${encodeURIComponent(KEY)}`)).json()).asset.value;
let src = orig;

// 1) swap 4 dirty videos -> verified-clean -WEB-NT
src = repl(src, "84D-031V03SD-Outsunny-WEB.mp4", "84D-031V03SD-WEB-NT.mp4", "swap parasol");
src = repl(src, "840-158WT-Outsunny-WEB.mp4", "840-158WT-WEB-NT.mp4", "swap tente");
src = repl(src, "01-0368-Outsunny-WEB.mp4", "01-0368-WEB-NT.mp4", "swap chaise");
src = repl(src, "D02-040WT-PawHut-WEB.mp4", "D02-040WT-WEB-NT.mp4", "swap cage-bois");

// 2) remove the 5 unfixable cards (no clean video)
const endMarker = "{%- endif -%}";
function removeCard(s, handle) {
  const start = `{%- assign p = all_products['${handle}'] -%}`;
  const si = s.indexOf(start);
  must(si !== -1, `card not found: ${handle}`);
  const lineStart = s.lastIndexOf("\n", si) + 1;
  const ei = s.indexOf(endMarker, si);
  must(ei !== -1, `endif not found for ${handle}`);
  let blockEnd = ei + endMarker.length;
  if (s[blockEnd] === "\n") blockEnd++;
  return s.slice(0, lineStart) + s.slice(blockEnd);
}
for (const h of [
  "ensemble-patio-7-pieces-salon-rotin-sectionnel-gris",
  "cage-pour-chien-104cm-acier-robuste-avec-roues",
  "tour-a-chat-multi-niveaux-ajustable-240-260cm-avec-condos",
  "voiture-electrique-police-12v-pour-2-enfants-avec-telecommande",
  "lit-sureleve-en-rotin-avec-toit-pour-chien-interieur-exterieur",
]) src = removeCard(src, h);

// validate result: exactly 5 cards remain, 0 branded/dirty URLs
const cardsLeft = (src.match(/all_products\[/g) || []).length;
must(cardsLeft === 5, `expected 5 cards left, got ${cardsLeft}`);
const dirty = (src.match(/(Outsunny|HOMCOM|PawHut)-WEB\.mp4|D02-051\.mp4|D30-093CW-WEB\.mp4|370-082WT-WEB\.mp4|D02-029GY-WEB\.mp4|860-020V03/g) || []);
must(dirty.length === 0, `dirty URLs still present: ${dirty.join(",")}`);
console.log(`Result: ${cardsLeft} clean cards (parasol/tente/socle/chaise/cage-bois, all no-text). 0 dirty URLs.`);

writeFileSync("C:/Users/vente/AppData/Local/Temp/hvs.liquid.orig", orig);
writeFileSync("C:/Users/vente/AppData/Local/Temp/hvs.liquid.new", src);
console.log("wrote /tmp hvs.liquid.{orig,new} for diff");

if (!APPLY) { console.log("\nDRY-RUN — no upload."); process.exit(0); }
const put = await api("PUT", `/themes/${DRAFT}/assets.json`, { asset: { key: KEY, value: src } });
must(put.status === 200, `PUT ${KEY} -> ${put.status} ${await put.text()}`);
console.log(`  PUT ${KEY} -> HTTP ${put.status}`);
let ok = false;
for (let a = 0; a < 5 && !ok; a++) { const v = (await (await api("GET", `/themes/${DRAFT}/assets.json?asset[key]=${encodeURIComponent(KEY)}`)).json()).asset.value; ok = (v.match(/all_products\[/g) || []).length === 5 && !/(Outsunny|HOMCOM|PawHut)-WEB\.mp4/.test(v); if (!ok) await sleep(2000); }
console.log(ok ? "  verified: 5 clean cards live on draft" : "  WARNING: not verified");
process.exit(ok ? 0 : 1);
