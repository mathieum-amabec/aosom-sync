import fs from "node:fs";
import { get, getAll, ACT, PIXEL } from "./_graph.mjs";
const out = {};
const t = async (k, f) => { try { out[k] = await f(); } catch (e) { out[k] = { error: e.message }; } };
await t("mature_campaign", () => get("52598252103605", { fields: "id,name,status,effective_status,objective,smart_promotion_type,advantage_state_info,daily_budget,start_time,stop_time,created_time,updated_time" }));
await t("mature_adsets", () => getAll("52598252103605/adsets", { fields: "id,name,effective_status,optimization_goal,promoted_object,targeting,daily_budget,existing_customer_budget_percentage", effective_status: ["ACTIVE","PAUSED","DELETED","ARCHIVED","CAMPAIGN_PAUSED","ADSET_PAUSED"] }));
await t("mature_ads", () => getAll("52598252103605/ads", { fields: "id,name,effective_status,creative{id,name,object_story_spec,asset_feed_spec,url_tags,product_set_id,degrees_of_freedom_spec}", effective_status: ["ACTIVE","PAUSED","DELETED","ARCHIVED","CAMPAIGN_PAUSED","ADSET_PAUSED","WITH_ISSUES","DISAPPROVED"] }));
await t("mature_ins", () => get("52598252103605/insights", { fields: "spend,impressions,inline_link_clicks,actions,action_values,purchase_roas", date_preset: "maximum" }));
for (const ps of ["1047669454987259", "1655795612624222", "2891699814486850", "1472050881439564"])
  await t(`ps_${ps}`, () => get(ps, { fields: "id,name,filter,product_count,product_catalog{id,name}" }));
await t("pixel", () => get(PIXEL, { fields: "id,name,last_fired_time,is_unavailable,data_use_setting" }));
await t("pixel_stats", () => get(`${PIXEL}/stats`, { aggregation: "event", start_time: String(Math.floor(Date.now()/1000) - 7*86400) }));
await t("account", () => get(ACT, { fields: "name,currency,timezone_name,account_status,amount_spent,spend_cap,existing_customers" }));
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
console.log("ok");
