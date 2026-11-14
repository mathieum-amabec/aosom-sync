// READ-ONLY: full dump of campaigns / ad sets / ads + insights, using account-level
// edges (few calls, to stay under the ad-account rate limit). Writes JSON to argv[2].
import fs from "node:fs";
import { getAll, ACT, V } from "./_graph.mjs";

const out = process.argv[2];
const CAMP_F = "id,name,status,effective_status,configured_status,objective,buying_type,special_ad_categories,daily_budget,lifetime_budget,budget_remaining,bid_strategy,start_time,stop_time,created_time,updated_time,smart_promotion_type,advantage_state_info,is_budget_schedule_enabled,promoted_object,pacing_type";
const ADSET_F = "id,name,campaign_id,status,effective_status,configured_status,optimization_goal,billing_event,bid_strategy,bid_amount,daily_budget,lifetime_budget,start_time,end_time,created_time,updated_time,targeting,promoted_object,destination_type,attribution_spec,learning_stage_info,existing_customer_budget_percentage,is_dynamic_creative,targeting_optimization_types";
const AD_F = "id,name,adset_id,campaign_id,status,effective_status,configured_status,created_time,updated_time,tracking_specs,conversion_domain,creative{id,name,object_story_spec,asset_feed_spec,url_tags,product_set_id,template_url_spec,object_type,call_to_action_type,body,title,link_url,effective_object_story_id,degrees_of_freedom_spec}";
const INS_F = "campaign_id,campaign_name,adset_id,adset_name,spend,impressions,clicks,inline_link_clicks,actions,action_values,purchase_roas,cpm,ctr";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const campaigns = await getAll(`${ACT}/campaigns`, { fields: CAMP_F }); await sleep(2000);
const adsets = await getAll(`${ACT}/adsets`, { fields: ADSET_F }); await sleep(2000);
const ads = await getAll(`${ACT}/ads`, { fields: AD_F }); await sleep(2000);
const outObj = { fetched_at: new Date().toISOString(), api: V, account: ACT, campaigns, adsets, ads, insights: {} };
fs.writeFileSync(out, JSON.stringify(outObj, null, 2));
console.log(`config saved: ${campaigns.length} campaigns, ${adsets.length} adsets, ${ads.length} ads`);
const insights = outObj.insights;
for (const level of ["campaign", "adset"]) for (const preset of ["last_7d", "last_30d"]) {
  try { insights[`${level}_${preset}`] = await getAll(`${ACT}/insights`, { fields: INS_F, level, date_preset: preset, limit: "25" }); }
  catch (e) { insights[`${level}_${preset}`] = { error: e.message }; console.error(e.message); }
  await sleep(2000);
}
fs.writeFileSync(out, JSON.stringify(outObj, null, 2));
console.log(`${campaigns.length} campaigns, ${adsets.length} adsets, ${ads.length} ads -> ${out}`);
