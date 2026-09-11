/**
 * POC — text carousels: Claude writes the slides, Satori renders them to 1080x1350 PNG.
 *
 * Isolated on purpose: its own package.json, its own node_modules. Nothing is added to the
 * main project's dependency tree, nothing is uploaded, nothing is published.
 *
 * ── WHY SATORI AND NOT PUPPETEER ──────────────────────────────────────────
 * The two reference repos take opposite routes: content-management-dashboard uses
 * Satori -> resvg -> sharp, open-carrusel uses Puppeteer. Both work. For this stack Satori
 * wins on the point that actually bit us: it lays text out with real flexbox, so line breaks
 * and wrapping are computed by a layout engine rather than by me. The last time this codebase
 * estimated text width by hand (`layoutWords`, 0.6 em per character) it shipped a bug that
 * stacked a whole headline on one spot. A carousel is nothing BUT text in boxes.
 *
 * The size difference is the second argument: satori + @resvg/resvg-js is 25 packages and
 * 19 MB. The Remotion spike measured Chromium at a 113 MB download on top of 660 MB of
 * node_modules, and Puppeteer pulls the same class of payload.
 *
 * ── WHAT IS BORROWED FROM THE REFERENCES ──────────────────────────────────
 * The hook/body/cta slide roles and "count integrity" from content-management-dashboard:
 * if the hook promises "3 erreurs", the deck must contain exactly 3 body slides. Their
 * comment on this is right — a viewer promised 5 who gets 3 feels cheated. Everything else
 * (brand, French, supplier-name rule, layout) is ours.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import satori from "satori";
import { Resvg } from "@resvg/resvg-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..");
const OUT = path.join(here, "output");
const W = 1080, H = 1350; // Instagram carousel portrait

const NAVY = "#1A2340", GOLD = "#D4A853", CREAM = "#F7F5F1";

// The rule is already in force across the project: never name the supplier in anything a
// customer sees.
const FORBIDDEN = ["aosom", "outsunny", "homcom", "pawhut", "vinsetto", "qaba"];

function env(key) {
  const raw = fs.readFileSync(path.join(REPO, ".env.local"), "utf8").split(/\r?\n/);
  const line = raw.find((l) => l.startsWith(`${key}=`));
  if (!line) return "";
  let v = line.slice(key.length + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

const SYSTEM = [
  "Tu écris des carrousels Instagram en français québécois pour une boutique de meubles en ligne.",
  "",
  "STRUCTURE — un tableau de slides :",
  '  slide 1  role "hook" : le titre. Il annonce un NOMBRE ("3 erreurs", "5 façons").',
  '  slides du milieu  role "body" : UNE idée concrète chacune.',
  '  dernière slide  role "cta" : invitation douce, sans prix ni promo.',
  "",
  "INTÉGRITÉ DU COMPTE (critique) : si le titre promet 3 erreurs, il faut EXACTEMENT 3 slides",
  "body. Promettre 5 et en montrer 3 fait décrocher le lecteur. Total = 1 hook + N body + 1 cta.",
  "",
  "RÈGLES :",
  "- Conseils concrets et vérifiables. Pas de généralités creuses.",
  "- Jamais de nom de fournisseur (Aosom, Outsunny, HOMCOM, PawHut, Vinsetto, Qaba).",
  "- Pas de prix, pas de nom de produit précis, pas de promesse invérifiable.",
  "- `headline` : 6 mots max. `body` : 18 mots max, une phrase.",
  "- Pas d'emoji, pas de hashtag dans les slides.",
  "",
  'Réponds UNIQUEMENT en JSON : {"topic":"...","slides":[{"role":"hook|body|cta","kicker":"...","headline":"...","body":"..."}],"caption":"..."}',
].join("\n");

async function writeSlides(category, apiKey, model = "claude-sonnet-4-6") {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: 1600,
      system: SYSTEM,
      messages: [{ role: "user", content: `Catégorie : ${category}\n\nÉcris un carrousel de type astuce/liste pour cette catégorie.` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const text = (await res.json()).content.map((c) => (c.type === "text" ? c.text : "")).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("pas de JSON dans la réponse");
  return JSON.parse(m[0]);
}

/** Reject a deck that names a supplier, rather than rendering it and hoping nobody looks. */
export function checkForbidden(spec) {
  const hay = JSON.stringify(spec).toLowerCase();
  return FORBIDDEN.filter((w) => hay.includes(w));
}

/** Hook promises N; body slides must be N. Borrowed from the reference repo, worth keeping. */
export function countIntegrity(spec) {
  const hook = spec.slides.find((s) => s.role === "hook");
  const promised = Number((`${hook?.headline ?? ""} ${hook?.kicker ?? ""}`.match(/\b(\d{1,2})\b/) ?? [])[1]);
  const body = spec.slides.filter((s) => s.role === "body").length;
  if (!Number.isFinite(promised)) return { ok: true, promised: null, body };
  return { ok: promised === body, promised, body };
}

// ── layout ────────────────────────────────────────────────────────────────
// Plain element objects rather than JSX: Satori accepts {type, props} directly, so the POC
// needs neither React nor a build step.
//
//  is injected by default because Satori REQUIRES an explicit display on any
// div that has children — including a div wrapping a single string. Leaving it off throws
// "Expected <div> to have explicit display: flex", which reads like a layout complaint but is
// really a parser rule. Setting it once here is safer than remembering it at 8 call sites.
const el = (type, props, ...children) => ({
  type,
  props: { ...props, style: { display: "flex", ...(props?.style ?? {}) }, children: children.flat() },
});

function slideTree(slide, index, total) {
  const isHook = slide.role === "hook";
  const isCta = slide.role === "cta";
  const bg = isHook ? NAVY : CREAM;
  const fg = isHook ? "#FFFFFF" : NAVY;

  return el(
    "div",
    {
      style: {
        width: W, height: H, display: "flex", flexDirection: "column",
        justifyContent: "space-between", backgroundColor: bg,
        padding: "88px 84px", fontFamily: "DMSans",
      },
    },
    // kicker + step counter
    el(
      "div",
      { style: { display: "flex", justifyContent: "space-between", alignItems: "center" } },
      el("div", { style: { fontSize: 30, letterSpacing: 3, color: GOLD, fontWeight: 700, textTransform: "uppercase" } },
        slide.kicker ?? (isCta ? "Ameublo Direct" : "Astuce")),
      el("div", { style: { fontSize: 28, color: isHook ? "#FFFFFFAA" : "#1A234099", fontWeight: 700 } },
        isHook ? "" : `${index}/${total - 1}`),
    ),
    // headline + body
    el(
      "div",
      { style: { display: "flex", flexDirection: "column" } },
      el("div", {
        style: {
          fontSize: isHook ? 104 : 74, lineHeight: 1.08, color: fg, fontWeight: 700,
          // Satori wraps this with real flexbox; no character-width estimate anywhere.
          marginBottom: 28,
        },
      }, slide.headline ?? ""),
      slide.body
        ? el("div", { style: { fontSize: 40, lineHeight: 1.35, color: isHook ? "#FFFFFFCC" : "#1A2340CC" } }, slide.body)
        : el("div", { style: { display: "flex" } }),
    ),
    // gold rule + wordmark
    el(
      "div",
      { style: { display: "flex", flexDirection: "column" } },
      el("div", { style: { width: 220, height: 8, backgroundColor: GOLD, marginBottom: 26, display: "flex" } }),
      el("div", { style: { fontSize: 30, color: isHook ? "#FFFFFFAA" : "#1A234099", fontWeight: 700 } }, "ameublodirect.ca"),
    ),
  );
}

async function render(spec, slug) {
  // NOT the repo's fonts/DMSans.ttf: that file is a VARIABLE font (it carries an fvar table)
  // and Satori's parser throws on it ("Cannot read properties of undefined"). sharp/librsvg
  // renders it fine through fontconfig, which is why nothing else in this repo hit it. Satori
  // needs a static instance, so the POC ships one via @fontsource.
  const fdir = path.join(here, 'node_modules', '@fontsource', 'dm-sans', 'files');
  const regular = fs.readFileSync(path.join(fdir, 'dm-sans-latin-400-normal.woff'));
  const bold = fs.readFileSync(path.join(fdir, 'dm-sans-latin-700-normal.woff'));
  const dir = path.join(OUT, slug);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < spec.slides.length; i++) {
    const svg = await satori(slideTree(spec.slides[i], i, spec.slides.length), {
      width: W, height: H,
      fonts: [
        { name: "DMSans", data: regular, weight: 400, style: "normal" },
        { name: "DMSans", data: bold, weight: 700, style: "normal" },
      ],
    });
    const png = new Resvg(svg, { fitTo: { mode: "width", value: W } }).render().asPng();
    const file = path.join(dir, `${String(i + 1).padStart(2, "0")}-${spec.slides[i].role}.png`);
    fs.writeFileSync(file, png);
    files.push(file);
  }
  fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec, null, 1));
  return files;
}

async function main() {
  const apiKey = env("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY introuvable dans .env.local");
  const topics = [
    { slug: "petit-salon", category: "Home Furnishings > Living Room Furniture (petits salons, condos)" },
    { slug: "bureau-maison", category: "Office Products > Office Furniture (bureau à la maison, télétravail)" },
  ];
  for (const t of topics) {
    const t0 = Date.now();
    const spec = await writeSlides(t.category, apiKey);
    const wrote = Date.now() - t0;

    const bad = checkForbidden(spec);
    if (bad.length) throw new Error(`nom de fournisseur dans le texte : ${bad.join(", ")}`);
    const ci = countIntegrity(spec);

    const t1 = Date.now();
    const files = await render(spec, t.slug);
    const rendered = Date.now() - t1;

    console.log(`\n=== ${t.slug} — « ${spec.topic ?? ""} » ===`);
    console.log(`  slides   : ${spec.slides.length} (hook + ${ci.body} body + cta)`);
    console.log(`  intégrité: promis ${ci.promised ?? "n/a"} / montré ${ci.body} -> ${ci.ok ? "OK" : "INCOHÉRENT"}`);
    console.log(`  fournisseur cité : ${bad.length ? bad.join(", ") : "aucun"}`);
    console.log(`  temps    : Claude ${(wrote / 1000).toFixed(1)}s + rendu ${(rendered / 1000).toFixed(1)}s = ${((wrote + rendered) / 1000).toFixed(1)}s`);
    for (const s of spec.slides) console.log(`    [${String(s.role).padEnd(4)}] ${String(s.headline ?? "").slice(0, 58)}`);
    console.log(`  -> ${path.dirname(files[0])} (${files.length} PNG)`);
  }
}

main().catch((e) => { console.error("\nFATAL:", e.message); process.exit(1); });
