// scripts/scan-ugc-compliance.mjs — compliance scan of downloaded UGC clips.
// Extracts evenly-spaced frames with ffmpeg, then asks Claude vision to read every
// burned-in overlay (watermarks, logos, subtitles, end cards) on those frames.
//
//   node-x64 --env-file=.env.local scripts/scan-ugc-compliance.mjs [--all] [--apply]
//
// Default target: clips sourced from UK/DE/FR (CA/US are established-clean unboxings).
// --all rescans every clip in the manifest. --apply DELETES the non-compliant files;
// without it the scan is read-only and just reports.
//
// POLICY (docs + project rules):
//   • "Aosom" — the supplier name — is STRICTLY FORBIDDEN in anything client-facing.
//   • Skeepers / any third-party influencer-review platform branding is forbidden.
//   • House brands (Outsunny, HOMCOM, PawHut, Vinsetto, Qaba, Kleankin) are TOLERATED
//     in product videos, so they are recorded but never a reason to reject.
// The model only REPORTS what it reads; this script applies the policy, so the verdict
// is auditable rather than delegated to the model's judgement.
import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, unlinkSync, readdirSync } from "node:fs";

const FRAMES = 8;
const CONCURRENCY = 3;
const APPLY = process.argv.includes("--apply");
const ALL = process.argv.includes("--all");
const TMP = "C:/Users/vente/AppData/Local/Temp/claude/C--Users-vente-Documents-aosom-sync/51ae0182-f15e-48b2-934c-f7931342d0ae/scratchpad/ugc-frames";

const manifest = JSON.parse(readFileSync("docs/new-ugc-manifest.json", "utf8"));
const targets = manifest.filter((m) => ALL || ["UK", "DE", "FR"].includes(m.country));
console.log(`${targets.length} clips à scanner (${FRAMES} frames chacun)${APPLY ? "  — MODE --apply : les non-conformes seront SUPPRIMÉS" : "  — lecture seule"}\n`);

mkdirSync(TMP, { recursive: true });
const client = new Anthropic();

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "buffer", stdio: ["ignore", "pipe", "pipe"] });

function duration(file) {
  const out = sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim();
  const d = parseFloat(out);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

function extractFrames(sku) {
  const src = `src/ugc/${sku}.mp4`;
  const dur = duration(src);
  if (!dur) return { frames: [], dur: 0 };
  const dir = `${TMP}/${sku}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const frames = [];
  for (let i = 0; i < FRAMES; i++) {
    // Spread across the clip, biased away from the very first/last frame.
    const t = (dur * (i + 0.5)) / FRAMES;
    const out = `${dir}/f${String(i).padStart(2, "0")}.jpg`;
    try {
      sh("ffmpeg", ["-nostdin", "-loglevel", "error", "-ss", t.toFixed(2), "-i", src,
        "-frames:v", "1", "-vf", "scale='min(768,iw)':-2", "-q:v", "4", "-y", out]);
      frames.push(out);
    } catch { /* a seek past the end just yields no frame */ }
  }
  return { frames, dur };
}

const PROMPT = `Tu analyses des frames extraites d'une vidéo UGC (client) destinée à une fiche produit e-commerce.

Lis TOUT texte incrusté dans l'image : filigranes, logos, sous-titres gravés, cartons de début/fin, bandeaux, pseudos, mentions de plateforme.

Réponds UNIQUEMENT avec un objet JSON, sans texte autour :
{
  "texte_lu": ["chaque bout de texte lisible, verbatim"],
  "mentionne_aosom": true|false,
  "mentionne_skeepers": true|false,
  "plateforme_avis_tierce": null|"nom",
  "filigrane": true|false,
  "description_filigrane": null|"où et à quoi il ressemble",
  "marques_maison_vues": ["Outsunny","HOMCOM","PawHut","Vinsetto","Qaba","Kleankin" parmi celles réellement visibles],
  "visages_identifiables": true|false,
  "notes": "une phrase"
}

Sois strict sur "mentionne_aosom" : true si le mot "Aosom" apparaît sous n'importe quelle forme, même partiel ou dans une URL.`;

async function analyze(sku, frames) {
  const content = frames.map((f) => ({
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: readFileSync(f).toString("base64") },
  }));
  content.push({ type: "text", text: PROMPT });
  const res = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    messages: [{ role: "user", content }],
  });
  if (res.stop_reason === "refusal") throw new Error(`refus: ${res.stop_details?.category}`);
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("pas de JSON dans la réponse");
  return JSON.parse(m[0]);
}

// Policy applied here, not by the model.
//
// FAIL CLOSED. The model's JSON drives an irreversible delete, so a field that is
// missing or not the expected type is a REJECT flagged for manual review — never a
// silent "clean". The dangerous direction is the false NEGATIVE: a dropped field
// treated as false would publish a non-compliant clip.
function asBool(val, field, reasons) {
  if (typeof val === "boolean") return val;
  reasons.push(`champ "${field}" absent ou non booléen (${JSON.stringify(val)}) — vérif manuelle`);
  return false;
}

function verdict(v) {
  const reasons = [];
  if (asBool(v.mentionne_aosom, "mentionne_aosom", reasons)) reasons.push('mention "Aosom"');
  if (asBool(v.mentionne_skeepers, "mentionne_skeepers", reasons)) reasons.push("filigrane/mention Skeepers");
  // The model is told to send null here; it sometimes sends the STRING "null".
  const plat = v.plateforme_avis_tierce;
  if (plat != null && String(plat).trim() !== "" && String(plat).trim().toLowerCase() !== "null") {
    reasons.push(`plateforme tierce: ${plat}`);
  }
  return { ok: reasons.length === 0, reasons };
}

const results = [];
let i = 0;
async function worker() {
  for (;;) {
    const t = targets[i++];
    if (!t) return;
    const { sku, country } = t;
    try {
      const { frames, dur } = extractFrames(sku);
      if (!frames.length) { results.push({ sku, country, error: "aucune frame extraite" }); console.log(`✗ ${sku.padEnd(15)} [${country}] aucune frame`); continue; }
      const v = await analyze(sku, frames);
      const d = verdict(v);
      // `...v` FIRST: the model's raw JSON is untrusted data, so the trusted fields
      // that follow always win. Spread last, any key the model emits (sku, verdict,
      // reasons) would silently overwrite them — and `sku` drives the delete path below.
      results.push({ ...v, sku, country, durationSec: Math.round(dur), verdict: d.ok ? "CONFORME" : "NON CONFORME", reasons: d.reasons });
      console.log(`${d.ok ? "✓" : "✗"} ${sku.padEnd(15)} [${country}] ${d.ok ? "conforme" : "REJET — " + d.reasons.join(", ")}`);
    } catch (e) {
      results.push({ sku, country, error: String(e.message || e) });
      console.log(`! ${sku.padEnd(15)} [${country}] erreur — ${e.message}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

results.sort((a, b) => a.sku.localeCompare(b.sku));
writeFileSync("docs/ugc-compliance-scan.json", JSON.stringify(results, null, 2));

const bad = results.filter((r) => r.verdict === "NON CONFORME");
const good = results.filter((r) => r.verdict === "CONFORME");
const errs = results.filter((r) => r.error);
console.log(`\n=== SCAN ===\nconformes ${good.length} · non conformes ${bad.length} · erreurs ${errs.length}`);

if (bad.length) {
  console.log(`\nNon conformes :`);
  for (const r of bad) console.log(`  ${r.sku.padEnd(15)} [${r.country}] ${r.reasons.join(", ")}`);
  if (APPLY) {
    let del = 0;
    for (const r of bad) {
      const f = `src/ugc/${r.sku}.mp4`;
      if (existsSync(f)) { unlinkSync(f); del++; }
    }
    console.log(`\n${del} fichiers supprimés de src/ugc/.`);
  } else {
    console.log(`\n(lecture seule — relancer avec --apply pour supprimer)`);
  }
}
rmSync(TMP, { recursive: true, force: true });
console.log(`\n→ docs/ugc-compliance-scan.json`);
