import { describe, it, expect } from "vitest";
import { STEPS, RELAY_START_AT, rewriteBody, rewriteLine, usesEvent, eventContext, selectDue, pruneRelayState, emptyRelayState, propKey, type Ctx, type TriggerEvent } from "@/lib/flow-relay";
import { shouldRetry, stillInFlight } from "@/lib/klaviyo-campaigns";

const now = new Date("2026-10-25T12:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60e3).toISOString();
const step = (key: string) => STEPS.find((s) => s.key === key)!;
const ctx = (o: Partial<Ctx> = {}): Ctx => ({
  now, state: emptyRelayState(),
  orderedAfter: () => false, wonWheelWithin7d: () => false, relancePaiementSent: () => true, flowSendingAgain: () => false, ...o,
});
const ev = (o: Partial<TriggerEvent> = {}): TriggerEvent => ({ id: "e1", profileId: "p1", email: "client@gmail.com", at: ago(30), props: { code: "ROUE-AB12" }, ...o });

describe("template rewriting", () => {
  const doc = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"></head><body style="margin:0"><p>event</p><p>{{ event.code }}</p>{% for item in event.extra.line_items|slice:":3" %}{{ item.title }}{% endfor %}{% with loc=event|lookup:'Customer Locale' %}{% endwith %}<p>{% unsubscribe %}Se désabonner / Unsubscribe{% endunsubscribe %}</p></body></html>`;
  it("reads event variables from the profile property, inside <body> so the doctype survives", () => {
    const out = rewriteBody(doc, "rl_roue_1");
    expect(out.startsWith("<!DOCTYPE html><html lang=\"fr\"><head><meta charset=\"utf-8\"></head><body style=\"margin:0\">{% with ev=person|lookup:'rl_roue_1' %}")).toBe(true);
    expect(out.endsWith("{% endwith %}</body></html>")).toBe(true);
    expect(out).toContain("<p>event</p>");
    expect(out).toContain("{{ ev.code }}");
    expect(out).toContain("{% for item in ev.extra.line_items|slice:\":3\" %}");
    expect(out).toContain("ev|lookup:'Customer Locale'");
    expect(out).not.toMatch(/\{[{%][^}]*\bevent\b/);
  });
  it("replaces the invalid unsubscribe block (Klaviyo skipped 40/40 recipients on it)", () => {
    const out = rewriteBody(doc, "k");
    expect(out).toContain("{% unsubscribe 'Se désabonner / Unsubscribe' %}");
    expect(out).not.toContain("endunsubscribe");
  });
  it("fixes the returns, price-drop, review and 2nd-item wording", () => {
    const out = rewriteBody(`<p>✓ Retours acceptés pendant 30 jours</p><p>Retours 30 jours · 30-day returns</p><p>en promotion. Les quantités sont limitées — profites-en avant que le prix ne remonte.</p><p>Ta commande est en route depuis quelques jours — on espère qu'elle te plaît !</p><p>Astuce : ajoute un 2<sup>e</sup> article et il passe à <b>10 % de rabais</b></p><a href="{{ event.url|default:'https://x' }}">`, "k");
    expect(out).toContain("Retours sous 30 jours (frais de 10 % + étiquette de retour)");
    expect(out).toContain("30-day returns (10% fee + return label)");
    expect(out).not.toContain("quantités sont limitées");
    expect(out).toContain("Ta commande est arrivée ? On espère qu'elle te plaît !");
    expect(out).toContain("le moins cher des deux est à <b>10 % de rabais</b>");
    expect(out).not.toContain("il passe à");
    expect(out).toContain("ev.product_url|default");
  });
  it("leaves static templates static", () => {
    const html = "<p>Bienvenue <a href=\"{{ unsubscribe_link }}\">x</a></p>";
    expect(rewriteBody(html, "k")).toBe(html);
    expect(usesEvent(html, { subject: "Bienvenue", preview: "" })).toBe(false);
    expect(usesEvent(html, { subject: "{{ event.subject }}", preview: "" })).toBe(true);
  });
  it("rewrites subject lines with chained lookups", () => {
    expect(rewriteLine("🎁 Ton code : {{ event.prize_fr }} / {{ event.a.b }}", "rl_roue_1"))
      .toBe("🎁 Ton code : {{ person|lookup:'rl_roue_1'|lookup:'prize_fr' }} / {{ person|lookup:'rl_roue_1'|lookup:'a'|lookup:'b' }}");
    for (const s of STEPS) expect(rewriteLine(s.subject + s.preview, propKey(s))).not.toMatch(/\bevent\b/);
  });
  it("gives every step its own profile property (roue-1 of a new spin can't show roue-2's code)", () => {
    expect(new Set(STEPS.map(propKey)).size).toBe(STEPS.length);
  });
});

describe("eventContext", () => {
  it("exposes $extra as extra, trims line items, drops internal keys", () => {
    const c = eventContext({ $event_id: "x", $value: 10, "Item Count": 1, code: "ROUE-1", ip_address: "1.2.3.4", email_address: "a@b.c",
      $extra: { checkout_url: "https://s/recover", referring_site: "x", line_items: [{ title: "Chaise", quantity: 1, line_price: 9, tax_lines: [1], product: { handle: "h", tags: "a", images: [{ src: "s", thumb_src: "t" }, { src: "s2" }] } }] } });
    expect(c).toEqual({ $value: 10, "Item Count": 1, code: "ROUE-1", extra: { checkout_url: "https://s/recover",
      line_items: [{ title: "Chaise", presentment_title: undefined, quantity: 1, line_price: 9, product: { handle: "h", images: [{ src: "s", thumb_src: "t" }] } }] } });
  });
});

describe("selectDue", () => {
  it("sends a wheel code 10 minutes after the spin, once, and only with a code", () => {
    expect(selectDue(step("roue-1"), [ev({ at: ago(12) })], ctx())).toHaveLength(1);
    expect(selectDue(step("roue-1"), [ev({ at: ago(5) })], ctx())).toHaveLength(0);
    expect(selectDue(step("roue-1"), [ev({ at: ago(12), props: { seed: 1 } })], ctx())).toHaveLength(0);
    const c = ctx(); c.state.done["roue-1"] = { e1: ago(1) };
    expect(selectDue(step("roue-1"), [ev({ at: ago(12) })], c)).toHaveLength(0);
  });
  it("starts right after the catch-up, never before", () => {
    expect(RELAY_START_AT).toBe("2026-10-20T22:36:00.000Z");
    expect(selectDue(step("review"), [ev({ at: "2026-10-05T00:00:00Z" })], ctx())).toHaveLength(0);
    expect(selectDue(step("review"), [ev({ at: "2026-10-11T00:00:00Z" })], ctx({ now: new Date("2026-10-21T01:00:00Z") }))).toHaveLength(1);
  });
  it("drops a step once it is too late (the last wheel email must not say 12 h left when it's gone)", () => {
    expect(selectDue(step("roue-3"), [ev({ at: ago(10 + 24 * 60 + 36 * 60 + 3 * 60) })], ctx())).toHaveLength(0);
  });
  it("skips buyers, internal/test addresses and flows that send again", () => {
    expect(selectDue(step("roue-2"), [ev({ at: ago(24 * 60 + 15) })], ctx({ orderedAfter: () => true }))).toHaveLength(0);
    for (const email of ["qa-roue@ameublodirect.ca", "ops-seed@x.com", "info@ameublodirect.ca"]) {
      expect(selectDue(step("roue-1"), [ev({ at: ago(12), email })], ctx())).toHaveLength(0);
    }
    expect(selectDue(step("roue-1"), [ev({ at: ago(12) })], ctx({ flowSendingAgain: (f) => f === "WmUVfQ" }))).toHaveLength(0);
  });
  it("welcome: Shopify newsletter list only, not after a wheel win", () => {
    const s = step("welcome-1");
    expect(selectDue(s, [ev({ at: ago(15), props: { list_id: "Sm4Zq4" } })], ctx())).toHaveLength(1);
    expect(selectDue(s, [ev({ at: ago(15), props: { list_id: "TYuZhf" } })], ctx())).toHaveLength(0);
    expect(selectDue(s, [ev({ at: ago(15), props: { list_id: "Sm4Zq4" } })], ctx({ wonWheelWithin7d: () => true }))).toHaveLength(0);
  });
  it("checkout reminder #2 only after reminder #1 really went out", () => {
    const s = step("checkout-2");
    expect(selectDue(s, [ev({ at: ago(24 * 60 + 20) })], ctx())).toHaveLength(1);
    expect(selectDue(s, [ev({ at: ago(24 * 60 + 20) })], ctx({ relancePaiementSent: () => false }))).toHaveLength(0);
  });
  it("one email per person per step, and cooldowns", () => {
    const s = step("review");
    const at = (d: number) => new Date(now.getTime() - (10 * 24 * 60 + d) * 60e3).toISOString();
    expect(selectDue(s, [ev({ id: "a", at: at(5) }), ev({ id: "b", at: at(50) })], ctx())).toHaveLength(1);
    const c = ctx(); c.state.prof.review = { p1: ago(60 * 24 * 3) };
    expect(selectDue(s, [ev({ at: at(5) })], c)).toHaveLength(0);
  });
  it("browse abandonment is not relayed (no consent basis)", () => {
    expect(STEPS.some((s) => s.flowId === "QYEyd8")).toBe(false);
  });
});

describe("state", () => {
  it("prunes done after 15 days and a profile once its cooldown is over", () => {
    const s = { ...emptyRelayState(), done: { review: { old: ago(60 * 24 * 20), fresh: ago(5) } },
      prof: { "welcome-1": { p: ago(60 * 24 * 200) }, "roue-1": { p: ago(5) }, review: { q: ago(60 * 24 * 31) } } };
    const out = pruneRelayState(s, now);
    expect(out.done.review).toEqual({ fresh: ago(5) });
    expect(out.prof["welcome-1"]).toEqual({ p: ago(60 * 24 * 200) });
    expect(out.prof["roue-1"]).toEqual({});
    expect(out.prof.review).toEqual({});
  });
  it("retries only Klaviyo's own No Recipients cancellation; in-flight is never resent", () => {
    expect(shouldRetry("Cancelled: No Recipients")).toBe(true);
    expect(shouldRetry("Cancelled")).toBe(false);
    expect(shouldRetry("Queued without Recipients")).toBe(false);
    for (const s of ["Adding Recipients", "Scheduled", "Sending", "Draft"]) { expect(stillInFlight(s)).toBe(true); expect(shouldRetry(s)).toBe(false); }
  });
});
