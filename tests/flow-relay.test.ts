import { describe, it, expect } from "vitest";
import { STEPS, rewriteBody, rewriteLine, eventContext, selectDue, pruneRelayState, emptyRelayState, type Ctx, type TriggerEvent } from "@/lib/flow-relay";

const now = new Date("2026-10-25T12:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60e3).toISOString();
const step = (key: string) => STEPS.find((s) => s.key === key)!;
const ctx = (o: Partial<Ctx> = {}): Ctx => ({
  now, state: { ...emptyRelayState(new Date("2026-10-20T00:00:00Z")) },
  orderedAfter: () => false, checkoutWithin24h: () => false, relancePaiementSent: () => true, flowSendingAgain: () => false, ...o,
});
const ev = (o: Partial<TriggerEvent> = {}): TriggerEvent => ({ id: "e1", profileId: "p1", email: "client@gmail.com", at: ago(30), props: {}, ...o });

describe("template rewriting", () => {
  it("reads event variables from the profile property inside tags only", () => {
    const html = `<p>event</p><p>{{ event.code }}</p>{% for item in event.extra.line_items|slice:":3" %}{{ item.title }}{% endfor %}{% with loc=event|lookup:'Customer Locale' %}{% endwith %}`;
    const out = rewriteBody(html, "WmUVfQ");
    expect(out.startsWith("{% with ev=person|lookup:'rl_WmUVfQ' %}")).toBe(true);
    expect(out.endsWith("{% endwith %}")).toBe(true);
    expect(out).toContain("<p>event</p>");
    expect(out).toContain("{{ ev.code }}");
    expect(out).toContain("{% for item in ev.extra.line_items|slice:\":3\" %}");
    expect(out).toContain("ev|lookup:'Customer Locale'");
    expect(out).not.toMatch(/\{[{%][^}]*\bevent\b/);
  });
  it("leaves static templates untouched", () => {
    expect(rewriteBody("<p>Bienvenue {% unsubscribe %}x{% endunsubscribe %}</p>", "XJghtC")).toBe("<p>Bienvenue {% unsubscribe %}x{% endunsubscribe %}</p>");
  });
  it("rewrites subject lines with chained lookups", () => {
    expect(rewriteLine("🎁 Ton code : {{ event.prize_fr }} / {{ event.a.b }}", "WmUVfQ"))
      .toBe("🎁 Ton code : {{ person|lookup:'rl_WmUVfQ'|lookup:'prize_fr' }} / {{ person|lookup:'rl_WmUVfQ'|lookup:'a'|lookup:'b' }}");
    expect(rewriteLine("Bienvenue", "x")).toBe("Bienvenue");
  });
  it("every step's subject/preview is fully rewritten", () => {
    for (const s of STEPS) expect(rewriteLine(s.subject + s.preview, s.flowId)).not.toMatch(/\bevent\b/);
  });
});

describe("eventContext", () => {
  it("exposes $extra as extra, trims line items and drops internal $ keys", () => {
    const c = eventContext({ $event_id: "x", $value: 10, "Item Count": 1, code: "ROUE-1",
      $extra: { checkout_url: "https://s/recover", referring_site: "x", line_items: [{ title: "Chaise", quantity: 1, line_price: 9, tax_lines: [1], product: { handle: "h", tags: "a", images: [{ src: "s", thumb_src: "t" }, { src: "s2" }] } }] } });
    expect(c).toEqual({ $value: 10, "Item Count": 1, code: "ROUE-1", extra: { checkout_url: "https://s/recover",
      line_items: [{ title: "Chaise", presentment_title: undefined, quantity: 1, line_price: 9, product: { handle: "h", images: [{ src: "s", thumb_src: "t" }] } }] } });
  });
});

describe("selectDue", () => {
  it("sends a wheel code 10 minutes after the spin, once", () => {
    expect(selectDue(step("roue-1"), [ev({ at: ago(12) })], ctx())).toHaveLength(1);
    expect(selectDue(step("roue-1"), [ev({ at: ago(5) })], ctx())).toHaveLength(0);
    const c = ctx(); c.state.done["roue-1"] = { e1: ago(1) };
    expect(selectDue(step("roue-1"), [ev({ at: ago(12) })], c)).toHaveLength(0);
  });
  it("never sends a step that was due before the relay started (the catch-up covered it)", () => {
    expect(selectDue(step("review"), [ev({ at: new Date("2026-10-05T00:00:00Z").toISOString() })], ctx())).toHaveLength(0);
  });
  it("drops a step once it is too late", () => {
    expect(selectDue(step("roue-1"), [ev({ at: ago(10 + 24 * 60 + 5) })], ctx())).toHaveLength(0);
  });
  it("skips buyers, internal addresses and flows that send again", () => {
    expect(selectDue(step("roue-2"), [ev({ at: ago(24 * 60 + 15) })], ctx({ orderedAfter: () => true }))).toHaveLength(0);
    expect(selectDue(step("roue-1"), [ev({ at: ago(12), email: "qa-roue@ameublodirect.ca" })], ctx())).toHaveLength(0);
    expect(selectDue(step("roue-1"), [ev({ at: ago(12) })], ctx({ flowSendingAgain: (f) => f === "WmUVfQ" }))).toHaveLength(0);
  });
  it("welcome only for the Shopify newsletter list, not the wheel list", () => {
    const s = step("welcome-1");
    expect(selectDue(s, [ev({ at: ago(15), props: { list_id: "Sm4Zq4" } })], ctx())).toHaveLength(1);
    expect(selectDue(s, [ev({ at: ago(15), props: { list_id: "TYuZhf" } })], ctx())).toHaveLength(0);
  });
  it("checkout reminder #2 only after reminder #1 went out", () => {
    const s = step("checkout-2");
    expect(selectDue(s, [ev({ at: ago(24 * 60 + 20) })], ctx())).toHaveLength(1);
    expect(selectDue(s, [ev({ at: ago(24 * 60 + 20) })], ctx({ relancePaiementSent: () => false }))).toHaveLength(0);
  });
  it("browse: not when a checkout was started, and one per person per week", () => {
    const s = step("browse");
    expect(selectDue(s, [ev({ at: ago(200) })], ctx({ checkoutWithin24h: () => true }))).toHaveLength(0);
    expect(selectDue(s, [ev({ id: "a", at: ago(200) }), ev({ id: "b", at: ago(250) })], ctx())).toHaveLength(1);
    const c = ctx(); c.state.prof.browse = { p1: ago(60 * 24 * 3) };
    expect(selectDue(s, [ev({ at: ago(200) })], c)).toHaveLength(0);
  });
});

describe("pruneRelayState", () => {
  it("keeps recent bookkeeping and long cooldowns", () => {
    const s = { ...emptyRelayState(now), done: { review: { old: ago(60 * 24 * 20), fresh: ago(5) } }, prof: { "welcome-1": { p: ago(60 * 24 * 200) } } };
    const out = pruneRelayState(s, now);
    expect(out.done.review).toEqual({ fresh: ago(5) });
    expect(out.prof["welcome-1"]).toEqual({ p: ago(60 * 24 * 200) });
  });
});
