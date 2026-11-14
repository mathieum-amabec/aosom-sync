// node gallery.mjs → out/calendrier-halloween.html : one card per day (Oct 8–23) with the player, brand/time, status and the exact caption, read live from the queue.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createClient } from "@libsql/client";
const ROOT = path.dirname(fileURLToPath(import.meta.url)).split(path.sep).join("/");
mkdirSync(`${ROOT}/out`, { recursive: true });
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const r = await db.execute(`SELECT id, content_id, status, scheduled_at, payload FROM publication_queue WHERE content_id LIKE 'halloween-real:%' AND status != 'cancelled' ORDER BY scheduled_at, id`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const days = {};
for (const x of r.rows) { const p = JSON.parse(String(x.payload)); const d = String(x.scheduled_at).slice(0, 10); (days[d] ||= []).push({ ...x, p }); }
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const label = (d) => { const t = new Date(d + "T12:00:00Z"); return `${JOURS[t.getUTCDay()]} ${t.getUTCDate()} ${MOIS[t.getUTCMonth()]}`; };
const STATUS = { pending: "En attente (6 h / 6 h 05)", published: "Publiée", failed: "Échec" };
const cards = Object.entries(days).map(([d, items]) => {
  const v = items[0].p.reelsVideoUrl;
  const caps = items.map((i) => `<div class="cap"><b>${i.p.brand === "furnish" ? "Furnish Direct (EN) · 6 h 05" : "Ameublo Direct (FR) · 6 h"}</b> <span class="st">${esc(STATUS[i.status] || i.status)}</span><br>${esc(i.p.caption).replace(/\n/g, "<br>")}</div>`).join("");
  return `<section class="card"><h2>${label(d)}</h2><video src="${esc(v)}" controls preload="metadata" playsinline></video>${caps}</section>`;
}).join("\n");
writeFileSync(`${ROOT}/out/calendrier-halloween.html`, `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pubs Halloween — calendrier</title>
<style>:root{--bg:#0e0a12;--card:#1a1320;--tx:#f3eefa;--mut:#a99bbd;--or:#ff6a00}@media(prefers-color-scheme:light){:root{--bg:#f6f2fa;--card:#fff;--tx:#1b1424;--mut:#6a5c7d}}
body{margin:0;padding:16px;background:var(--bg);color:var(--tx);font:15px/1.45 system-ui,sans-serif}h1{font-size:22px;margin:0 0 4px}p.sub{color:var(--mut);margin:0 0 16px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}.card{background:var(--card);border-radius:12px;padding:12px}.card h2{font-size:16px;margin:0 0 8px;color:var(--or);text-transform:capitalize}
video{width:100%;aspect-ratio:9/16;background:#000;border-radius:8px}.cap{font-size:13px;margin-top:8px;color:var(--mut)}.cap b{color:var(--tx)}.st{float:right;font-size:12px}</style></head><body>
<h1>Pubs Halloween — du 8 au 23 octobre</h1><p class="sub">${Object.keys(days).length} jours · une vidéo par jour, publiée sur Ameublo (6 h) et Furnish (6 h 05). Date limite promise: 23 octobre.</p>
<div class="grid">${cards}</div></body></html>`);
console.log("days:", Object.keys(days).length, "rows:", r.rows.length);
