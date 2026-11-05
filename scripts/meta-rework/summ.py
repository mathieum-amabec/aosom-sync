import json,sys
sys.stdout.reconfigure(encoding='utf-8')
d=json.load(open(sys.argv[1],encoding='utf8'))
def acts(a,t):
    for x in (a or []):
        if x['action_type']==t: return x['value']
    return '0'
def m(k): v=d['insights'].get(k); return {i.get('adset_id') or i['campaign_id']:i for i in v} if isinstance(v,list) else {}
ins7=m('campaign_last_7d'); ins30=m('campaign_last_30d')
for c in sorted(d['campaigns'],key=lambda c:c['created_time']):
    if c['created_time']<'2026-09': continue
    i7=ins7.get(c['id'],{}); i30=ins30.get(c['id'],{})
    asi=c.get('advantage_state_info',{})
    print(f"{c['id']} | {c['name']} | {c['effective_status']} | {c['objective']} | spt={c.get('smart_promotion_type')} | adv={asi} | db={c.get('daily_budget')} | start={c.get('start_time','')[:16]} stop={c.get('stop_time','')[:16]} | 7d ${i7.get('spend','-')} pur={acts(i7.get('actions'),'offsite_conversion.fb_pixel_purchase')} | 30d ${i30.get('spend','-')} pur={acts(i30.get('actions'),'offsite_conversion.fb_pixel_purchase')} atc={acts(i30.get('actions'),'offsite_conversion.fb_pixel_add_to_cart')}")
