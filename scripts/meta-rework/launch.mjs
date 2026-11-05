// OWNER-ONLY launch of the Advantage+ Ventes Québec FR campaign built on 2026-11-04.
// Nobody but the owner runs this with --apply: it turns spend ON.
//
//   node scripts/meta-rework/launch.mjs                        # dry-run: shows what would change
//   node scripts/meta-rework/launch.mjs --apply                # launch (Vendredi fou ad only from Nov 6)
//   node scripts/meta-rework/launch.mjs --apply --without-vendredi-fou   # evergreen ad only
//   node scripts/meta-rework/launch.mjs --apply --force-vendredi-fou     # Vendredi fou ad before Nov 6
//   node scripts/meta-rework/launch.mjs --pause-vendredi-fou [--apply]   # ONLY pause the Vendredi fou ad (Nov 30)
//
// Order: activate ad(s) -> ad set -> campaign (so nothing half-live), THEN pause the old
// "Advantage+ Ventes — Canada FR — 2026-10" so the store is never without an ad.
// After launch: no budget/targeting/creative edits for 7 days (learning).
import { get, post } from "./_graph.mjs";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const NO_BF = args.includes("--without-vendredi-fou");
const FORCE_BF = args.includes("--force-vendredi-fou");
const PAUSE_BF = args.includes("--pause-vendredi-fou");
const NEW = { campaign: "52607877306205", adset: "52607877312205", ad_evergreen: "52607877328405", ad_vendredi_fou: "52607877334605" };
const OLD_CAMPAIGN = "52604026014005";
// 2026-11-06 00:00 America/Toronto (EST, UTC-5) — the copy says "le Vendredi fou commence maintenant".
const BF_START = new Date("2026-11-06T05:00:00Z");
const BF_REMINDER = "RAPPEL : mettre l'annonce Vendredi fou (52607877334605) en pause le 30 nov. au soir :\n  node scripts/meta-rework/launch.mjs --pause-vendredi-fou --apply";

if (PAUSE_BF) {
  const o = await get(NEW.ad_vendredi_fou, { fields: "name,status" });
  console.log(`${APPLY ? "PAUSE" : "would pause"} ${NEW.ad_vendredi_fou} ${o.name} (now ${o.status})`);
  if (APPLY) await post(NEW.ad_vendredi_fou, { status: "PAUSED" });
  else console.log("\nDry-run only. Re-run with --apply.");
  process.exit(0);
}

const withBf = !NO_BF;
if (withBf && Date.now() < BF_START.getTime() && !FORCE_BF) {
  console.error(`REFUSED: the Vendredi fou ad cannot be activated before 2026-11-06 00:00 (America/Toronto).\n` +
    `Use --without-vendredi-fou to launch the evergreen ad only, or --force-vendredi-fou to override.`);
  process.exit(1);
}

const activate = [NEW.ad_evergreen, ...(withBf ? [NEW.ad_vendredi_fou] : []), NEW.adset, NEW.campaign];
for (const id of activate) {
  const o = await get(id, { fields: "name,status,effective_status" });
  console.log(`${APPLY ? "ACTIVATE" : "would activate"} ${id} ${o.name} (now ${o.status})`);
  if (APPLY) await post(id, { status: "ACTIVE" });
}
const old = await get(OLD_CAMPAIGN, { fields: "name,status" });
console.log(`${APPLY ? "PAUSE" : "would pause"} ${OLD_CAMPAIGN} ${old.name} (now ${old.status})`);
if (APPLY) await post(OLD_CAMPAIGN, { status: "PAUSED" });
if (withBf) console.log("\n" + BF_REMINDER);
if (!APPLY) console.log("\nDry-run only. Re-run with --apply to launch.");
