// Read-only preview of "La semaine Ameublo": builds each day's post from LIVE data (Turso + Shopify
// reads, LLM captions) and prints it. Queues and writes nothing.
// Usage: node-x64 --env-file=.env.local --import tsx scripts/semaine-preview.mts [mon|tue|...|all] [morning|afternoon]
const interop = <T,>(m: T): T => ((m as { default?: T }).default ?? m);
const { runSemaine } = interop(await import("../src/lib/semaine/run")) as typeof import("../src/lib/semaine/run");

// Next occurrence of each weekday (Toronto noon-ish UTC) so the 10:00/15:00 slots are in the future.
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const arg = (process.argv[2] ?? "all").toLowerCase();
const slots = (process.argv[3] ? [process.argv[3]] : ["morning", "afternoon"]) as Array<"morning" | "afternoon">;
const want = arg === "all" ? DAYS.slice(1).concat(DAYS[0]) : [arg];

function nextDate(wd: number): Date {
  const d = new Date();
  d.setUTCHours(11, 0, 0, 0);
  while (d.getUTCDay() !== wd || d.getTime() < Date.now() + 3 * 3600_000) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

for (const name of want) {
  const wd = DAYS.indexOf(name);
  if (wd < 0) throw new Error(`unknown day ${name}`);
  for (const slot of slots) {
    const now = nextDate(wd);
    const t0 = Date.now();
    const r = await runSemaine({ slot, now, dryRun: true });
    console.log(`\n══ ${name.toUpperCase()} ${slot} — ${r.status}${r.format ? ` · ${r.format}` : ""}${r.reason ? ` · ${r.reason}` : ""} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    if (r.captions) {
      console.log(`photos: ${r.imageUrls?.length} · skus: ${r.skus?.join(", ")} · slot ${r.scheduledAt} UTC`);
      console.log("── FR ──\n" + r.captions.fr + "\n── EN ──\n" + r.captions.en);
    }
  }
}
