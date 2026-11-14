import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createClient } from "@libsql/client";
import { put } from "@vercel/blob";
const ROOT = path.dirname(fileURLToPath(import.meta.url)).split(path.sep).join("/");
const urls = JSON.parse(readFileSync(`${ROOT}/out/urls.json`, "utf8"));
const set = [
  { n: "V14", day: 21, fr: "⏳ Plus que 2 jours pour commander ta déco d'Halloween! Les commandes passées d'ici le 23 octobre arrivent à temps pour l'Halloween. Livraison gratuite partout au Canada.\nhttps://ameublodirect.ca\n\n#halloween #decorationhalloween #ameublodirect", en: "⏳ Only 2 days left to order your Halloween decor! Orders placed by October 23 arrive in time for Halloween. Free shipping across Canada.\nhttps://furnishdirect.ca\n\n#halloween #halloweendecor #furnishdirect" },
  { n: "V15", day: 22, fr: "🎃 Demain, c'est la dernière chance! Commande ta déco d'Halloween d'ici le 23 octobre pour la recevoir à temps. Livraison gratuite partout au Canada.\nhttps://ameublodirect.ca\n\n#halloween #decorationhalloween #ameublodirect", en: "🎃 Tomorrow is the last chance! Order your Halloween decor by October 23 to get it in time. Free shipping across Canada.\nhttps://furnishdirect.ca\n\n#halloween #halloweendecor #furnishdirect" },
  { n: "V16", day: 23, fr: "👻 Dernier jour pour commander! Passe ta commande de déco d'Halloween aujourd'hui, 23 octobre, pour la recevoir à temps. Livraison gratuite partout au Canada.\nhttps://ameublodirect.ca\n\n#halloween #decorationhalloween #ameublodirect", en: "👻 Last day to order! Place your Halloween decor order today, October 23, to get it in time. Free shipping across Canada.\nhttps://furnishdirect.ca\n\n#halloween #halloweendecor #furnishdirect" },
];
for (const s of set) if (!urls[s.n]) {
  const r = await put(`ameublo-studio/halloween-real/${s.n}.mp4`, readFileSync(`${ROOT}/out/halloween-${s.n}.mp4`), { access: "public", contentType: "video/mp4", addRandomSuffix: true });
  urls[s.n] = r.url; writeFileSync(`${ROOT}/out/urls.json`, JSON.stringify(urls, null, 1)); console.log(s.n, r.url);
}
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const stmts = [];
for (const s of set) for (const [brand, minute, cap] of [["ameublo", "10:00:00", s.fr], ["furnish", "10:05:00", s.en]]) {
  const at = `2026-10-${s.day} ${minute}`;
  const ex = await db.execute({ sql: "SELECT id FROM publication_queue WHERE platform='both' AND scheduled_at=? AND status IN ('pending','publishing','published')", args: [at] });
  if (ex.rows.length) { console.log("SLOT TAKEN", at, ex.rows[0].id); continue; }
  stmts.push({ sql: `INSERT INTO publication_queue (content_type, content_id, platform, payload, scheduled_at, status, metadata) VALUES ('sequential_ad', ?, 'both', ?, ?, 'pending', ?)`,
    args: [`halloween-real:${s.n}:${brand}`, JSON.stringify({ caption: cap, brand, reelsVideoUrl: urls[s.n] }), at, JSON.stringify({ source: "halloween_real", keepCaption: true, style: "real", lang: "bilingual", series: "Halloween réel (sans mascotte)", campaign: "halloween-2026", skus: [], renderedPrices: {} })] });
}
await db.batch(stmts, "write"); console.log("enqueued", stmts.length);
