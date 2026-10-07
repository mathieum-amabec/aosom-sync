// node update-final.mjs [--apply] — uploads the 16 re-rendered videos, then rewrites URL + caption on the 32 pending halloween-real rows.
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { put } from "@vercel/blob";
const ROOT = path.dirname(fileURLToPath(import.meta.url)).split(path.sep).join("/");
const apply = process.argv.includes("--apply");
const names = Array.from({ length: 16 }, (_, i) => "V" + String(i + 1).padStart(2, "0"));
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const FR_ADD = " Certaines conditions s'appliquent selon votre localisation (idéal pour la majorité des régions).";
const EN_ADD = " Some conditions apply depending on your location (works for most areas).";

const urls2 = existsOr(`${ROOT}/out/urls-final.json`);
function existsOr(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return {}; } }
if (apply) for (const n of names) {
  if (urls2[n]) continue;
  const r = await put(`ameublo-studio/halloween-real/final/${n}.mp4`, readFileSync(`${ROOT}/out/halloween-${n}.mp4`), { access: "public", contentType: "video/mp4", addRandomSuffix: true });
  urls2[n] = r.url; writeFileSync(`${ROOT}/out/urls-final.json`, JSON.stringify(urls2, null, 1)); console.log("uploaded", n);
}
const rows = await db.execute(`SELECT id, content_id, status, scheduled_at, payload FROM publication_queue WHERE content_id LIKE 'halloween-real:%' AND status='pending' ORDER BY scheduled_at, id`);
const stmts = [];
for (const x of rows.rows) {
  const [, n, brand] = String(x.content_id).split(":");
  const p = JSON.parse(String(x.payload));
  const add = brand === "furnish" ? EN_ADD : FR_ADD;
  const base = brand === "furnish" ? "Free shipping across Canada." : "Livraison gratuite partout au Canada.";
  const caption = p.caption.includes("conditions") ? p.caption : p.caption.replace(base, base + add);
  if (caption === p.caption && !apply) console.log("WARN no change", x.id);
  const next = { ...p, caption, reelsVideoUrl: apply ? urls2[n] : p.reelsVideoUrl };
  stmts.push({ sql: "UPDATE publication_queue SET payload=? WHERE id=? AND status='pending'", args: [JSON.stringify(next), x.id] });
  if (!apply && stmts.length <= 2) console.log(x.id, x.scheduled_at, "\n" + caption);
}
console.log("rows to update:", stmts.length, apply ? "APPLYING" : "(dry-run)");
if (apply) { await db.batch(stmts, "write"); console.log("done"); }
