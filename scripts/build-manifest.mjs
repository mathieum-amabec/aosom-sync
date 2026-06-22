// Build out/demand-gen-manifest.json from probed metadata + per-SKU clean-window AUDIT + Shopify FR titles.
// Audit = manual filmstrip review (1 fps) of every source: burned-in EN cards / supplier logos / clean window.
import { writeFileSync, readFileSync, existsSync } from "node:fs";

// FR titles (Shopify product.title, fetched earlier this session). Embedded to avoid
// needing .env.local / Shopify access from the isolated worktree.
const TITLES = {
  "01-0415":"Base de parasol carrée résine 9 kg — bronze",
  "845-774V00BK":"Jardinière surélevée acier galvanisé avec tiges renforcées 180cm",
  "01-0893":"Balançoire de jardin double à bascule pour patio",
  "120307-025":"Coussin de sécurité trampoline 12 pieds résistant UV",
  "823-002V80":"Climatiseur portable 10 000 BTU multifonction avec minuterie",
  "823-010V81":"Climatiseur portable 10000 BTU avec déshumidificateur et ventilateur",
  "845-039V01GY":"Jardinière surélevée galvanisée acier 120x60x30cm",
  "845-335":"Agenouilloir de jardin pliable avec coussin mousse EVA",
  "845-518GY":"Bac de jardinage surélevé galvanisé 241 x 91 x 30 cm",
  "845-792V00YL":"Jardinière surélevée avec treillis pour plantes grimpantes — jaune",
  "84A-054V05BK":"Balancelle de patio 3 places avec auvent ajustable",
  "84B-136":"Coussins de remplacement pour banc 3 places extérieur",
  "84B-146BU":"Chaise longue pliante 5 positions avec trou visage",
  "84C-226CG":"Rideaux gazebo universels 4 panneaux 10' x 12' — Foncé",
  "84H-209V00CG":"Bac surélevé galvanisé 152 x 91 x 61 cm",
  "D51-277V01":"Enclos pour poules extérieur avec toit 3,0 x 4,0 x 2,0 m",
  // Phase 2 (fans / furniture)
  "824-033WT":"Ventilateur sur pied oscillant avec télécommande et écran LED — blanc",
  "824-048V80RD":"Ventilateur tour oscillant 3 vitesses avec minuterie 12h et télécommande",
  "824-056V80WT":"Ventilateur tour oscillant avec écran LED tactile et télécommande — blanc",
  "837-339V80WT":"Armoire de pharmacie murale avec tablettes ajustables et porte unique",
  "838-075":"Buffet sideboard haute brillance 2 tiroirs 2 portes — gris et noir",
  "838-075WT":"Buffet sideboard haute brillance 2 tiroirs 2 portes — blanc",
};

// res/dur/fps from ffprobe; ss + cleanDur from the filmstrip audit (seconds).
// delogo = corner-logo patch (native-res coords) — only where a logo is PERSISTENT (not an intro/end card).
const A = [
  { sku:"01-0415", pid:"7798393897065", w:852,h:480,dur:21.56,fps:25, ss:4.0, cleanDur:13.5, delogo:null,
    audit:"EN title card 'Umbrella Base Weight Bag' 0-3s; Outsunny end-card ~20s. Clean 4-17.5s." },
  { sku:"845-774V00BK", pid:"7793456087145", w:1920,h:1080,dur:20.96,fps:25, ss:0.5, cleanDur:17.5, delogo:"delogo=x=6:y=6:w=260:h=120",
    audit:"PERSISTENT 'Outsunny by Aosom' corner logo (top-left) → delogo. End-card after ~18s." },
  { sku:"01-0893", pid:"7796435877993", w:852,h:478,dur:18.44,fps:25, ss:2.0, cleanDur:14.0, delogo:null,
    audit:"EN card 0-1s; Outsunny end-card ~17s. Clean 2-16s." },
  { sku:"120307-025", pid:"7796433551465", w:852,h:480,dur:18.84,fps:25, ss:12.0, cleanDur:3.0, delogo:null,
    audit:"FRAGMENTED: EN cards + floral/diagram graphic segments throughout; HOMCOM end-card. Max clean run ~3s. NOT VIABLE." },
  { sku:"823-002V80", pid:"7796432633961", w:852,h:478,dur:22.04,fps:25, ss:10.0, cleanDur:5.5, delogo:null,
    audit:"WEAK: EN feature callouts ~2-3s + scattered; end graphic ~16s. Best clean run ~5.5s (6s marginal, no 15s)." },
  { sku:"823-010V81", pid:"7798393176169", w:852,h:478,dur:22.04,fps:25, ss:12.0, cleanDur:4.0, delogo:null,
    audit:"WEAK: EN callouts ~2-3s, teal transitions ~10-11s. Best clean run ~4s. NOT VIABLE for 6s." },
  { sku:"845-039V01GY", pid:"7793455923305", w:852,h:480,dur:32.52,fps:25, ss:3.0, cleanDur:27.0, delogo:null,
    audit:"GOOD: green-studio intro logo 0-2s, then long clean product footage. Supports 30s (~27s clean)." },
  { sku:"845-335", pid:"9359738732649", w:852,h:480,dur:42.875,fps:24, ss:1.0, cleanDur:34.0, delogo:null,
    audit:"GOOD: brief EN text frame0, then continuous clean garden demo (42.9s total). Supports full 30s. (Tail >30s not in 30-frame strip.)" },
  { sku:"845-518GY", pid:"7798394617961", w:852,h:480,dur:27.76,fps:25, ss:13.0, cleanDur:11.0, delogo:null,
    audit:"green-studio intro + 'Garden' EN callout 0-5s, teal transition ~10-11s. Clean run ~11s (15s capped)." },
  { sku:"845-792V00YL", pid:"7796435255401", w:852,h:480,dur:23.32,fps:25, ss:6.0, cleanDur:11.0, delogo:null,
    audit:"studio + 'GardenBed' EN card 0-5s; clean planter 6-17s; sparkle + Outsunny end ~18-21s. ~11s (15s capped)." },
  { sku:"84A-054V05BK", pid:"7793456250985", w:852,h:478,dur:37.92,fps:25, ss:7.0, cleanDur:28.0, delogo:null,
    audit:"GOOD: 'SwingBench' EN card ~5s; clean swing footage after. Supports 30s (~28s clean). Tail beyond 30s not in strip." },
  { sku:"84B-136", pid:"7798393700457", w:852,h:480,dur:20.96,fps:25, ss:4.0, cleanDur:12.0, delogo:null,
    audit:"EN cards 'Outdoor Seat Cushion Set' 0-3s; clean cushion/bench 4-16s. ~12s (15s capped)." },
  { sku:"84B-146BU", pid:"7793455792233", w:852,h:480,dur:24.64,fps:25, ss:3.0, cleanDur:15.0, delogo:null,
    audit:"EN cards 0-2s; clean poolside lounge 3-18s; Outsunny end ~20s. Full 15s OK." },
  { sku:"84C-226CG", pid:"7798393831529", w:852,h:480,dur:21.48,fps:25, ss:0.5, cleanDur:11.5, delogo:null,
    audit:"clean start (no intro card); gazebo shots 0-12s; sparkle + Outsunny end ~13-14s. ~11.5s (15s capped)." },
  { sku:"84H-209V00CG", pid:"7796435714153", w:852,h:478,dur:26.28,fps:25, ss:7.0, cleanDur:16.0, delogo:null,
    audit:"'Garden Bed' EN label 0-6s; clean bed shots 7-23s; Outsunny end ~24s. Full 15s OK." },
  { sku:"D51-277V01", pid:"7798393995369", w:852,h:480,dur:24.28,fps:25, ss:0.5, cleanDur:22.5, delogo:null,
    audit:"CLEANEST (file '-WEB-NT' = no text): no EN cards, no logo. Clean ~0.5-23s. Full 15s OK." },
  // --- Phase 2 (fans / furniture). dims/dur/fps from ffprobe; ss/cleanDur from audit. ---
  { sku:"824-033WT", pid:"9364961362025", w:852,h:480,dur:22.36,fps:25, ss:3.0, cleanDur:13.0, delogo:null,
    audit:"Phase 2 fan. Clean window 3-16s (cleanDur 13s → 6s + 15s capped 13s)." },
  { sku:"824-048V80RD", pid:"9364961427561", w:852,h:480,dur:42.79,fps:24, ss:31.0, cleanDur:11.0, delogo:null,
    audit:"Phase 2 tower fan. Clean window 31-42s (cleanDur 11s → 6s + 15s capped 11s)." },
  { sku:"824-056V80WT", pid:"9364961493097", w:852,h:480,dur:40.71,fps:24, ss:26.0, cleanDur:14.0, delogo:null,
    audit:"Phase 2 tower fan. Clean window 26-40s (cleanDur 14s → 6s + 15s capped 14s)." },
  { sku:"837-339V80WT", pid:"9364962246761", w:1920,h:1080,dur:33.24,fps:25, ss:5.0, cleanDur:12.0, delogo:null,
    audit:"Phase 2 cabinet (1080p). Clean window 5-17s (cleanDur 12s → 6s + 15s capped 12s)." },
  { sku:"838-075", pid:"7752188985449", w:852,h:480,dur:44.96,fps:24, ss:31.0, cleanDur:9.0, delogo:null,
    audit:"Phase 2 sideboard. Clean window 31-40s (cleanDur 9s → 6s only; <10s, no 15s cut)." },
  { sku:"838-075WT", pid:"7752188985449", w:852,h:480,dur:36.08,fps:24, ss:21.0, cleanDur:9.0, delogo:null,
    audit:"Phase 2 sideboard. Clean window 21-30s (cleanDur 9s → 6s only; <10s, no 15s cut)." },
];

const DUR_BUCKETS = [6, 15, 30];
const SRC_30_OK = new Set(["845-039V01GY", "845-335", "84A-054V05BK"]); // sources long enough for a 30s cut
function variantsFor(a) {
  const out = [];
  for (const b of DUR_BUCKETS) {
    if (b === 30 && !SRC_30_OK.has(a.sku)) continue;
    const minNeeded = b === 6 ? 6 : b === 15 ? 10 : 26; // floor to bother emitting a bucket
    if (a.cleanDur < minNeeded) continue;
    const eff = Math.min(b, a.cleanDur);
    out.push({ bucket: b, effective_sec: Number(eff.toFixed(1)), capped: eff < b });
  }
  return out;
}
function viability(a) {
  if (a.cleanDur < 6) return "drop";          // no usable cut
  if (a.cleanDur < 7) return "weak";          // 6s only, marginal
  return "ok";
}

const ratios = ["16:9", "1:1", "9:16"];
const videos = [];
let totalAssets = 0;
for (const a of A) {
  const dur = variantsFor(a);
  const buckets = dur.map((d) => d.bucket);
  const status = viability(a);
  const perRatio = ratios.map((r) => ({
    ratio: r,
    durations: dur,
    crop_strategy: r === "16:9" ? "scale+pad (natif)" : "canevas paddé fond flou",
    quality_flag: r === "9:16" && a.h < 1080 ? "source 480p → upscale lourd vers 1080x1920 (mou)" : null,
  }));
  if (status !== "drop") totalAssets += dur.length * ratios.length;
  videos.push({
    sku: a.sku, title_fr: TITLES[a.sku] ?? null,
    shopify_product_id: `gid://shopify/Product/${a.pid}`,
    source_url: null, // filled below from URL map
    resolution: `${a.w}x${a.h}`, width: a.w, height: a.h, native_orientation: "16:9 paysage",
    duration: Number(a.dur.toFixed(2)), fps: a.fps, codec: "h264",
    audit: a.audit, viability: status,
    trim: { ss: a.ss, clean_duration_sec: a.cleanDur }, delogo: a.delogo,
    eligible_buckets_sec: buckets,
    variants: perRatio,
  });
}

// source URLs (from video_ingest_log)
const URLS = {
  "01-0415":"https://uspm.aosomcdn.com/videos/en/0/01-0415/01-0415-Outsunny-WEB.mp4",
  "845-774V00BK":"https://uspm.aosomcdn.com/videos/en/8/845-774V00BK/845-774V00BK.mp4",
  "01-0893":"https://uspm.aosomcdn.com/videos/en/0/01-0893/01-0893-Outsunny-WEB.mp4",
  "120307-025":"https://uspm.aosomcdn.com/videos/en/1/120307-025/120307-025-HOMCOM-WEB.mp4",
  "823-002V80":"https://uspm.aosomcdn.com/videos/en/8/823-002V80/823-002V80-HOMCOM-WEB.mp4",
  "823-010V81":"https://uspm.aosomcdn.com/videos/en/8/823-010V81/823-010V81-WEB.mp4",
  "845-039V01GY":"https://uspm.aosomcdn.com/videos/en/8/845-039V01GY/845-039V01GY-Outsunny-WEB.mp4",
  "845-335":"https://uspm.aosomcdn.com/videos/en/8/845-335/845-335-WEB.mp4",
  "845-518GY":"https://uspm.aosomcdn.com/videos/en/8/845-518GY/845-518GY-WEB.mp4",
  "845-792V00YL":"https://uspm.aosomcdn.com/videos/en/8/845-792V00YL/845-792V00YL-Outsunny-WEB.mp4",
  "84A-054V05BK":"https://uspm.aosomcdn.com/videos/en/8/84A-054V05BK/84A-054V05BK-Outsunny-WEB.mp4",
  "84B-136":"https://uspm.aosomcdn.com/videos/en/8/84B-136/84B-136-WEB.mp4",
  "84B-146BU":"https://uspm.aosomcdn.com/videos/en/8/84B-146BU/84B-146BU-Outsunny-WEB.mp4",
  "84C-226CG":"https://uspm.aosomcdn.com/videos/en/8/84C-226CG/84C-226CG-Outsunny-WEB.mp4",
  "84H-209V00CG":"https://uspm.aosomcdn.com/videos/en/8/84H-209V00CG/84H-209V00CG-Outsunny-WEB.mp4",
  "D51-277V01":"https://uspm.aosomcdn.com/videos/en/D/D51-277V01/D51-277V01-WEB-NT.mp4",
  // Phase 2 (fans / furniture)
  "824-033WT":"https://uspm.aosomcdn.com/videos/en/8/824-033WT/824-033WT-WEB.mp4",
  "824-048V80RD":"https://uspm.aosomcdn.com/aosomweb/product/CA/home/8/824-048V80RD.mp4",
  "824-056V80WT":"https://uspm.aosomcdn.com/aosomweb/product/CA/home/8/824-056V80WT.mp4",
  "837-339V80WT":"https://uspm.aosomcdn.com/videos/en/8/837-339V80WT/837-339V80WT.mp4",
  "838-075":"https://uspm.aosomcdn.com/videos/en/8/838-075/838-075-WEB-NT.mp4",
  "838-075WT":"https://uspm.aosomcdn.com/videos/en/8/838-075WT/838-075WT-WEB.mp4",
};
for (const v of videos) v.source_url = URLS[v.sku];

// Attach rendered outputs from the batch report (file paths + sizes). GCS upload is a later step.
let render = null;
if (existsSync("out/render-report.json")) {
  const rep = JSON.parse(readFileSync("out/render-report.json", "utf8"));
  render = { ok: rep.ok, fail: rep.fail, total_bytes: rep.total_bytes, total_mb: Number((rep.total_bytes / 1048576).toFixed(1)), elapsed_sec: rep.elapsed_sec };
  const bySku = {};
  for (const a of rep.assets) (bySku[a.sku] ??= []).push(a);
  for (const v of videos) {
    v.outputs = (bySku[v.sku] ?? []).map((a) => ({
      ratio: a.ratio, bucket_sec: a.bucket, effective_sec: a.effective_sec,
      file: a.file, size: a.size, ok: a.ok,
      gcs_url: null, // pending upload (brief Étape 5) — stagedUploadsCreate → GCS → manifest
    }));
  }
}

const manifest = {
  project: "Demand Gen / YouTube — recyclage des 16 vidéos produit existantes",
  generated_from: "video_ingest_log (16) + ffprobe + audit pellicule 1fps (session 2026-06-17)",
  ratios, duration_buckets_sec: DUR_BUCKETS,
  overlay: { font:"DM Sans", title_color:"#FFFFFF", benefit_color:"#D4A853", benefit_text:"Livraison gratuite au Canada",
    scrim:"dégradé Navy #1B2A4A 18% sur bas 18% hauteur", position:"bas centré, safe zone 10%",
    note:"benefit_text répété sur tous les assets — non conforme au brief (« pas de livraison gratuite répétée »), conservé sur décision de Mat." },
  brand_rules: ["aucun nom fournisseur à l'écran (logos retirés par trim/delogo)", "aucun texte anglais (cartons EN retirés par trim)", "aucune génération IA"],
  summary: {
    total_sources: videos.length,
    ok: videos.filter(v=>v.viability==="ok").length,
    weak: videos.filter(v=>v.viability==="weak").map(v=>v.sku),
    drop: videos.filter(v=>v.viability==="drop").map(v=>v.sku),
    supports_30s: [...SRC_30_OK],
    total_output_assets: totalAssets,
  },
  render,
  gcs_upload: "pending — Étape 5 du brief (stagedUploadsCreate → GCS). Aucune URL signée commitée.",
  videos,
};
writeFileSync("out/demand-gen-manifest.json", JSON.stringify(manifest, null, 2));
console.log("Wrote out/demand-gen-manifest.json");
console.log("titles:", videos.filter(v=>v.title_fr).length, "/", videos.length,
  "| assets:", totalAssets, "| ok:", manifest.summary.ok, "| weak:", manifest.summary.weak.join(","), "| drop:", manifest.summary.drop.join(","));
