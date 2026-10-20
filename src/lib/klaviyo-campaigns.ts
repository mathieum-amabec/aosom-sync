/**
 * Klaviyo campaign plumbing shared by the two relays that stand in for the account's dead flows
 * (relance-paiement.ts: abandoned-checkout reminder #1; flow-relay.ts: every other flow step).
 *
 * Pattern: one-shot list → wait until Klaviyo indexes its members (a campaign sent the instant the
 * list is filled is cancelled "No Recipients") → campaign with Smart Sending OFF (otherwise a wheel
 * code or a reminder is silently dropped when the person got any email in the last 16 h, while the
 * campaign still reads "Sent").
 */
import { env } from "./config";
import { getSetting, setSetting } from "./database";

const BASE = "https://a.klaviyo.com/api";
const REVISION = "2024-10-15";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const RECEIVED_EMAIL_METRIC = "SCXLAK";
/** Both relays share this lease so two invocations never send the same batch twice. */
export const RELAY_LEASE_KEY = "klaviyo_relay_lease";
export const RELAY_LEASE_TTL_S = 330;

export async function kv<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const key = env.klaviyoApiKey;
  if (!key) throw new Error("KLAVIYO_API_KEY manquant");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers: { Authorization: `Klaviyo-API-Key ${key}`, revision: REVISION, accept: "application/vnd.api+json", "content-type": "application/vnd.api+json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 5) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 1500 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Klaviyo ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
}

export type RawEvent = { id: string; attributes: { datetime: string; event_properties: Record<string, unknown> }; relationships?: { profile?: { data?: { id: string } } } };

/** All events of a metric since `sinceIso`, with each profile's email. */
export async function metricEvents(metricId: string, sinceIso: string): Promise<{ events: RawEvent[]; emails: Map<string, string> }> {
  const events: RawEvent[] = [];
  const emails = new Map<string, string>();
  let path: string | null = `/events/?filter=${encodeURIComponent(`and(equals(metric_id,"${metricId}"),greater-than(datetime,${sinceIso}))`)}&sort=-datetime&include=profile&fields[profile]=email&page[size]=100`;
  while (path) {
    const j: { data: RawEvent[]; included?: Array<{ id: string; attributes: { email?: string } }>; links?: { next?: string } } = await kv("GET", path);
    events.push(...j.data);
    for (const p of j.included ?? []) if (p.attributes.email) emails.set(p.id, p.attributes.email);
    path = j.links?.next ? j.links.next.replace(BASE, "") : null;
  }
  return { events, emails };
}

const SENDING_CACHE_KEY = "klaviyo_flows_sending_cache";
/**
 * Flow ids that delivered an email by themselves in the last 3 days (Klaviyo fixed) → stop relaying
 * them. Flow sends carry `$flow` on "Received Email"; campaign sends carry `$campaign` instead.
 * Cached 1 h (the scan pages through every email sent); on any error: no guard, never a crash.
 */
export async function flowsSendingAgain(now: Date): Promise<Set<string>> {
  try {
    const cached = JSON.parse((await getSetting(SENDING_CACHE_KEY)) ?? "null") as { at: string; flows: string[] } | null;
    if (cached && now.getTime() - Date.parse(cached.at) < 3600e3) return new Set(cached.flows);
    const since = new Date(now.getTime() - 3 * 24 * 3600e3).toISOString().slice(0, 19);
    const { events } = await metricEvents(RECEIVED_EMAIL_METRIC, since);
    const flows = [...new Set(events.map((e) => {
      const p = e.attributes.event_properties ?? {};
      // a flow send without a $flow id still proves Klaviyo flows work again → "*" stops every relay
      return String(p.$flow ?? (p["Message Type"] === "flow" ? "*" : ""));
    }).filter(Boolean))];
    await setSetting(SENDING_CACHE_KEY, JSON.stringify({ at: now.toISOString(), flows }));
    return new Set(flows);
  } catch (err) {
    console.error("[klaviyo] flowsSendingAgain failed — relaying anyway:", err);
    return new Set();
  }
}

export async function createList(name: string, profileIds: string[]): Promise<string> {
  const list = await kv<{ data: { id: string } }>("POST", "/lists/", { data: { type: "list", attributes: { name } } });
  for (let i = 0; i < profileIds.length; i += 100) {
    await kv("POST", `/lists/${list.data.id}/relationships/profiles/`, { data: profileIds.slice(i, i + 100).map((id) => ({ type: "profile", id })) });
  }
  return list.data.id;
}

/** Wait until every list shows its members, then 45 s more for Klaviyo's audience index. */
export async function waitForLists(lists: Array<{ id: string; size: number }>): Promise<void> {
  for (let i = 0; i < 8; i++) {
    let ready = true;
    for (const l of lists) {
      const m = await kv<{ data: unknown[] }>("GET", `/lists/${l.id}/profiles/?page[size]=100`);
      if (m.data.length < Math.min(100, l.size)) ready = false;
    }
    if (ready) break;
    await sleep(5000);
  }
  await sleep(45_000);
}

export async function sendCampaign(o: { name: string; listId: string; templateId: string; subject: string; preview: string; label: string }): Promise<{ campaignId: string; messageId: string }> {
  const camp = await kv<{ data: { id: string; relationships: { "campaign-messages": { data: Array<{ id: string }> } } } }>("POST", "/campaigns/", { data: { type: "campaign", attributes: {
    name: o.name,
    audiences: { included: [o.listId], excluded: [] },
    send_strategy: { method: "immediate" },
    send_options: { use_smart_sending: false },
    "campaign-messages": { data: [{ type: "campaign-message", attributes: { channel: "email", label: o.label, content: {
      subject: o.subject, preview_text: o.preview, from_email: "info@ameublodirect.ca", from_label: "Ameublo Direct", reply_to_email: "info@ameublodirect.ca" } } }] },
  } } });
  const messageId = camp.data.relationships["campaign-messages"].data[0].id;
  await kv("POST", "/campaign-message-assign-template/", { data: { type: "campaign-message", id: messageId, relationships: { template: { data: { type: "template", id: o.templateId } } } } });
  await kv("POST", "/campaign-send-jobs/", { data: { type: "campaign-send-job", id: camp.data.id } });
  return { campaignId: camp.data.id, messageId };
}

/**
 * Render a template for one recipient before sending: Klaviyo accepts a campaign whose template
 * has a syntax error, reports it "Sent", and skips every recipient. Throws on a 400.
 */
export async function assertRenders(templateId: string, person: Record<string, unknown>): Promise<void> {
  await kv("POST", "/template-render/", { data: { type: "template", id: templateId, attributes: { context: { person } } } });
}

const SKIPPED_SEND_METRIC = "RwbbTL";
/** Recipients Klaviyo skipped for a campaign (Received Email never comes for them), by reason. */
export async function skippedFor(campaignId: string, sinceIso: string): Promise<Record<string, number>> {
  const { events } = await metricEvents(SKIPPED_SEND_METRIC, sinceIso);
  const out: Record<string, number> = {};
  for (const e of events) {
    const p = e.attributes.event_properties ?? {};
    if (p.$message !== campaignId) continue;
    const r = String(p.recipient_status ?? p.recipient_status_label ?? "unknown");
    out[r] = (out[r] ?? 0) + 1;
  }
  return out;
}

export async function campaignStatus(id: string): Promise<string> {
  const c = await kv<{ data: { attributes: { status: string } } }>("GET", `/campaigns/${id}/`);
  return c.data.attributes.status;
}

/** Only Klaviyo's own "No Recipients" cancellation is retried — never a campaign an operator cancelled. */
export const shouldRetry = (status: string) => /(no|without) recipients/i.test(status);
export const stillInFlight = (status: string) => /queued|scheduled|sending|adding|preparing|draft/i.test(status);

/** Delete the one-shot lists of both relays once their campaign is old. */
export async function cleanupLists(olderThanH: number, now: Date): Promise<number> {
  const lists: Array<{ id: string; attributes: { name: string; created: string } }> = [];
  let path: string | null = "/lists/?fields[list]=name,created";
  while (path) {
    const j: { data: typeof lists; links?: { next?: string } } = await kv("GET", path);
    lists.push(...j.data);
    path = j.links?.next ? j.links.next.replace(BASE, "") : null;
  }
  let n = 0;
  for (const l of lists) {
    if (!/^(Relais flow|Relance paiement auto) /.test(l.attributes.name)) continue;
    if (now.getTime() - Date.parse(l.attributes.created) < olderThanH * 3600e3) continue;
    await kv("DELETE", `/lists/${l.id}/`);
    n++;
  }
  return n;
}
