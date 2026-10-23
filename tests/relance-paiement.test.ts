import { describe, it, expect } from "vitest";
import { parseCheckoutEvent, selectCandidates, renderItemsHtml, buildTemplateHtml, pruneState, emptyState, type CheckoutEvent } from "@/lib/relance-paiement";

const now = new Date("2026-10-20T20:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60e3).toISOString();
const ev = (o: Partial<CheckoutEvent> = {}): CheckoutEvent => ({
  eventId: "e1", profileId: "p1", email: "client@gmail.com", at: ago(60), locale: "fr",
  recoverUrl: "https://ameublodirect.ca/1/checkouts/ac/x/recover?key=k", value: 164.4,
  items: [{ title: "Armoire console — Chêne", quantity: 1, price: 142.99, image: null, handle: "armoire" }], ...o,
});
const never = () => false;

describe("parseCheckoutEvent", () => {
  it("reads Shopify's Checkout Started payload", () => {
    const e = parseCheckoutEvent({
      id: "ev9", relationships: { profile: { data: { id: "p9" } } },
      attributes: { datetime: "2026-10-19T18:53:00+00:00", event_properties: {
        "Customer Locale": "en-CA", $value: 99,
        $extra: { checkout_url: "https://ameublodirect.ca/c/recover?key=1", line_items: [{ presentment_title: "Chair", quantity: 2, line_price: 50, product: { handle: "chair", images: [{ src: "https://cdn.shopify.com/a/chair.jpg?v=1" }] } }] },
      } },
    }, "a@b.co")!;
    expect(e).toMatchObject({ eventId: "ev9", profileId: "p9", locale: "en", recoverUrl: "https://ameublodirect.ca/c/recover?key=1", value: 99 });
    expect(e.items[0]).toMatchObject({ title: "Chair", quantity: 2, price: 50, image: "https://cdn.shopify.com/a/chair_x300.jpg?v=1" });
  });
  it("refuses a non-https recover link", () => {
    const e = parseCheckoutEvent({ id: "x", relationships: { profile: { data: { id: "p" } } }, attributes: { datetime: ago(60), event_properties: { $extra: { checkout_url: "javascript:alert(1)" } } } }, "a@b.co")!;
    expect(e.recoverUrl).toBeNull();
  });
});

describe("selectCandidates", () => {
  it("reminds an unpaid checkout after the delay", () => {
    expect(selectCandidates([ev()], emptyState(), never, now).send).toHaveLength(1);
  });
  it("waits while the buyer may still be paying, and drops old checkouts", () => {
    const r = selectCandidates([ev({ eventId: "a", at: ago(10) }), ev({ eventId: "b", profileId: "p2", at: ago(60 * 40) })], emptyState(), never, now);
    expect(r.send).toHaveLength(0);
    expect(r.skipped).toEqual([{ eventId: "a", reason: "too-recent", final: false }, { eventId: "b", reason: "too-old", final: true }]);
  });
  it("never emails someone who ordered, an internal address, or twice", () => {
    const r = selectCandidates([
      ev({ eventId: "a", profileId: "pa" }),
      ev({ eventId: "b", profileId: "pb", email: "qa-roue@ameublodirect.ca" }),
      ev({ eventId: "c", profileId: "pc" }),
    ], { ...emptyState(), events: { c: ago(5) } }, (pid) => pid === "pa", now);
    expect(r.send).toHaveLength(0);
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(["done", "internal", "ordered"]);
  });
  it("sends one reminder per person, about the latest checkout, then cools down", () => {
    const r = selectCandidates([ev({ eventId: "old", at: ago(120) }), ev({ eventId: "new", at: ago(45) })], emptyState(), never, now);
    expect(r.send.map((e) => e.eventId)).toEqual(["new"]);
    expect(selectCandidates([ev({ eventId: "z" })], { ...emptyState(), profiles: { p1: ago(60 * 24) } }, never, now).send).toHaveLength(0);
  });
});

describe("rendering", () => {
  it("escapes product titles", () => {
    expect(renderItemsHtml(ev({ items: [{ title: "Table <b>", quantity: 2, price: 10, image: null, handle: null }] }))).toContain("Table &lt;b&gt;");
  });
  it("template carries the per-person blocks and the unsubscribe link", () => {
    for (const l of ["fr", "en"] as const) {
      const h = buildTemplateHtml(l);
      expect(h).toContain("relance_items_html");
      expect(h).toContain("relance_url");
      expect(h).toContain(l === "fr" ? "{% unsubscribe 'Se désabonner' %}" : "{% unsubscribe 'Unsubscribe' %}");
      expect(h).not.toMatch(/aosom/i);
    }
  });
  it("prunes week-old bookkeeping", () => {
    expect(pruneState({ ...emptyState(), events: { a: ago(60 * 24 * 9), b: ago(5) } }, now).events).toEqual({ b: ago(5) });
  });
});
