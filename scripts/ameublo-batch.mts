/**
 * Studio Ameublo — batch generator: ~15 videos per style and per language (FR = Ameublo, EN = Furni).
 *
 * Free: our own SVG + sharp + ffmpeg, no AI call. Each video goes to Blob and into
 * `ameublo_test_videos` (style, lang, caption, skus, prices, music), where the operator approves it
 * from /ameublo. NOTHING here touches publication_queue.
 *
 *   node-x64 --env-file=../aosom-sync/.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/ameublo-batch.mts --state DIR --plan [--count 15] [--styles a,b] [--campaign maison-2026]
 *   node-x64 --env-file=../aosom-sync/.env.local node_modules/tsx/dist/cli.mjs \
 *     scripts/ameublo-batch.mts --state DIR --render [--only style] [--max N] [--budget-ms 540000]
 *
 * --plan   builds DIR/plan.json (read-only: Turso + Shopify). Products are live (active), priced
 *          like Shopify, FR-titled, with clean photos; no supplier name in any title.
 * --render renders the planned jobs not yet in DIR/done.jsonl (resumable) and writes a contact
 *          sheet per video in DIR/sheets for the reviewer. Stops starting new jobs after the budget.
 * --preview with --render: no Blob upload, no DB row, no done.jsonl; mp4 + sheet stay in DIR.
 * SEQ_ASSETS_ROOT = the main clone (music + UGC clips are gitignored); default ../aosom-sync.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createClient } from "@libsql/client";

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (n: string) => argv.includes(n);

const STATE = flag("--state");
const ALL = ["reaction", "vitrine", "astuce", "devine", "ab", "top3", "piece"] as const;
type Style = (typeof ALL)[number];
type Lang = "fr" | "en";
const STYLES = (flag("--styles")?.split(",") ?? [...ALL]) as Style[];
const COUNT = Number(flag("--count") ?? 15);
const CAMPAIGN = flag("--campaign") ?? "maison-2026";
const SERIES = flag("--series") ?? "Série d’octobre 2026";
/** --pool halloween: seasonal decor pool (inflatables, animatronics) instead of the furniture pool. */
const HALLOWEEN = (flag("--pool") ?? "furniture") === "halloween";
const ROOT = process.env.SEQ_ASSETS_ROOT || path.resolve("../aosom-sync");
const FFMPEG =
  process.env.FFMPEG_BIN ||
  "C:\\Users\\vente\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe";
const audio = (f: string) => path.join(ROOT, "src/audio", f);

/** Mat's six picks (settings ameublo_music_picks). pick49 is Christmas-only. */
const PICK = {
  5: "pick05-chillhop-jazz-coffee-shop.mp3",
  30: "pick30-chill-reel.mp3",
  49: "pick49-that-christmas.mp3",
  59: "pick59-sunny-beat.mp3",
  60: "pick60-happy-energetic-lofi.mp3",
  75: "pick75-soul-chill-house.mp3",
} as const;
const TRACKS: Record<Style, number[]> = {
  reaction: [60, 59, 75],
  vitrine: [30, 5, 75],
  astuce: [5, 75, 30],
  devine: [59, 60, 30],
  ab: [59, 75, 60],
  top3: [60, 75, 59],
  piece: [75, 30, 5],
};
const NOEL_TRACK = 49;

const FORBIDDEN = /aosom|homcom|outsunny|qaba|pawhut|vinsetto|kleankin|costway|soozier|aiyaplay/i;

interface PlanProduct {
  sku: string;
  titleFr: string;
  titleEn: string;
  /** Screen/caption titles: clean cuts that fit the scene (no ellipsis, no dangling word). */
  shortFr: string;
  shortEn: string;
  /** Aosom-CDN URL of the validated clean lifestyle photo (Shopify tag lifestyle-verified), when the style needs a second photo. */
  lifeUrl?: string;
  price: number;
  handle: string;
  productType: string;
}
interface Job {
  id: string;
  style: Style;
  lang: Lang;
  n: number;
  campaign: string;
  room?: string;
  music: number;
  products: PlanProduct[];
}

// ───────────────────────── planning ─────────────────────────

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled<T>(xs: T[], seed: number): T[] {
  const r = rng(seed);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const seedOf = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

const GROUPS: [string, RegExp][] = HALLOWEEN ? [["halloween", /Halloween Decorations/]] : [
  ["living", /^Home Furnishings > Living Room Furniture/],
  ["bedroom", /^Home Furnishings > Bedroom Furniture/],
  ["dining", /^Home Furnishings > Kitchen & Dining Furniture/],
  ["storage", /^Home Furnishings > Storage & Organization/],
  ["decor", /^Home Furnishings > Home Décor/],
  ["bath", /^Home Furnishings > Bathroom Furniture/],
  ["office", /^Office Products > Office Furniture/],
  ["pets", /^Pet Supplies > (Cats > Cat Trees|Dogs)/],
];
const groupOf = (t: string) => GROUPS.find(([, re]) => re.test(t))?.[0] ?? null;

/** Last product_type segment, matched exactly for "same category" styles (top 3, A/B). */
const SAME_TYPES = [
  "Accent Chairs", "Coffee Tables", "TV Stands", "Dining Chairs", "Bar Stools", "Bedside Tables",
  "Storage Cabinets", "Storage Ottomans & Benches", "Shoe Storage Cabinets & Racks", "Computer Desks", "Task Chairs",
  "Display Bookshelves", "Dressing & Vanity Tables", "Room Dividers", "Dining Tables", "Bar Cabinets", "Side Tables",
  "Kitchen Pantry Cabinets", "Office Cabinets & Cupboards", "Writing Desks",
];
const lastSeg = (t: string) => t.split(">").pop()!.trim();
/** Halloween "same kind" groups (A/B, Top 3) and the four roles of a Halloween display, matched on the English name. */
const HALLOWEEN_KINDS = ["inflatable|airblown|blow[- ]?up", "grim reaper", "witch", "clown", "skeleton|zombie|mummy|ghost"];
const HALLOWEEN_ROLES = [/inflatable|airblown|blow[- ]?up/i, /reaper|zombie|skeleton|mummy/i, /witch|clown|angel|girl/i, /ghost|pumpkin|tree|stake|swing/i];
const kindKey = (r: { type: string; name: string }) => (HALLOWEEN ? r.name : lastSeg(r.type));
/**
 * Halloween listings carry 60-80 character titles ("Décoration gonflable Halloween fantôme citrouille 9 pi",
 * "6FT Life Size Halloween Animatronics, Animated Grim Reaper Groom with…") that no clean cut fits on screen, so the
 * on-screen name is written by hand from the live listing: [FR, EN], 30 characters at most, no colour, no brand.
 * A SKU missing here is not planned. 830-097 is left out on purpose: Shopify says "Chat noir", Aosom says "Spider".
 */
const HALLOWEEN_TITLES: Record<string, [string, string]> = {
  "844-901V80BK": ["Fantôme citrouille gonflable 8 pi", "8 ft Inflatable Pumpkin Ghost"],
  "84J-084V00GY": ["Squelette suspendu en cage", "Hanging Skeleton in a Cage"],
  "830-095": ["Citrouille et fantômes gonflables", "Inflatable Pumpkin and Ghosts"],
  "844-184": ["Faucheur citrouille gonflable 7 pi", "7 ft Inflatable Pumpkin Reaper"],
  "844-173": ["Fantôme gonflable 6 pi", "6 ft Inflatable Ghost"],
  "844-037": ["Arbre hanté gonflable", "Inflatable Haunted Tree"],
  "844-385V80": ["Squelette fantôme gonflable 10 pi", "10 ft Inflatable Skeleton Ghost"],
  "844-384V80": ["Fantôme citrouille gonflable 9 pi", "9 ft Inflatable Pumpkin Ghost"],
  "844-492V80MX": ["Fantôme gonflable 7 pi", "7 ft Inflatable Ghost"],
  "84J-303V00BK": ["Faucheur animé grandeur nature", "Life-Size Animated Reaper"],
  "84J-283V00BK": ["Trio de sorcières lumineuses", "Glowing Witch Trio Yard Stakes"],
  "84J-285V00MX": ["Faucheur animé 5,6 pi", "5.6 ft Animated Grim Reaper"],
  "830-105": ["Faucheuse en moto gonflable", "Inflatable Reaper on Motorcycle"],
  "844-522V00BK": ["Squelette animé 6 pieds", "6 ft Animated Grim Reaper"],
  "844-511V00MX": ["Clown animé lumineux 170 cm", "5.6 ft Animated Clown"],
  "844-683V80BK": ["Citrouille fantôme gonflable 9 pi", "9 ft Inflatable Ghost with Pumpkins"],
  "844-692V00GN": ["Sorcière animée 180 cm", "6 ft Animated Witch"],
  "844-843V00BK": ["Clown animé grandeur nature", "5.7 ft Life-Size Animated Clown"],
  "844-848V00GY": ["Sorcière animée avec sons", "Animated Witch with Sound"],
  "84J-080V00KK": ["Squelette animé yeux LED", "Animated Skeleton, LED Eyes"],
  "84J-078V00BK": ["Zombie rampant animé 6 pi", "6 ft Animated Crawling Zombie"],
  "84J-082V00RD": ["Clown animé grandeur nature", "Life-Size Animated Clown"],
  "84J-109V80BK": ["Faucheur gonflable géant 12 pi", "12 ft Inflatable Grim Reaper"],
  "84J-284V00YG": ["Momie suspendue 6 pieds", "6 ft Hanging Mummy"],
  "84J-288V00CG": ["Ange pleureur animé", "Animated Crying Angel"],
  "84J-316V00MX": ["Fille animée sur balançoire", "Animated Girl on a Swing"],
  "844-693V00BK": ["Sorcière grandeur nature 183 cm", "6 ft Life-Size Witch"],
  "844-855V00GY": ["Faucheur ailé grandeur nature", "6.4 ft Winged Grim Reaper"],
  "844-873V00VT": ["Sorcière animée grandeur nature", "5.9 ft Animated Old Witch"],
  "844-874V00BN": ["Sorcière animée avec balai", "6.2 ft Witch with Broomstick"],
  "844-872V00GY": ["Clown animé 183 cm", "6 ft Classic Animated Clown"],
  "844-690V00GY": ["Momie suspendue animée", "4.7 ft Hanging Mummy"],
  "844-696V00GY": ["Zombie rampant animé 5 pi", "5.2 ft Crawling Zombie"],
};
/** What a Halloween item IS, FR and EN words per subject. A FR title and an EN name that share no subject describe different products. */
const SUBJECTS: RegExp[] = [
  /skeleton|reaper|squelette|faucheu/i, /ghost|fantôme|fantome/i, /pumpkin|jack-o|citrouille/i, /witch|sorci/i, /clown/i, /zombie/i,
  /mummy|momie/i, /spider|araignée|araignee/i, /\bcat\b|chat\b/i, /angel|\bange\b/i, /\bgirl\b|fille/i, /\btree\b|arbre/i,
];
const subjectsOf = (t: string) => new Set(SUBJECTS.map((re, i) => (re.test(t) ? i : -1)).filter((i) => i >= 0));
const hasSubject = (t: string) => subjectsOf(t).size > 0;
/** A room is four DIFFERENT roles that belong together (no benches in a bedroom or an office). */
const ROOMS: Record<string, RegExp[]> = {
  salon: [/Accent Chairs|Sofas|Couchs|Sofa Bed/, /Coffee Tables/, /TV Stands|Room Dividers/, /Side Tables|Console Tables|Display Bookshelves/],
  bureau: [/Computer Desks|Writing Desks|Gaming Desks/, /Task Chairs|Executive & Manager Chairs/, /Office Cabinets/, /Display Bookshelves|Small Bookshelves/],
  chambre: [/Bedside Tables/, /Dressing & Vanity/, /Clothing Storage/, /Full Length Mirrors|Wall Mirrors|Bed Frames/],
  cuisine: [/^Dining Tables$/, /Dining Chairs/, /Bar Cabinets/, /Wall Mirrors|Console Tables/],
};
const ROOM_ORDER = ["salon", "bureau", "chambre", "cuisine"];
/** Items that do not belong in a given room, whatever their category says (QA 2026-10-04). */
const ROOM_BAN: Record<string, RegExp> = {
  salon: /kids?|enfants?|children|toy|jouet|bar stool|pantry|garde-manger|kitchen|cuisine|office|desk|bureau|trash|poubelle/i,
  bureau: /reading|lecture|nook|pantry|garde-manger|buffet|sideboard|kitchen|cuisine|kids?|enfants?|children|toy|jouet|bench|banc|ottoman|pouf|shoe|chaussure|vanity|coiffeuse|makeup|maquillage|stool|tabouret|mirror|miroir|bar cabinet|wine/i,
  chambre: /bench|banc|coat|manteau|entryway|entrée|hall|filing|classeur|trash|poubelle|pantry|garde-manger|buffet|sideboard|kitchen|cuisine|kids?|enfants?|children|toy|jouet|shoe|chaussure|bar cabinet|wine|office|bureau/i,
  cuisine: /island|îlot|cart|chariot|pantry|garde-manger|kids?|enfants?|children|toy|jouet|office|desk|bureau|gaming|trash|poubelle/i,
};
/** Never worth a video: ambiguous items. */
const GLOBAL_BAN = /trash|poubelle|garbage|ordures|waste bin|litter|dead body|cadavre/i;
/** Product classes: A/B and Top 3 only compare items of the same class (no trash cabinet among storage cabinets). */
const CLASSES: [string, RegExp][] = [
  ["shoe", /shoe|chaussure/i], ["bench", /ottoman|pouf|bench|banc/i], ["drawing", /drawing|drafting|dessin|art table/i],
  ["folding", /folding|pliant|pliable/i], ["resin", /resin|résine|plastic|plastique/i], ["kids", /kids?|enfants?|children|toddler/i],
  ["pantry", /pantry|garde-manger/i], ["buffet", /buffet|sideboard|credenza|vaisselier/i], ["vanity", /vanity|coiffeuse|makeup|maquillage/i],
  ["recliner", /recliner|inclinable/i], ["rocking", /rocking|berçante|bascule/i], ["gaming", /gaming|gamer/i],
  ["wall", /wall[- ]?mount|mural|floating|flottant|suspendu/i], ["filing", /filing|classeur/i], ["corner", /corner|d.angle/i], ["lshape", /l[- ]shaped|en l\b/i], ["rolling", /rolling|roulettes|mobile/i],
  ["standing", /standing desk|sit[- ]stand|debout/i], ["bar", /bar stool|tabouret de bar/i], ["bedframe", /bed frame|lit |sommier/i],
];
const classOf = (p: { titleEn: string; titleFr: string }) => CLASSES.find(([, re]) => re.test(`${p.titleEn} ${p.titleFr}`))?.[0] ?? "plain";
/** Photos whose classifier note mentions a person, a body part or a multi-image collage are never used. */
/** A colour in the title is a claim the (group-level) photo may contradict. */
const COLOUR = /\b(noir|noire|blanc|blanche|gris|grise|brun|brune|beige|bleu|bleue|vert|verte|rouge|rose|crème|doré|dorée|argenté|marine|noyer|chêne|black|white|gr[ae]y|brown|blue|green|red|pink|cream|gold|golden|silver|navy|walnut|oak|charcoal|ivory|taupe|champagne)\b/i;
/** Quantity marker: A/B and Top 3 only compare items sold in the same unit. */
const unitOf = (t: string) => /(?:lot de|ensemble de|set of|pack of)\s*(\d+)|(\d+)[- ]?(?:pack|pcs?|pièces?|pieces?)/i.exec(t)?.slice(1).find(Boolean) ?? "1";
const PEOPLE = /(personnes?|femmes?|hommes?|visages?|mannequins?|bébés?|people|person|woman|women|man|men|hands?|mains?|legs?|jambes?|utilisat(?:eur|rice)s?|famille|couple|girl|boy|lady|collage|mosaïque|côte à côte|split[- ]screen|multi-?vues?|quatre images|plusieurs (?:images|vues|photos))/i;
/** Where a title is drawn on screen: [chars per line, lines]. */
const TITLE_FIT: Partial<Record<Style, [number, number]>> = { astuce: [30, 2], ab: [24, 2], top3: [28, 2] };
const TITLE_MAX: Partial<Record<Style, number>> = { ab: 44, astuce: 56, top3: 52 };

async function cleanStemSet(turso: ReturnType<typeof createClient>, stems: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (!stems.length) return out;
  const r = await turso.execute({ sql: `SELECT url_stem, reason FROM image_classifications WHERE compliant = 1 AND url_stem IN (${stems.map(() => "?").join(",")})`, args: stems });
  for (const x of r.rows) if (!PEOPLE.test(String(x.reason ?? ""))) out.add(String(x.url_stem));
  return out;
}

async function plan() {
  const { cleanEnglishTitle, cleanTitle } = (await import("@/lib/ameublo-i18n")) as typeof import("@/lib/ameublo-i18n");
  const { wrap } = (await import("@/lib/video-engines/ameublo-scenes")) as typeof import("@/lib/video-engines/ameublo-scenes");
  const sp = (await import("@/lib/selectors/shopify-product")) as typeof import("@/lib/selectors/shopify-product");
  const audit = (await import("@/lib/image-compliance-audit")) as unknown as { imageUrlStem: (u: string) => string };
  const turso = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const rejects: Record<string, number> = {};
  const rej = (why: string) => (rejects[why] = (rejects[why] ?? 0) + 1);

  type Row = { sku: string; name: string; price: number; type: string; handle: string; pid: string };
  const pool = (
    await turso.execute(`
      SELECT MIN(sku) AS sku, name, price, product_type, shopify_handle, shopify_product_id
      FROM products
      WHERE shopify_product_id IS NOT NULL AND shopify_product_id != '' AND shopify_handle != ''
        AND qty >= 3 AND price BETWEEN 30 AND 1500 AND image1 IS NOT NULL AND image1 != ''
        AND ${
          HALLOWEEN
            ? "product_type LIKE '%Halloween Decorations%'"
            : `(product_type LIKE 'Home Furnishings > %' OR product_type LIKE 'Office Products > Office Furniture%'
             OR product_type LIKE 'Pet Supplies > Cats > Cat Trees%' OR product_type LIKE 'Pet Supplies > Dogs%')
        AND product_type NOT LIKE '%Holiday & Seasonal%' AND product_type NOT LIKE '%Artificial Trees%'
        AND product_type NOT LIKE '%Appliances%' AND product_type NOT LIKE '%Fireplaces%'`
        }
      GROUP BY shopify_product_id`)
  ).rows.map((r) => ({
    sku: String(r.sku), name: String(r.name), price: Number(r.price), type: String(r.product_type),
    handle: String(r.shopify_handle), pid: String(r.shopify_product_id),
  })) as Row[];
  console.log(`pool: ${pool.length} candidate products`);

  const memo = new Map<string, Promise<PlanProduct | null>>();
  /** Live (active), priced like Shopify, French title, clean name, enough clean photos. */
  const valid = (r: Row, minPhotos: number, style: Style): Promise<PlanProduct | null> => {
    const k = `${r.sku}|${minPhotos}|${style}`;
    if (!memo.has(k)) {
      memo.set(k, (async () => {
        const f = await sp.resolveProductFields(r.pid);
        if (f.status !== "active") return rej("not active"), null;
        if (f.price == null || Math.abs(Number(f.price) - r.price) > 0.011) return rej("price differs from Shopify"), null;
        if (!f.titleFr) return rej("no FR title"), null;
        const titleEn = cleanEnglishTitle(r.name);
        if (FORBIDDEN.test(f.titleFr) || FORBIDDEN.test(titleEn)) return rej("supplier name in title"), null;
        if (GLOBAL_BAN.test(f.titleFr) || GLOBAL_BAN.test(titleEn)) return rej("banned item"), null;
        const maxT = TITLE_MAX[style] ?? 48;
        const fit = TITLE_FIT[style];
        const extra = fit ? (t: string) => { const u = t.toUpperCase(); return wrap(u, fit[0], fit[1]).join(" ") === u; } : undefined;
        let shortFr: string | null, shortEn: string | null;
        if (HALLOWEEN) {
          const t = HALLOWEEN_TITLES[r.sku];
          if (!t) return rej("no curated Halloween title"), null;
          const glue = (s: string) => s.replace(/(\d) (pi|ft|pieds|cm)\b/g, "$1 $2");
          [shortFr, shortEn] = [glue(t[0]), glue(t[1])];
          if (extra && !(extra(shortFr) && extra(shortEn))) return rej("curated title does not fit the scene"), null;
        } else {
          shortFr = cleanTitle(f.titleFr, "fr", maxT, extra);
          shortEn = cleanTitle(titleEn, "en", maxT, extra);
        }
        if (!shortFr || !shortEn) return rej("title cannot be cut cleanly"), null;
        if (COLOUR.test(shortFr) || COLOUR.test(shortEn)) return rej("colour in title"), null;
        if (HALLOWEEN) {
          const fr = subjectsOf(f.titleFr), en = subjectsOf(r.name);
          if (fr.size && en.size && ![...fr].some((i) => en.has(i))) return rej("FR/EN subject mismatch"), null;
          if (!hasSubject(shortEn) || !hasSubject(shortFr)) return rej("title does not say what the item is"), null;
        }
        let lifeUrl: string | undefined;
        if (minPhotos > 1) {
          // The only second photo we trust is the human-validated pos-1 lifestyle shot (no people, no text, no collage).
          const life = f.lifestyle.primaryImageUrl;
          if (!f.lifestyle.verified || !life) return rej("no verified lifestyle photo"), null;
          const row = (await turso.execute({ sql: "SELECT image1,image2,image3,image4,image5,image6,image7 FROM products WHERE sku = ?", args: [r.sku] })).rows[0];
          const urls = [1, 2, 3, 4, 5, 6, 7].map((i) => (row?.[`image${i}`] == null ? "" : String(row[`image${i}`]))).filter(Boolean);
          const ls = audit.imageUrlStem(life);
          lifeUrl = urls.find((u) => audit.imageUrlStem(u) === ls);
          if (!lifeUrl) return rej("lifestyle photo not in feed"), null;
          if (audit.imageUrlStem(urls[0]) === ls) return rej("lifestyle photo is image1"), null;
        }
        return { sku: r.sku, lifeUrl, titleFr: f.titleFr, titleEn, shortFr, shortEn, price: r.price, handle: f.handle || r.handle, productType: r.type };
      })());
    }
    return memo.get(k)!;
  };

  const jobs: Job[] = [];
  // --need "ab/fr=3,ab/en=2": plan only these replacements (variant numbers start at 30 so the copy differs from the first pass).
  const need = new Map<string, number>((flag("--need") ?? "").split(",").filter(Boolean).map((x) => { const [k, v] = x.split("="); return [k, Number(v)] as [string, number]; }));
  const skipSeries = flag("--skip-series");
  const skipPids = new Set<string>();
  if (skipSeries) {
    const usedRows = await turso.execute({ sql: "SELECT sku FROM ameublo_test_videos WHERE series LIKE ? AND qa_verdict = 'pass'", args: [skipSeries] });
    const skus = [...new Set(usedRows.rows.flatMap((r) => String(r.sku).split(",")))];
    for (let i = 0; i < skus.length; i += 200) {
      const part = skus.slice(i, i + 200);
      const pr = await turso.execute({ sql: `SELECT shopify_product_id AS pid FROM products WHERE sku IN (${part.map(() => "?").join(",")})`, args: part });
      for (const x of pr.rows) if (x.pid) skipPids.add(String(x.pid));
    }
    console.log(`skip-series: ${skipPids.size} products already used in "${skipSeries}"`);
  }
  const slotsFor = (style: Style) =>
    need.size
      ? (["fr", "en"] as const).flatMap((lang) => Array.from({ length: need.get(`${style}/${lang}`) ?? 0 }, (_, k) => ({ lang: lang as Lang, k: 30 + k, i: 0 })))
      : Array.from({ length: COUNT * 2 }, (_, i) => ({ lang: (i % 2 === 0 ? "fr" : "en") as Lang, k: i >> 1, i }));
  const music = (style: Style, lang: Lang, k: number) => TRACKS[style][(k + (lang === "en" ? 1 : 0)) % TRACKS[style].length];

  // Next valid, not-yet-used product of a list (advances the cursor; stops when exhausted).
  const puller = (rows: Row[], used: Set<string>, minPhotos: number, style: Style, ban?: RegExp) => {
    let c = 0;
    return async (): Promise<PlanProduct | null> => {
      while (c < rows.length) {
        const r = rows[c++];
        if (used.has(r.pid) || skipPids.has(r.pid)) continue;
        const p = await valid(r, minPhotos, style);
        if (p && ban && (ban.test(p.titleEn) || ban.test(p.titleFr) || ban.test(p.productType))) { rej("wrong room"); continue; }
        if (p) { used.add(r.pid); return p; }
      }
      return null;
    };
  };
  const SINGLE_MIN: Partial<Record<Style, number>> = { vitrine: 2, devine: 2 };

  for (const style of STYLES) {
    const used = new Set<string>();
    const sl = slotsFor(style);
    if (!sl.length) continue;
    const base = shuffled(pool, seedOf(style));

    if (style === "reaction") {
      const scan = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/ugc-compliance-scan.json"), "utf8")) as { sku: string; verdict: string; mentionne_aosom?: boolean; filigrane?: boolean }[];
      // 851-018: third-party English text on the sensor bin.
      const REACTION_EXCLUDE = new Set(["851-018"]);
      const ok = new Set(scan.filter((s) => s.verdict === "CONFORME" && !s.mentionne_aosom && !s.filigrane && !REACTION_EXCLUDE.has(s.sku)).map((s) => s.sku));
      const clips = fs.readdirSync(path.join(ROOT, "src/ugc")).map((f) => f.replace(/\.mp4$/, "")).filter((s) => ok.has(s));
      const rows = (
        await turso.execute({
          sql: `SELECT sku, name, price, product_type, shopify_handle, shopify_product_id FROM products
                WHERE sku IN (${clips.map(() => "?").join(",")}) AND shopify_product_id != '' AND qty >= 3 AND price > 0`, args: clips,
        })
      ).rows.map((r) => ({
        sku: String(r.sku), name: String(r.name), price: Number(r.price), type: String(r.product_type),
        handle: String(r.shopify_handle), pid: String(r.shopify_product_id),
      })) as Row[];
      // Off-season patio last: the feed is autumn.
      const sorted = shuffled(rows, 11).sort((a, b) => Number(/^Patio/.test(a.type)) - Number(/^Patio/.test(b.type)));
      // The same UGC clip serves both languages (different overlay text), so one product = one FR + one EN video.
      const next = puller(sorted, used, 1, style);
      for (let k = 0; k < COUNT; k++) {
        const p = await next();
        if (!p) { console.warn(`  reaction: only ${k} UGC-compliant products available`); break; }
        for (const lang of ["fr", "en"] as const)
          jobs.push({ id: `reaction-${lang}-${k}`, style, lang, n: k, campaign: CAMPAIGN, music: music(style, lang, k), products: [p] });
      }
      continue;
    }

    if (style === "vitrine" || style === "astuce" || style === "devine") {
      // Round-robin over the room families so the series is varied.
      const buckets = GROUPS.map(([g]) => puller(base.filter((r) => groupOf(r.type) === g), used, SINGLE_MIN[style] ?? 1, style));
      let b = 0;
      for (const s of sl) {
        let p: PlanProduct | null = null;
        for (let tries = 0; tries < buckets.length && !p; tries++) p = await buckets[b++ % buckets.length]();
        if (!p) { console.warn(`  ${style}: pool exhausted at ${jobs.filter((j) => j.style === style).length}`); break; }
        jobs.push({ id: `${style}-${s.lang}-${s.k}`, style, lang: s.lang, n: s.k, campaign: CAMPAIGN, music: music(style, s.lang, s.k), products: [p] });
      }
      continue;
    }

    if (style === "ab" || style === "top3") {
      const need = style === "ab" ? 2 : 3;
      // Per category, keep a small candidate pool and choose a comparable combination (same class, same unit,
      // honest price spread) instead of burning products on failed tries.
      const POOL_MAX = 10;
      const cats = (HALLOWEEN ? HALLOWEEN_KINDS : SAME_TYPES).map((t) => ({
        next: puller(base.filter((r) => (HALLOWEEN ? new RegExp(t, "i").test(r.name) : lastSeg(r.type) === t)), used, 1, style),
        cands: [] as PlanProduct[],
        dry: false,
      }));
      const combos = (arr: PlanProduct[], k: number): PlanProduct[][] => {
        if (k === 0) return [[]];
        const out: PlanProduct[][] = [];
        for (let i = 0; i <= arr.length - k; i++) for (const rest of combos(arr.slice(i + 1), k - 1)) out.push([arr[i], ...rest]);
        return out;
      };
      const comparable = (got: PlanProduct[]) => {
        const hi = Math.max(...got.map((g) => g.price));
        const lo = Math.min(...got.map((g) => g.price));
        const distinct = new Set(got.map((g) => g.titleFr.toLowerCase().split(" ").slice(0, 3).join(" "))).size === got.length;
        const sameClass = new Set(got.map(classOf)).size === 1;
        const sameUnit = new Set(got.map((g) => unitOf(g.titleEn) + "|" + unitOf(g.titleFr))).size === 1;
        const spreadOk = style === "top3" ? hi / lo <= 3 : (hi - lo) / hi >= 0.12 && hi / lo <= 2.5;
        return distinct && sameClass && sameUnit && spreadOk;
      };
      let b = 0;
      for (const s of sl) {
        let ps: PlanProduct[] = [];
        for (let tries = 0; tries < cats.length * 3 && !ps.length; tries++) {
          const c = cats[b++ % cats.length];
          while (!c.dry && c.cands.length < POOL_MAX) { const p = await c.next(); if (p) c.cands.push(p); else c.dry = true; }
          if (c.cands.length < need) continue;
          const hit = combos(c.cands, need).find(comparable);
          if (hit) { ps = hit; c.cands = c.cands.filter((x) => !hit.includes(x)); }
        }
        if (ps.length < need) { console.warn(`  ${style}: pool exhausted at ${jobs.filter((j) => j.style === style).length}`); break; }
        jobs.push({ id: `${style}-${s.lang}-${s.k}`, style, lang: s.lang, n: s.k, campaign: CAMPAIGN, music: music(style, s.lang, s.k), products: ps });
      }
      continue;
    }

    // piece: four complementary articles for one room, total kept reasonable.
    const lists: Record<string, ReturnType<typeof puller>[]> = {};
    const rooms = HALLOWEEN ? ["halloween"] : ROOM_ORDER;
    for (const room of rooms) lists[room] = (HALLOWEEN ? HALLOWEEN_ROLES : ROOMS[room]).map((re) => puller(base.filter((r) => re.test(kindKey(r))), used, 1, style, ROOM_BAN[room]));
    for (const s of sl) {
      const room = rooms[(s.k + (s.lang === "en" ? 1 : 0)) % rooms.length];
      const ps: PlanProduct[] = [];
      for (const [ri, next] of lists[room].entries()) { const p = await next(); if (p) ps.push(p); else console.warn(`    role ${ri} of ${room} empty`); }
      if (ps.length < 4 || ps.reduce((a, p) => a + p.price, 0) > 3000) { console.warn(`  piece(${room}): incomplete, skipped (${ps.length} found, total ${ps.reduce((a, p) => a + p.price, 0)})`); continue; }
      jobs.push({ id: `piece-${s.lang}-${s.k}`, style, lang: s.lang, n: s.k, campaign: CAMPAIGN, room, music: music(style, s.lang, s.k), products: ps });
    }
  }

  fs.mkdirSync(STATE!, { recursive: true });
  fs.writeFileSync(path.join(STATE!, "plan.json"), JSON.stringify(jobs, null, 1));
  const tally = new Map<string, number>();
  for (const j of jobs) tally.set(`${j.style}/${j.lang}`, (tally.get(`${j.style}/${j.lang}`) ?? 0) + 1);
  console.log(`\nplan: ${jobs.length} videos`);
  for (const style of STYLES) console.log(`  ${style.padEnd(9)} fr ${tally.get(`${style}/fr`) ?? 0}  en ${tally.get(`${style}/en`) ?? 0}`);
  console.log("rejected candidates:", rejects);
}

// ───────────────────────── rendering ─────────────────────────

async function render() {
  const planFile = path.join(STATE!, "plan.json");
  const doneFile = path.join(STATE!, "done.jsonl");
  const jobs = JSON.parse(fs.readFileSync(planFile, "utf8")) as Job[];
  const done = new Set(fs.existsSync(doneFile) ? fs.readFileSync(doneFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).id as string) : []);
  const only = flag("--only");
  const max = Number(flag("--max") ?? 1e9);
  const budget = Number(flag("--budget-ms") ?? 540000);
  const started = Date.now();
  const staged = (id: string) => fs.existsSync(path.join(STATE!, "preview", `${id}.json`));
  const todo = jobs.filter((j) => !done.has(j.id) && !(has("--preview") && staged(j.id)) && (!only || only.split(",").includes(j.style))).slice(0, max);
  console.log(`render: ${todo.length} to do (${done.size} done, ${jobs.length} planned)`);

  const interop = <T,>(m: T): T => ((m as { default?: T }).default ?? m);
  const scenes = interop(await import("@/lib/video-engines/ameublo-scenes"));
  const sprite = interop(await import("@/lib/ameublo-sprite"));
  const copy = interop(await import("@/lib/ameublo-copy"));
  const cap = interop(await import("@/lib/ameublo-caption"));
  const i18n = interop(await import("@/lib/ameublo-i18n"));
  const audit = interop(await import("@/lib/image-compliance-audit"));
  const db = interop(await import("@/lib/database"));
  const { put } = await import("@vercel/blob");
  const turso = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ameublo-batch-"));
  fs.mkdirSync(path.join(STATE!, "sheets"), { recursive: true });

  const download = async (url: string) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`download ${r.status} ${url}`);
    return Buffer.from(await r.arrayBuffer());
  };
  /** White-background shot first (always shows the whole piece), then audit-clean photos only. */
  const photosOf = async (sku: string, n: number, lifeUrl?: string): Promise<Buffer[]> => {
    const row = (await turso.execute({ sql: "SELECT image1,image2,image3,image4,image5,image6,image7 FROM products WHERE sku = ?", args: [sku] })).rows[0];
    const urls = [1, 2, 3, 4, 5, 6, 7].map((i) => (row?.[`image${i}`] == null ? "" : String(row[`image${i}`]))).filter(Boolean);
    if (lifeUrl) return Promise.all([urls[0], lifeUrl].map(download));
    const stems = [...new Set(urls.slice(1).map((u) => audit.imageUrlStem(u)))];
    const clean = await cleanStemSet(turso, stems);
    const seen = new Set<string>();
    const pick = [urls[0], ...urls.slice(1).filter((u) => clean.has(audit.imageUrlStem(u)))]
      .filter((u) => u && !seen.has(audit.imageUrlStem(u)) && seen.add(audit.imageUrlStem(u))).slice(0, n);
    if (!pick.length) throw new Error(`no images for ${sku}`);
    return Promise.all(pick.map(download));
  };
  const volumeOf = (file: string): number => {
    const r = spawnSync(FFMPEG, ["-hide_banner", "-i", file, "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" });
    const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(String(r.stderr));
    return m ? Number(m[1]) : NaN;
  };
  const sheet = (file: string, duration: number, out: string) =>
    execFileSync(FFMPEG, ["-y", "-hide_banner", "-loglevel", "error", "-i", file, "-vf", `fps=${(6 / duration).toFixed(4)},scale=270:480,tile=6x1`, "-frames:v", "1", "-q:v", "4", out]);

  try {
    for (const j of todo) {
      if (Date.now() - started > budget) { console.log("budget reached — resume with the same command"); break; }
      const lang = j.lang;
      const title = (p: PlanProduct) => (lang === "en" ? p.shortEn : p.shortFr);
      const ps = j.products.map((p) => ({ sku: p.sku, title: title(p), price: p.price, productType: p.productType }));
      const lead = ps[0];
      const accessory = sprite.accessoryForCampaign(j.campaign);
      const lines = copy.ameubloLines(lead.sku, `${lead.productType} ${j.products[0].titleEn}`, j.n, lang);
      const track = audio(PICK[(/^noel/.test(j.campaign) ? NOEL_TRACK : j.music) as keyof typeof PICK]);
      if (!fs.existsSync(track)) throw new Error(`music missing: ${track}`);
      const out = path.join(work, `${j.id}.mp4`);
      try {
        let spec;
        if (j.style === "reaction") {
          const clip = path.join(ROOT, "src/ugc", `${lead.sku}.mp4`);
          if (!fs.existsSync(clip)) throw new Error(`clip missing: ${clip}`);
          spec = await scenes.reactionScene(clip, lead, lines, accessory, track, lang);
        } else if (j.style === "vitrine") spec = await scenes.vitrineScene(await photosOf(lead.sku, 2, j.products[0].lifeUrl), lead, lines, accessory, track, lang);
        else if (j.style === "astuce") spec = await scenes.astuceScene((await photosOf(lead.sku, 1))[0], lead, lines, accessory, track, lang);
        else if (j.style === "devine") spec = await scenes.devinePrixScene(await photosOf(lead.sku, 2, j.products[0].lifeUrl), lead, accessory, track, lang);
        else if (j.style === "ab") {
          const [pa, pb] = await Promise.all(ps.map(async (p) => (await photosOf(p.sku, 1))[0]));
          spec = await scenes.ceciOuCaScene(pa, pb, ps[0], ps[1], accessory, track, lang);
        } else {
          const photos = await Promise.all(ps.map(async (p) => (await photosOf(p.sku, 1))[0]));
          const items = ps.map((p, i) => ({ photo: photos[i], p }));
          spec = j.style === "piece" ? await scenes.pieceScene(items, j.room ?? "salon", accessory, track, lang) : await scenes.top3Scene(items, accessory, track, lang);
        }
        await scenes.renderScene(spec, out, FFMPEG);

        const vol = volumeOf(out);
        if (!Number.isFinite(vol) || vol < -45) throw new Error(`audio silent or missing (mean ${vol} dB)`);
        sheet(out, spec.duration, path.join(STATE!, "sheets", `${j.id}.jpg`));

        const prices = Object.fromEntries(j.products.map((p) => [p.sku, p.price]));
        const caption = cap.ameubloCaption({
          style: j.style, lang, titles: ps.map((p) => p.title), prices: ps.map((p) => p.price), handles: j.products.map((p) => p.handle),
          room: j.room ? i18n.ROOM_LABEL[j.room]?.[lang] : undefined,
          cap: j.style === "top3" ? scenes.top3Cap(ps.map((p) => p.price)) : undefined, variant: j.n,
        });
        if (has("--preview")) {
          fs.mkdirSync(path.join(STATE!, "preview"), { recursive: true });
          fs.copyFileSync(out, path.join(STATE!, "preview", `${j.id}.mp4`));
          fs.writeFileSync(path.join(STATE!, "preview", `${j.id}.json`), JSON.stringify({
            id: j.id, style: j.style, lang, caption, titles: ps.map((p) => p.title), prices, vol, music: path.basename(track),
            lines: j.style === "reaction" ? undefined : lines, skus: j.products.map((p) => p.sku),
          }, null, 1));
          console.log(`  ◦ preview ${j.id}  ${vol.toFixed(1)} dB  ${caption.slice(0, 80).replace(/\n/g, " ")}`);
          continue;
        }
        const blob = await put(`ameublo-studio/${j.style}/${lang}/${Date.now()}-${j.id}.mp4`, fs.readFileSync(out), {
          access: "public", contentType: "video/mp4", addRandomSuffix: false, allowOverwrite: true,
        });
        const id = await db.insertAmeubloTestVideo({
          series: SERIES, sku: j.products.map((p) => p.sku).join(","), campaign: j.campaign,
          label: ps.map((p) => p.title).join(lang === "en" ? " vs " : " vs "), videoUrl: blob.url,
          style: j.style, lang, caption, skus: j.products.map((p) => p.sku), prices, music: path.basename(track),
        });
        fs.appendFileSync(doneFile, JSON.stringify({ id: j.id, videoId: id, url: blob.url, vol }) + "\n");
        console.log(`  ✓ ${j.id.padEnd(14)} #${id}  ${vol.toFixed(1)} dB  ${ps.map((p) => p.sku).join("+")}`);
      } catch (e) {
        console.error(`  ✗ ${j.id}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        fs.rmSync(out, { force: true });
      }
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Uploads staged videos that passed QA (ids in --ids) to Blob + DB, marked qa_verdict=pass. */
async function release() {
  const jobs = JSON.parse(fs.readFileSync(path.join(STATE!, "plan.json"), "utf8")) as Job[];
  const doneFile = path.join(STATE!, "done.jsonl");
  const done = new Set(fs.existsSync(doneFile) ? fs.readFileSync(doneFile, "utf8").split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l).id as string) : []);
  const ids = (flag("--ids") ?? "").split(",").filter(Boolean);
  const interop = <T,>(m: T): T => ((m as { default?: T }).default ?? m);
  const db = interop(await import("@/lib/database"));
  const { put } = await import("@vercel/blob");
  for (const id of ids) {
    if (done.has(id)) { console.log(`  = ${id} already released`); continue; }
    const j = jobs.find((x) => x.id === id);
    const meta = JSON.parse(fs.readFileSync(path.join(STATE!, "preview", `${id}.json`), "utf8"));
    if (!j) { console.error(`  ✗ ${id}: not in plan`); continue; }
    const blob = await put(`ameublo-studio/${j.style}/${j.lang}/${Date.now()}-${id}.mp4`, fs.readFileSync(path.join(STATE!, "preview", `${id}.mp4`)), {
      access: "public", contentType: "video/mp4", addRandomSuffix: false, allowOverwrite: true,
    });
    const vid = await db.insertAmeubloTestVideo({
      series: SERIES, sku: meta.skus.join(","), campaign: j.campaign, label: meta.titles.join(" vs "), videoUrl: blob.url,
      style: j.style, lang: j.lang, caption: meta.caption, skus: meta.skus, prices: meta.prices, music: meta.music,
    });
    await db.setAmeubloQa(vid, "pass", "Validée à la revue visuelle (2026-10-04)");
    fs.appendFileSync(doneFile, JSON.stringify({ id, videoId: vid, url: blob.url, vol: meta.vol }) + String.fromCharCode(10));
    console.log(`  ✓ ${id} #${vid} released`);
  }
}

if (!STATE) {
  console.error("usage: --state DIR (--plan | --render) [options]; see the header of this file");
  process.exit(1);
}
(has("--plan") ? plan() : has("--render") ? render() : has("--release") ? release() : Promise.reject(new Error("pass --plan or --render"))).catch((e) => {
  console.error(e);
  process.exit(1);
});
