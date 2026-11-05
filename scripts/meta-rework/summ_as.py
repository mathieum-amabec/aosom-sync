import json,sys
sys.stdout.reconfigure(encoding='utf-8')
d=json.load(open(sys.argv[1],encoding='utf8'))
ids=set(sys.argv[2].split(','))
v=d['insights'].get('adset_last_7d'); ins={i['adset_id']:i for i in v} if isinstance(v,list) else {}
for s in d['adsets']:
    if s['campaign_id'] not in ids: continue
    t=s.get('targeting',{})
    print(f"\n== AS {s['id']} {s['name']} [{s['effective_status']}] camp={s['campaign_id']}")
    print(f"   opt={s.get('optimization_goal')} bill={s.get('billing_event')} bid={s.get('bid_strategy')} db={s.get('daily_budget')} lb={s.get('lifetime_budget')} start={s.get('start_time')} end={s.get('end_time')} ecbp={s.get('existing_customer_budget_percentage')}")
    print(f"   promoted={s.get('promoted_object')} dest={s.get('destination_type')} learning={s.get('learning_stage_info',{}).get('status')}")
    print(f"   geo={t.get('geo_locations')} excl={t.get('excluded_geo_locations')} age={t.get('age_min')}-{t.get('age_max')} locales={t.get('locales')} auto={t.get('targeting_automation')} plat={t.get('publisher_platforms')} ca={[c.get('name') for c in t.get('custom_audiences',[])]}")
    print(f"   7d spend={ins.get(s['id'],{}).get('spend')}")
    for a in d['ads']:
        if a['adset_id']!=s['id']: continue
        cr=a.get('creative',{}); oss=cr.get('object_story_spec',{})
        link=(oss.get('link_data') or {}).get('link') or (oss.get('template_data') or {}).get('link') or (oss.get('video_data') or {}).get('call_to_action',{}).get('value',{}).get('link')
        afs=cr.get('asset_feed_spec')
        print(f"   - AD {a['id']} {a['name']} [{a['effective_status']}] cr={cr.get('id')} ps={cr.get('product_set_id')} type={cr.get('object_type')} link={link} afs_links={[l.get('website_url') for l in (afs or {}).get('link_urls',[])] if afs else None} url_tags={cr.get('url_tags')}")
