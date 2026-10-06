// Attach the Facebook id to Reels published BEFORE the publisher started recording them (queue_post_ids), so their insights can
// be read too. Matches each published queue row to a Reel on the brand's Page by publication time (the Reel is created a few
// minutes before the row is marked published, because the publisher also waits for Instagram).
//
//   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/backfill-reel-post-ids.mts          # dry run
//   …                                                              scripts/backfill-reel-post-ids.mts --apply  # record the matches
//
// Read-only toward Facebook (lists the Page's Reels). With --apply it only INSERTS rows into queue_post_ids (never overwrites one
// that already exists). A match is made only when exactly one unused Reel of the right Page falls in the window; anything
// ambiguous is left for a human and listed.
const interop = <T,>(m: T): T => ((m as { default?: T }).default ?? m);
const db = interop(await import("@/lib/database"));
const fb = interop(await import("@/lib/facebook-client"));
const cfg = interop(await import("@/lib/config"));
const apply = process.argv.includes("--apply");
const h = await db.ensureSchema();

const DAYS = 45;
const BEFORE_MS = 10 * 60_000; // the Reel was created up to 10 min before the row was marked published
const AFTER_MS = 90_000; // …or, rarely, right after (clock skew)

type Row = { id: number; contentType: string; brand: "ameublo" | "furnish"; publishedAt: number };
const rows: Row[] = ((await h.execute(`SELECT q.id, q.content_type, q.payload, q.published_at FROM publication_queue q
    LEFT JOIN queue_post_ids p ON p.queue_id = q.id
   WHERE q.status = 'published' AND q.platform IN ('facebook','both') AND p.queue_id IS NULL
     AND q.content_type IN ('sequential_ad','video','assembly','demand_gen_ext') AND q.published_at >= datetime('now', '-${DAYS} days')
   ORDER BY q.published_at`)).rows as unknown as { id: number; content_type: string; payload: string; published_at: string }[])
  .map((r) => {
    let brand: "ameublo" | "furnish" = "ameublo"; // batch payloads carry no brand: they always go to Ameublo
    try { const b = JSON.parse(r.payload).brand; if (b === "furnish") brand = "furnish"; } catch { /* keep default */ }
    return { id: Number(r.id), contentType: String(r.content_type), brand, publishedAt: Date.parse(`${String(r.published_at).replace(" ", "T")}Z`) };
  });
console.log(`${rows.length} Reels publiés sans identifiant Facebook enregistré (${DAYS} derniers jours)\n`);

const reelsOf = async (brand: "ameublo" | "furnish") => {
  const { pageId, token } = fb.facebookBrandCreds(brand);
  const out: { id: string; created: number; description: string }[] = [];
  let url: string | null = `${cfg.FACEBOOK.GRAPH_API_URL}/${pageId}/video_reels?fields=id,created_time,description&limit=100`;
  for (let page = 0; url && page < 6; page++) {
    const res: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const j = (await res.json()) as { data?: { id: string; created_time: string; description?: string }[]; paging?: { next?: string }; error?: { message: string } };
    if (j.error) throw new Error(`Facebook ${brand}: ${j.error.message}`);
    for (const r of j.data ?? []) out.push({ id: r.id, created: Date.parse(r.created_time), description: r.description ?? "" });
    url = j.paging?.next ?? null;
  }
  return out;
};

let matched = 0;
const unmatched: string[] = [];
for (const brand of ["ameublo", "furnish"] as const) {
  const mine = rows.filter((r) => r.brand === brand);
  if (!mine.length) continue;
  const reels = await reelsOf(brand);
  console.log(`— ${brand}: ${mine.length} lignes, ${reels.length} Reels sur la Page`);
  const used = new Set<string>();
  for (const r of mine) {
    const cands = reels.filter((x) => !used.has(x.id) && x.created >= r.publishedAt - BEFORE_MS && x.created <= r.publishedAt + AFTER_MS);
    if (cands.length !== 1) {
      unmatched.push(`#${r.id} ${r.contentType} (${new Date(r.publishedAt).toISOString().slice(0, 16)}Z) : ${cands.length === 0 ? "aucun Reel dans la fenêtre" : `${cands.length} Reels possibles — ambigu`}`);
      continue;
    }
    used.add(cands[0].id);
    matched++;
    console.log(`  ✓ #${r.id} ${r.contentType.padEnd(14)} → ${cands[0].id}  « ${cands[0].description.replace(/\s+/g, " ").slice(0, 50)} »`);
    if (apply) await db.recordQueuePostIds(r.id, { fb: cands[0].id });
  }
}
console.log(`\n${matched} rattachés${apply ? " et enregistrés" : " (essai à blanc — rien d'enregistré)"}, ${unmatched.length} laissés de côté :`);
for (const u of unmatched) console.log("  ✗ " + u);
