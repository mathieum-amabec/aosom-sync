/**
 * Flow emails on our own engine: every template renders (FR/EN) with safe links, the hand-over
 * from the Klaviyo relays never lets both send the same email, consent rules, and one full run
 * with fake Klaviyo + Resend.
 */
import { describe, it, expect, vi } from "vitest";

process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "test";

import {
  FLOWS, GROUPS, activeGroups, emptyEngineState, groupStart, idemKey, loadRelayKeysOwnedByEngine, mergeEngineIntoRelance, mergeEngineIntoRelay,
  parseEngineState, parseTakeover, pruneEngineState, relayKeysOwnedByEngine, relayView, runEmailFlows, type EngineState, type FlowRunDeps,
} from "@/lib/email/flows";
import { cartFromEvent, eventLocale, relance1, roue1, safeUrl, baissePrix } from "@/lib/email/templates";
import { sampleProps } from "@/lib/email/samples";
import { mayEmail, parseKlaviyoConsent } from "@/lib/email/consent";
import { STEPS as RELAY_STEPS, emptyRelayState, type RelayState, type TriggerEvent } from "@/lib/flow-relay";
import type { OutgoingEmail } from "@/lib/email/engine";

describe("templates", () => {
  it("every flow renders in FR and EN from its sample, with no leftover template tags", () => {
    for (const f of FLOWS) {
      for (const l of ["fr", "en"] as const) {
        const c = f.render(sampleProps(f.key, l));
        expect(c, `${f.key} ${l}`).not.toBeNull();
        expect(c!.subject.length).toBeGreaterThan(5);
        expect(c!.bodyHtml + c!.bodyText + c!.subject).not.toMatch(/\{\{|\{%|undefined|null|NaN/);
      }
    }
    expect(roue1(sampleProps("roue-1", "en"))!.subject).toBe("🎁 Your code: $15 off");
  });

  it("refuses foreign links and escapes event text", () => {
    expect(safeUrl("https://evil.example/x")).toBeNull();
    expect(safeUrl("http://ameublodirect.ca/x")).toBeNull();
    expect(safeUrl("https://ameublodirect.ca/checkouts/1")).toBe("https://ameublodirect.ca/checkouts/1");
    const props = { $extra: { checkout_url: "https://evil.example/pay", line_items: [{ title: "x", quantity: 1 }] } };
    expect(relance1(props)).toBeNull();
    const c = relance1({ $extra: { checkout_url: "https://ameublodirect.ca/c/1", line_items: [{ title: "<script>x</script>", quantity: 2, line_price: 10, product: { images: [{ src: "https://evil.example/i.jpg" }] } }] } })!;
    expect(c.bodyHtml).toContain("&lt;script&gt;");
    expect(c.bodyHtml).not.toContain("evil.example");
    expect(c.bodyHtml).toContain("2 × 10,00 $");
  });

  it("reads the locale and the cart from Shopify's checkout event", () => {
    expect(eventLocale({ "Customer Locale": "en-CA" })).toBe("en");
    expect(eventLocale({})).toBe("fr");
    const cart = cartFromEvent({ $extra: { checkout_url: "https://ameublodirect.ca/c", line_items: [{ presentment_title: "Lit", title: "Bed", quantity: "1", line_price: "99.5" }] } });
    expect(cart.items).toEqual([{ title: "Lit", quantity: 1, price: 99.5, image: null }]);
  });

  it("price drop shows the old and new price only when the price really dropped", () => {
    const up = baissePrix({ product_url: "https://ameublodirect.ca/products/x", product_name: "X", old_price: 10, new_price: 20 })!;
    expect(up.bodyHtml).not.toContain("<s ");
    expect(baissePrix({ product_url: "https://ameublodirect.ca/products/x", old_price: 20, new_price: 10 })!.bodyText).toContain("20,00 $ → 10,00 $");
  });
});

describe("hand-over from the relays", () => {
  it("every flow maps to an existing relay step and every relay step but the morning report has a flow", () => {
    const relayKeys = new Set(RELAY_STEPS.map((s) => s.key));
    for (const f of FLOWS) if (f.relayKey !== "relance-paiement") expect(relayKeys.has(f.relayKey), f.key).toBe(true);
    const covered = new Set(FLOWS.map((f) => f.relayKey));
    expect(RELAY_STEPS.filter((s) => !covered.has(s.key)).map((s) => s.key)).toEqual(["morning-report"]);
  });

  it("the relays only stop for groups the engine runs LIVE", () => {
    const t = parseTakeover(JSON.stringify({ roue: "2026-11-01T00:00:00Z", nope: "x", avis: "pas une date" }));
    expect(t).toEqual({ roue: "2026-11-01T00:00:00Z" });
    expect(relayKeysOwnedByEngine("test", t).size).toBe(0);
    expect([...relayKeysOwnedByEngine("live", t)].sort()).toEqual(["roue-1", "roue-2", "roue-3"]);
    expect(activeGroups("off", t)).toEqual([]);
    expect(activeGroups("test", {})).toEqual(GROUPS);
    expect(activeGroups("live", t)).toEqual(["roue"]);
    expect(relayKeysOwnedByEngine("live", { relance: "2026-11-01T00:00:00Z" })).toEqual(new Set(["relance-paiement", "checkout-2"]));
    expect(parseTakeover("{broken")).toEqual({});
  });

  it("starts an hour before the hand-over, never before the engine's own start", () => {
    expect(groupStart("live", { roue: "2026-11-01T12:00:00.000Z" }, "roue", "2026-10-01T00:00:00.000Z")).toBe("2026-11-01T11:00:00.000Z");
    expect(groupStart("live", { roue: "2026-11-01T12:00:00.000Z" }, "roue", "2026-11-01T11:30:00.000Z")).toBe("2026-11-01T11:30:00.000Z");
    expect(groupStart("test", { roue: "2026-11-01T12:00:00.000Z" }, "roue", "2026-10-01T00:00:00.000Z")).toBe("2026-10-01T00:00:00.000Z");
  });

  it("the relays always see what the engine handled: events, cooldowns, reminder #1 really sent", () => {
    const engine: EngineState = { ...emptyEngineState("2026-11-01T00:00:00Z"),
      done: { "roue-1": { e1: "t" }, "relance-1": { c1: "t", c2: "t" }, avis: { a1: "t" } },
      prof: { avis: { p1: "t" }, "relance-1": { p2: "t" } },
      sent: { "relance-1": { c1: "t" } } };
    const relay: RelayState = { ...emptyRelayState(), done: { "roue-1": { e0: "t" } } };
    const merged = mergeEngineIntoRelay(relay, engine);
    expect(merged.done["roue-1"]).toEqual({ e0: "t", e1: "t" });
    expect(merged.done.review).toEqual({ a1: "t" });
    expect(merged.prof.review).toEqual({ p1: "t" });
    expect(relay.done["roue-1"]).toEqual({ e0: "t" }); // input untouched
    expect(mergeEngineIntoRelance({ events: {}, sent: {}, profiles: {}, pending: [] }, engine)).toEqual({ events: { c1: "t", c2: "t" }, sent: { c1: "t" }, profiles: { p2: "t" }, pending: [] });
    expect(mergeEngineIntoRelay(relay, null)).toBe(relay);
  });

  it("relays: a settings error aborts (never guesses), a broken engine config gives everything back", async () => {
    await expect(loadRelayKeysOwnedByEngine(async () => { throw new Error("db"); })).rejects.toThrow("db");
    const settings: Record<string, string> = { email_engine_mode: "live", email_engine_takeover: JSON.stringify({ roue: "2026-11-01T00:00:00Z" }) };
    // no RESEND_API_KEY etc. in the test env → not able to send → relays keep the group
    expect((await loadRelayKeysOwnedByEngine(async (k) => settings[k] ?? null)).size).toBe(0);
    expect(relayKeysOwnedByEngine("live", { roue: "x" }, false).size).toBe(0);
    expect((await loadRelayKeysOwnedByEngine(async () => null)).size).toBe(0);
  });

  it("keeps each engine flow's own cooldown when pruning (renamed keys are not in the relay's list)", () => {
    const now = new Date("2026-11-02T12:00:00Z");
    const h = (n: number) => new Date(now.getTime() - n * 3600e3).toISOString();
    const s = pruneEngineState({ ...emptyEngineState(h(500)), prof: { "relance-1": { a: h(10), b: h(80) }, "bienvenue-1": { c: h(24 * 300) } }, done: { avis: { x: h(24 * 20) } } }, now);
    expect(s.prof["relance-1"]).toEqual({ a: h(10) });
    expect(s.prof["bienvenue-1"]).toEqual({ c: h(24 * 300) });
    expect(s.done.avis).toEqual({});
    expect(parseEngineState("{bad")).toBeNull();
    expect(parseEngineState(JSON.stringify({ startAt: "x" }))!.sent).toEqual({});
  });
});

describe("consent", () => {
  it("never mails the unsubscribed or suppressed; express flows need SUBSCRIBED", () => {
    const sub = parseKlaviyoConsent({ data: { attributes: { subscriptions: { email: { marketing: { consent: "subscribed", suppression: [] } } } } } });
    expect(sub).toEqual({ consent: "SUBSCRIBED", suppressed: false });
    expect(mayEmail(sub, "express")).toBe(true);
    expect(mayEmail({ consent: "NEVER_SUBSCRIBED", suppressed: false }, "express")).toBe(false);
    expect(mayEmail({ consent: "NEVER_SUBSCRIBED", suppressed: false }, "own")).toBe(true);
    expect(mayEmail({ consent: "UNSUBSCRIBED", suppressed: false }, "own")).toBe(false);
    expect(mayEmail({ consent: "SUBSCRIBED", suppressed: true }, "express")).toBe(false);
    expect(parseKlaviyoConsent({})).toEqual({ consent: "UNKNOWN", suppressed: false });
  });
});

describe("runEmailFlows", () => {
  const NOW = new Date("2026-11-02T12:00:00.000Z");
  const ago = (min: number) => new Date(NOW.getTime() - min * 60e3).toISOString();
  const wheelEv = (id: string, min: number, email = `${id}@client.ca`): TriggerEvent => ({ id, profileId: `p-${id}`, email, at: ago(min), props: sampleProps("roue-1", "fr") });

  function deps(over: Partial<FlowRunDeps> = {}, events: Record<string, TriggerEvent[]> = {}) {
    let saved: EngineState | null = null;
    const sent: OutgoingEmail[] = [];
    const d: FlowRunDeps = {
      now: NOW,
      mode: "live",
      takeover: { roue: ago(24 * 60) },
      loadState: async () => saved,
      saveState: async (s) => { saved = JSON.parse(JSON.stringify(s)); },
      events: async (m) => events[m] ?? [],
      relay: relayView(null, null),
      relance1Sent: async () => false,
      flowSendingAgain: () => false,
      consentOf: async () => ({ consent: "SUBSCRIBED", suppressed: false }),
      recipientAllowed: () => true,
      send: vi.fn(async (m: OutgoingEmail) => { sent.push(m); return { status: "sent" as const, id: `re_${sent.length}` }; }),
      timeLeft: () => true,
      ...over,
    };
    return { d, sent, state: () => saved };
  }

  it("does nothing while off", async () => {
    const { d } = deps({ mode: "off" });
    expect(await runEmailFlows(d)).toMatchObject({ groups: [], sent: {} });
  });

  it("sends the wheel code once, skips what the relay already sent, and remembers it", async () => {
    const events = { V5gzPH: [wheelEv("a", 15), wheelEv("b", 15), wheelEv("old", 30 * 60)] };
    const { d, sent, state } = deps({ relay: relayView({ ...emptyRelayState(), done: { "roue-1": { b: "t" } } }, null) }, events);
    const r = await runEmailFlows(d);
    expect(r.groups).toEqual(["roue"]);
    expect(sent.map((m) => m.idemKey)).toEqual(["roue-1:a"]);
    expect(sent[0]).toMatchObject({ to: "a@client.ca", flow: "roue-1", kind: "marketing", locale: "fr" });
    expect(state()!.done["roue-1"]).toHaveProperty("a");
    expect(state()!.sent["roue-1"]).toHaveProperty("a");
    // second run: nothing new
    const again = await runEmailFlows(d);
    expect(again.sent).toEqual({});
    expect(sent).toHaveLength(1);
  });

  it("a failed retryable send or a Klaviyo hiccup is retried next run, not forgotten", async () => {
    const events = { V5gzPH: [wheelEv("a", 15)] };
    const { d, state } = deps({ send: vi.fn(async () => ({ status: "failed" as const, error: "500", retryable: true })) }, events);
    const r = await runEmailFlows(d);
    expect(r.failed).toEqual([{ flow: "roue-1", error: "500" }]);
    expect(state()?.done["roue-1"]?.a).toBeUndefined();
    const k = deps({ consentOf: async () => { throw new Error("klaviyo down"); } }, events);
    expect((await runEmailFlows(k.d)).skipped).toEqual({ "roue-1:consentement-inconnu": 1 });
  });

  it("test mode: only the test list, without asking Klaviyo about anyone else", async () => {
    const events = { V5gzPH: [wheelEv("a", 15), wheelEv("mat", 15, "mat@ameublo.ca")] };
    const consentOf = vi.fn(async () => ({ consent: "SUBSCRIBED", suppressed: false }));
    const { d, sent } = deps({ mode: "test", takeover: {}, consentOf, recipientAllowed: (e) => e === "mat@ameublo.ca" }, events);
    await runEmailFlows(d);
    expect(sent.map((m) => m.to)).toEqual(["mat@ameublo.ca"]);
    expect(consentOf).toHaveBeenCalledTimes(1);
  });

  it("abandoned checkout: everyone but the unsubscribed, and reminder #2 only after #1", async () => {
    const checkout = (id: string, min: number): TriggerEvent => ({ id, profileId: `p-${id}`, email: `${id}@c.ca`, at: ago(min), props: sampleProps("relance-1", "fr") });
    const events = { Rycc4h: [checkout("c1", 45), checkout("c2", 24 * 60 + 15), checkout("c3", 50)] };
    const consentOf = async (pid: string) => ({ consent: pid === "p-c1" ? "UNSUBSCRIBED" : "NEVER_SUBSCRIBED", suppressed: false });
    const { d, sent } = deps({ takeover: { relance: ago(3 * 24 * 60) }, consentOf, relance1Sent: async (id) => id === "c2" }, events);
    const r = await runEmailFlows(d);
    expect(r.skipped["relance-1:sans-consentement"]).toBe(1);
    expect(sent.map((m) => m.idemKey)).toEqual(["relance-1:c3", "relance-2:c2"]);
  });

  it("honours the relays' cooldowns and stops when Klaviyo's own flow sends again", async () => {
    const welcome = (id: string): TriggerEvent => ({ id, profileId: `p-${id}`, email: `${id}@c.ca`, at: ago(15), props: { list_id: "Sm4Zq4" } });
    const events = { QYnDET: [welcome("w1"), welcome("w2")] };
    const relay = relayView({ ...emptyRelayState(), prof: { "welcome-1": { "p-w1": ago(24 * 60) } } }, null);
    const { d, sent } = deps({ takeover: { bienvenue: ago(60) }, relay }, events);
    await runEmailFlows(d);
    expect(sent.map((m) => m.idemKey)).toEqual(["bienvenue-1:w2"]);
    const k = deps({ takeover: { bienvenue: ago(60) }, flowSendingAgain: (id) => id === "XJghtC" }, events);
    await runEmailFlows(k.d);
    expect(k.sent).toHaveLength(0);
  });

  it("dry run counts what is due and changes nothing", async () => {
    const { d, sent, state } = deps({}, { V5gzPH: [wheelEv("a", 15)] });
    const r = await runEmailFlows(d, { dryRun: true });
    expect(r.due).toMatchObject({ "roue-1": 1, "roue-2": 0 });
    expect(sent).toHaveLength(0);
    expect(state()).toBeNull();
    expect(idemKey(FLOWS[0], wheelEv("z", 1))).toBe("relance-1:z");
  });
});
