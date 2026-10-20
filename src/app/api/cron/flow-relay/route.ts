import { verifyCronSecret } from "@/lib/cron-auth";
import { NextResponse } from "next/server";
import { trackCron } from "@/lib/cron-tracking";
import { acquireLease, getSetting, releaseLease, setSetting } from "@/lib/database";
import { STATE_KEY as RELANCE_STATE_KEY } from "@/lib/relance-paiement";
import {
  RELAY_LEASE_KEY, RELAY_LEASE_TTL_S, assertRenders, campaignStatus, cleanupLists, createList, flowsSendingAgain, kv,
  sendCampaign, shouldRetry, skippedFor, stillInFlight, waitForLists,
} from "@/lib/klaviyo-campaigns";
import {
  PLACED_ORDER, STEPS, WHEEL_WON, emptyRelayState, eventContext, propKey, pruneRelayState, rewriteBody, rewriteLine,
  selectDue, triggerEvents, usesEvent, type RelayState, type RelayStep, type TriggerEvent,
} from "@/lib/flow-relay";

/**
 * GET /api/cron/flow-relay — every 15 min (:07/:22/:37/:52, off relance-paiement's minutes).
 * Sends the emails of the Klaviyo flows (welcome, review request, wheel codes, price drop,
 * abandoned checkout #2, morning report) through campaigns, because the account's flows never
 * send. See src/lib/flow-relay.ts.
 *
 * No double send: a lease shared with relance-paiement, and the state saved right after each
 * campaign. Budget: no new step after BUDGET_MS, at most MAX_PER_STEP recipients per step per run.
 * `?dryRun=1` lists what would go out and sends nothing. Kill switch: `flow_relay_enabled` = "0".
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const STATE_KEY = "flow_relay_state";
const ENABLED_KEY = "flow_relay_enabled";
const TEMPLATES_KEY = "flow_relay_templates";
const BUDGET_MS = 170_000;
const MAX_PER_STEP = 150;

export async function GET(request: Request) {
  if (!verifyCronSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";
  if (!dryRun && (await getSetting(ENABLED_KEY)) === "0") return NextResponse.json({ success: true, skipped: "disabled" });
  const lease = dryRun ? "dry" : await acquireLease(RELAY_LEASE_KEY, RELAY_LEASE_TTL_S);
  if (!lease) return NextResponse.json({ success: true, skipped: "another-relay-running" });
  try {
    return await trackCron("flow-relay", () => run(dryRun));
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  } finally {
    if (!dryRun) await releaseLease(RELAY_LEASE_KEY, lease).catch(() => {});
  }
}

async function run(dryRun: boolean) {
  const started = Date.now();
  const now = new Date();
  const iso = (min: number) => new Date(now.getTime() - min * 60e3).toISOString().slice(0, 19);
  let state: RelayState = emptyRelayState();
  try { const raw = await getSetting(STATE_KEY); if (raw) state = { ...emptyRelayState(), ...(JSON.parse(raw) as RelayState) }; } catch { /* corrupt → fresh */ }
  state = pruneRelayState(state, now);
  const save = () => setSetting(STATE_KEY, JSON.stringify(state));

  // 1. campaigns of earlier runs: "No Recipients" → retry; recipients skipped (template error…) → record, no retry
  if (!dryRun && state.pending.length) {
    const keep: RelayState["pending"] = [];
    for (const p of state.pending) {
      const status = await campaignStatus(p.campaignId).catch(() => "unknown");
      if (shouldRetry(status)) {
        for (const id of p.eventIds) delete state.done[p.step]?.[id];
        for (const id of p.profileIds) delete state.prof[p.step]?.[id];
      } else if (stillInFlight(status) || status === "unknown") {
        keep.push(p);
      } else {
        const skipped = await skippedFor(p.campaignId, new Date(Date.parse(p.at) - 60e3).toISOString().slice(0, 19)).catch(() => ({} as Record<string, number>));
        const n = Object.values(skipped).reduce((a, b) => a + b, 0);
        if (n) state.failures.push({ step: p.step, campaignId: p.campaignId, skipped: n, reason: Object.keys(skipped).join(","), at: now.toISOString() });
      }
    }
    state.pending = keep;
    await save();
  }

  // 2. inputs
  const metrics = [...new Set(STEPS.map((s) => s.metricId))];
  const byMetric = new Map<string, TriggerEvent[]>();
  for (const m of metrics) {
    const lookback = Math.max(...STEPS.filter((s) => s.metricId === m).map((s) => s.offsetMin + s.graceMin)) + 60;
    byMetric.set(m, await triggerEvents(m, iso(lookback)));
  }
  const maxLookback = Math.max(...STEPS.map((s) => s.offsetMin + s.graceMin)) + 60;
  const orders = await triggerEvents(PLACED_ORDER, iso(maxLookback));
  const orderTimes = new Map<string, number[]>();
  for (const o of orders) orderTimes.set(o.profileId, [...(orderTimes.get(o.profileId) ?? []), Date.parse(o.at)]);
  const wheel = byMetric.get(WHEEL_WON) ?? [];
  const sendingAgain = await flowsSendingAgain(now);
  let relance: { sent?: Record<string, string> } = {};
  try { relance = JSON.parse((await getSetting(RELANCE_STATE_KEY)) ?? "{}"); } catch { /* none */ }

  const ctx = {
    now, state,
    orderedAfter: (pid: string, at: string) => (orderTimes.get(pid) ?? []).some((t) => t >= Date.parse(at) - 5 * 60e3),
    wonWheelWithin7d: (pid: string) => wheel.some((w) => w.profileId === pid && now.getTime() - Date.parse(w.at) < 7 * 24 * 3600e3),
    relancePaiementSent: (id: string) => !!relance.sent?.[id],
    flowSendingAgain: (flowId: string) => sendingAgain.has(flowId) || sendingAgain.has("*"),
  };
  const due = STEPS.map((step) => ({ step, events: selectDue(step, byMetric.get(step.metricId) ?? [], ctx).slice(0, MAX_PER_STEP) })).filter((d) => d.events.length);

  if (dryRun) {
    return NextResponse.json({ success: true, dryRun, startAt: state.startAt, flowsSendingAgain: [...sendingAgain], failures: state.failures,
      due: due.map((d) => ({ step: d.step.key, count: d.events.length, people: d.events.map((e) => e.email?.replace(/^(.).*@/, "$1***@")) })) });
  }

  // 3. per step: template (fixed + rewritten, render-checked) → profile data → list
  let cache: Record<string, string> = {};
  try { cache = JSON.parse((await getSetting(TEMPLATES_KEY)) ?? "{}"); } catch { /* recreate */ }
  const label = now.toISOString().slice(0, 16).replace("T", " ");
  const ready: Array<{ step: RelayStep; events: TriggerEvent[]; listId: string; templateId: string }> = [];
  const errors: string[] = [];
  for (const d of due) {
    if (Date.now() - started > BUDGET_MS) { errors.push(`${d.step.key}: reporté (budget de temps)`); continue; }
    try {
      const { templateId, needsEvent } = await relayTemplate(d.step, cache);
      const key = propKey(d.step);
      // check one real recipient's render before anyone gets it
      await assertRenders(templateId, needsEvent ? { [key]: eventContext(d.events[0].props) } : {});
      if (needsEvent) {
        for (const e of d.events) {
          await kv("PATCH", `/profiles/${e.profileId}/`, { data: { type: "profile", id: e.profileId, attributes: { properties: { [key]: eventContext(e.props) } } } });
        }
      }
      ready.push({ ...d, templateId, listId: await createList(`Relais flow ${d.step.key} ${label}`, [...new Set(d.events.map((e) => e.profileId))]) });
    } catch (err) {
      errors.push(`${d.step.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await setSetting(TEMPLATES_KEY, JSON.stringify(cache));
  if (ready.length) await waitForLists(ready.map((r) => ({ id: r.listId, size: new Set(r.events.map((e) => e.profileId)).size })));

  // 4. send, saving the state after EACH campaign (a timeout later must not resend it)
  const sent: Array<{ step: string; count: number; campaignId: string }> = [];
  for (const r of ready) {
    try {
      const key = propKey(r.step);
      const { campaignId, messageId } = await sendCampaign({ name: `Relais flow ${r.step.key} ${label}`, listId: r.listId, templateId: r.templateId,
        subject: rewriteLine(r.step.subject, key), preview: rewriteLine(r.step.preview, key), label: r.step.key });
      const at = now.toISOString();
      state.done[r.step.key] = { ...(state.done[r.step.key] ?? {}), ...Object.fromEntries(r.events.map((e) => [e.id, at])) };
      state.prof[r.step.key] = { ...(state.prof[r.step.key] ?? {}), ...Object.fromEntries(r.events.map((e) => [e.profileId, at])) };
      state.pending.push({ campaignId, messageId, step: r.step.key, eventIds: r.events.map((e) => e.id), profileIds: r.events.map((e) => e.profileId), at });
      await save();
      sent.push({ step: r.step.key, count: r.events.length, campaignId });
    } catch (err) {
      errors.push(`${r.step.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await save();
  const cleaned = Date.now() - started < BUDGET_MS ? await cleanupLists(72, now).catch(() => 0) : 0;
  return NextResponse.json({ success: errors.length === 0, sent, errors, failures: state.failures.slice(-5), cleanedLists: cleaned });
}

/** The campaign copy of a step's flow template; recreated (and the old copy deleted) when the source changes. */
async function relayTemplate(step: RelayStep, cache: Record<string, string>): Promise<{ templateId: string; needsEvent: boolean }> {
  const src = await kv<{ data: { attributes: { html: string; updated: string } } }>("GET", `/templates/${step.templateId}/`);
  const needsEvent = usesEvent(src.data.attributes.html, step);
  const cacheKey = `${step.key}:${step.templateId}:${src.data.attributes.updated}:v2`;
  if (cache[cacheKey]) return { templateId: cache[cacheKey], needsEvent };
  const t = await kv<{ data: { id: string } }>("POST", "/templates/", { data: { type: "template", attributes: {
    name: `Relais flow ${step.key} (${step.templateId})`, editor_type: "CODE", html: rewriteBody(src.data.attributes.html, propKey(step)) } } });
  for (const k of Object.keys(cache)) {
    if (!k.startsWith(`${step.key}:`)) continue;
    await kv("DELETE", `/templates/${cache[k]}/`).catch(() => {});
    delete cache[k];
  }
  cache[cacheKey] = t.data.id;
  return { templateId: t.data.id, needsEvent };
}
