// Phase 3 — DRY-RUN for attaching Aosom MP4 videos to Shopify products.
//
// Étape 1: confirm the Admin token has write_files + read_files + write_products.
// Étape 2: pick 3 top-30 SKUs that already have a products.video URL, and for each
//          TEST stagedUploadsCreate(resource: VIDEO) over GraphQL — this only asks
//          Shopify for a staged upload target; it does NOT upload the file and does
//          NOT attach anything to a product. No real video ingestion.
//
// Run:  node scripts/aosom-video-ingest-dry-run.mjs
import { loadEnv, gql, STORE, API_VERSION } from "./_shopify-lib.mjs";
import { createClient } from "@libsql/client";

const env = loadEnv();
const TOKEN = env.SHOPIFY_ACCESS_TOKEN;

// Top 30 by inferred stock velocity — docs/audit-pdp-video.md §6.
const TOP30 = [
  "84A-009BK", "84A-054V05BK", "845-792V00YL", "84K-241V00LG", "845-039V01GY",
  "845-652V00GY", "01-0893", "845-518GY", "84H-209V00CG", "845-774V00BK",
  "84G-791V00BK", "84A-009", "84C-142V01CG", "84A-009BN", "845-335",
  "84B-136BK", "844-610V00BK", "823-010V81", "84B-136", "370-198BK",
  "823-002V80", "84K-241V00CG", "867-034", "845-774V00SR", "84C-226CG",
  "84A-054V05BN", "D51-277V01", "84B-146BU", "824-024V80BK", "01-0902",
];

const STAGED = `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}`;

// ── Étape 1: scopes ──────────────────────────────────────────────────────────
console.log("=== Étape 1 — scopes du token Admin ===");
const scRes = await fetch(`https://${STORE}/admin/oauth/access_scopes.json`, {
  headers: { "X-Shopify-Access-Token": TOKEN },
});
if (!scRes.ok) throw new Error(`access_scopes ${scRes.status}: ${await scRes.text()}`);
const { access_scopes } = await scRes.json();
const have = new Set(access_scopes.map((s) => s.handle));
const required = ["write_files", "read_files", "write_products"];
let allScopes = true;
for (const need of required) {
  const ok = have.has(need);
  if (!ok) allScopes = false;
  console.log(`  ${ok ? "✓" : "✗"} ${need}`);
}
console.log(`  → ${allScopes ? "tous les scopes requis sont présents" : "SCOPES MANQUANTS"}`);

// ── Étape 2: pick 3 top-30 SKUs with a video ─────────────────────────────────
console.log("\n=== Étape 2 — SKUs top-30 avec vidéo (Turso) ===");
const db = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
const ph = TOP30.map(() => "?").join(",");
const r = await db.execute({
  sql: `SELECT sku, name, video FROM products
        WHERE sku IN (${ph}) AND video IS NOT NULL AND video != ''`,
  args: TOP30,
});
const withVideo = r.rows
  .map((row) => ({ sku: String(row.sku), name: String(row.name ?? ""), video: String(row.video) }))
  .slice(0, 3);
console.log(`  ${r.rows.length} des 30 ont une vidéo; test sur ${withVideo.length}.`);
if (withVideo.length === 0) {
  console.log("  Aucun SKU top-30 avec vidéo — rien à tester.");
  process.exit(0);
}

// ── Étape 2b: test stagedUploadsCreate(VIDEO) per product (no upload) ─────────
console.log("\n=== Étape 2b — test stagedUploadsCreate(resource: VIDEO) ===");
console.log("    (création d'une cible de staging uniquement — AUCUN upload, AUCUN produit modifié)\n");
for (const p of withVideo) {
  console.log(`• ${p.sku} — ${p.name.slice(0, 50)}`);
  console.log(`  vidéo Aosom : ${p.video}`);
  // HEAD to learn the byte size (VIDEO staged uploads want fileSize).
  let fileSize = null;
  try {
    const head = await fetch(p.video, { method: "HEAD" });
    fileSize = head.headers.get("content-length");
    console.log(`  HEAD ${head.status} · content-length=${fileSize ?? "?"} · type=${head.headers.get("content-type") ?? "?"}`);
  } catch (e) {
    console.log(`  HEAD échec: ${e.message}`);
  }
  const filename = (p.video.split("/").pop() || "video.mp4").split("?")[0];
  const input = [{ resource: "VIDEO", filename, mimeType: "video/mp4", httpMethod: "POST", ...(fileSize ? { fileSize } : {}) }];
  try {
    const { data } = await gql(STAGED, { input });
    const out = data.stagedUploadsCreate;
    if (out.userErrors?.length) {
      console.log(`  stagedUploadsCreate userErrors: ${JSON.stringify(out.userErrors)}`);
    } else {
      const t = out.stagedTargets?.[0];
      console.log(`  ✓ staged target OK · upload url: ${t?.url ? new URL(t.url).host : "(none)"}`);
      console.log(`    resourceUrl: ${t?.resourceUrl ?? "(none)"}`);
      console.log(`    params: ${(t?.parameters || []).map((x) => x.name).join(", ") || "(none)"}`);
    }
  } catch (e) {
    console.log(`  stagedUploadsCreate échec: ${e.message}`);
  }
  console.log("");
}

console.log("─".repeat(70));
console.log("DRY-RUN terminé — AUCUNE vidéo uploadée, AUCUN produit modifié.");
console.log("En attente de validation de Mat avant l'ingestion réelle.");
process.exit(0);
