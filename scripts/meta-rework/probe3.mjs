import fs from "node:fs";
import { get, getAll, ACT } from "./_graph.mjs";
const out = {};
const t = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = { error: e.message }; } };
await t("ad_ins", () => getAll(`52598252103605/insights`, { level: "ad", fields: "ad_id,ad_name,adset_id,adset_name,spend,actions,purchase_roas", time_range: { since: "2026-09-13", until: "2026-10-16" } }));
const ids = Array.isArray(out.ad_ins) ? [...new Set(out.ad_ins.map((r) => r.ad_id))] : [];
out.ads = {};
for (const id of ids) { try { out.ads[id] = await get(id, { fields: "id,name,status,adset{id,name,targeting,promoted_object,optimization_goal,existing_customer_budget_percentage},creative{id,name,object_story_spec,asset_feed_spec,url_tags,product_set_id,degrees_of_freedom_spec,object_type}" }); } catch (e) { out.ads[id] = { error: e.message }; } }
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
console.log("ads", ids.length);
