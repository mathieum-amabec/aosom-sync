// OWNER-ONLY launch of the Advantage+ Ventes Québec FR campaign built on 2026-11-04.
// Nobody but the owner runs this with --apply: it turns spend ON.
//
//   node scripts/meta-rework/launch.mjs            # dry-run: shows what would change
//   node scripts/meta-rework/launch.mjs --apply    # activates the new campaign, pauses the old one
//   node scripts/meta-rework/launch.mjs --apply --without-vendredi-fou   # evergreen ad only
//
// Order: activate ad(s) -> ad set -> campaign (so nothing half-live), THEN pause the old
// "Advantage+ Ventes — Canada FR — 2026-10" so the store is never without an ad.
// After launch: no budget/targeting/creative edits for 7 days (learning).
import { get, post } from "./_graph.mjs";

const APPLY = process.argv.includes("--apply");
const NO_BF = process.argv.includes("--without-vendredi-fou");
const NEW = { campaign: "52607877306205", adset: "52607877312205", ad_evergreen: "52607877328405", ad_vendredi_fou: "52607877334605" };
const OLD_CAMPAIGN = "52604026014005";

const activate = [NEW.ad_evergreen, ...(NO_BF ? [] : [NEW.ad_vendredi_fou]), NEW.adset, NEW.campaign];
for (const id of activate) {
  const o = await get(id, { fields: "name,status,effective_status" });
  console.log(`${APPLY ? "ACTIVATE" : "would activate"} ${id} ${o.name} (now ${o.status})`);
  if (APPLY) await post(id, { status: "ACTIVE" });
}
const old = await get(OLD_CAMPAIGN, { fields: "name,status" });
console.log(`${APPLY ? "PAUSE" : "would pause"} ${OLD_CAMPAIGN} ${old.name} (now ${old.status})`);
if (APPLY) await post(OLD_CAMPAIGN, { status: "PAUSED" });
if (!APPLY) console.log("\nDry-run only. Re-run with --apply to launch.");
