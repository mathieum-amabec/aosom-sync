// node publish.mjs upload            → uploads out/halloween-V01..V13.mp4 to the PUBLIC blob store, writes out/urls.json
// node publish.mjs queue [--apply]   → cancels mascot rows + enqueues 13 days x 2 brands at 06:00/06:05 Montréal (dry-run unless --apply)
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createClient } from "@libsql/client";
import { put } from "@vercel/blob";

const ROOT = path.dirname(fileURLToPath(import.meta.url)).split(path.sep).join("/");
const mode = process.argv[2];
const apply = process.argv.includes("--apply");
const names = Array.from({ length: 13 }, (_, i) => "V" + String(i + 1).padStart(2, "0"));

if (mode === "upload") {
  const urls = existsSync(`${ROOT}/out/urls.json`) ? JSON.parse(readFileSync(`${ROOT}/out/urls.json`, "utf8")) : {};
  for (const n of names) {
    if (urls[n]) continue;
    const buf = readFileSync(`${ROOT}/out/halloween-${n}.mp4`);
    const r = await put(`ameublo-studio/halloween-real/${n}.mp4`, buf, { access: "public", contentType: "video/mp4", addRandomSuffix: true });
    urls[n] = r.url;
    writeFileSync(`${ROOT}/out/urls.json`, JSON.stringify(urls, null, 1));
    console.log(n, r.url);
  }
}

if (mode === "queue") {
  const urls = JSON.parse(readFileSync(`${ROOT}/out/urls.json`, "utf8"));
  const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  const FR = [
    "🎃 Une déco d'Halloween qui fait vraiment peur! Commandez d'ici le 23 octobre pour la recevoir à temps pour l'Halloween. Livraison gratuite partout au Canada.\nhttps://ameublodirect.ca\n\n#halloween #decorationhalloween #ameublodirect",
    "👻 Ton entrée va faire jaser tout le quartier. Les commandes passées d'ici le 23 octobre arrivent à temps pour l'Halloween. Livraison gratuite partout au Canada.\nhttps://ameublodirect.ca\n\n#halloween #decorationhalloween #ameublodirect",
    "🕷️ Frissons garantis! Tu as jusqu'au 23 octobre pour commander et recevoir ta décoration d'Halloween à temps. Livraison gratuite partout au Canada.\nhttps://ameublodirect.ca\n\n#halloween #decorationhalloween #ameublodirect",
  ];
  const EN = [
    "🎃 Halloween decor that actually scares. Order by October 23 to get it in time for Halloween. Free shipping across Canada.\nhttps://furnishdirect.ca\n\n#halloween #halloweendecor #furnishdirect",
    "👻 Make your front yard the talk of the street. Orders placed by October 23 arrive in time for Halloween. Free shipping across Canada.\nhttps://furnishdirect.ca\n\n#halloween #halloweendecor #furnishdirect",
    "🕷️ Chills guaranteed! You have until October 23 to order and get your Halloween decor on time. Free shipping across Canada.\nhttps://furnishdirect.ca\n\n#halloween #halloweendecor #furnishdirect",
  ];
  const stmts = [];
  // 1) cancel every pending/draft Studio video that carries the mascot (Halloween series + Montage + Pub Costway + sequential character styles)
  const mascot = await db.execute(`SELECT id, content_id, status, scheduled_at, metadata FROM publication_queue
    WHERE status IN ('pending','draft') AND metadata LIKE '%ameublo_studio%' AND metadata NOT LIKE '%"style":"emotion"%'
      AND scheduled_at >= datetime('now','-1 day')`);
  console.log("mascot rows to cancel:", mascot.rows.length);
  for (const x of mascot.rows) console.log("  cancel", x.id, x.status, x.scheduled_at, x.content_id, (JSON.parse(x.metadata).series || ""));
  for (const x of mascot.rows) stmts.push({ sql: `UPDATE publication_queue SET status='cancelled' WHERE id=? AND status IN ('pending','draft')`, args: [x.id] });
  // 2) enqueue
  const plan = [];
  names.forEach((n, i) => {
    const day = 8 + i; // Oct 8 .. Oct 20
    for (const [brand, minute, cap] of [["ameublo", "10:00:00", FR[i % 3]], ["furnish", "10:05:00", EN[i % 3]]]) {
      const at = `2026-10-${String(day).padStart(2, "0")} ${minute}`;
      plan.push({ n, brand, at });
      stmts.push({
        sql: `INSERT INTO publication_queue (content_type, content_id, platform, payload, scheduled_at, status, metadata) VALUES ('sequential_ad', ?, 'both', ?, ?, 'pending', ?)`,
        args: [`halloween-real:${n}:${brand}`, JSON.stringify({ caption: cap, brand, reelsVideoUrl: urls[n] }), at,
          JSON.stringify({ source: "halloween_real", keepCaption: true, style: "real", lang: "bilingual", series: "Halloween réel (sans mascotte)", campaign: "halloween-2026", skus: [], renderedPrices: {} })],
      });
    }
  });
  for (const p of plan) console.log("  enqueue", p.at, p.brand, p.n);
  console.log("statements:", stmts.length, apply ? "APPLYING" : "(dry-run, pass --apply)");
  if (apply) { await db.batch(stmts, "write"); console.log("done"); }
}
