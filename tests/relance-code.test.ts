import { describe, it, expect, vi } from "vitest";
import { checkoutSubtotal, emptyState, pruneState, type CheckoutEvent, type RelanceState } from "@/lib/relance-paiement";
import {
  CODE_PREFIX, DISCOUNT_MUTATION, buildRelance2TemplateHtml, createRelance2Discount, ensureRelance2Codes, generateRelance2Code,
  relance2DiscountInput, relance2Enabled, relance2Owns, relance2ProfileProps, relance2Subject, selectRelance2, type Relance2Ctx,
} from "@/lib/relance-code";

const now = new Date("2026-11-13T20:00:00Z");
const agoH = (h: number) => new Date(now.getTime() - h * 3600e3).toISOString();
const ev = (o: Partial<CheckoutEvent> = {}): CheckoutEvent => ({
  eventId: "e1", profileId: "p1", email: "client@gmail.com", at: agoH(24), locale: "fr",
  recoverUrl: "https://ameublodirect.ca/1/checkouts/ac/x/recover?key=k", value: 310.5, subtotal: 270,
  items: [{ title: "Sofa 3 places", quantity: 1, price: 270, image: null, handle: "sofa" }], ...o,
});
/** reminder #1 went out ~30 min after each checkout */
const st = (o: Partial<RelanceState> = {}): RelanceState => ({ ...emptyState(), sent: { e1: agoH(23.5), a: agoH(23.5), b: agoH(23.5) }, ...o });
const ctx = (o: Partial<Relance2Ctx> = {}): Relance2Ctx => ({ now, orderedAfter: () => false, checkout2Sent: () => false, ...o });
const reasons = (events: CheckoutEvent[], s = st(), c = ctx()) => selectRelance2(events, s, c).skipped.map((x) => x.reason);

describe("checkoutSubtotal", () => {
  it("uses Shopify's subtotal, never $value (tax included)", () => {
    expect(checkoutSubtotal({ $value: 280.5, $extra: { subtotal_price: "249.99", line_items: [{ line_price: 260 }] } })).toBe(249.99);
  });
  it("falls back to line prices minus discounts", () => {
    expect(checkoutSubtotal({ $value: 700, "Total Discounts": 10, $extra: { line_items: [{ line_price: 200 }, { line_price: "60" }] } })).toBe(250);
    expect(checkoutSubtotal({})).toBe(0);
  });
});

describe("selectRelance2", () => {
  it("threshold: 249.99 $ gets nothing, 250 $ gets the code", () => {
    expect(selectRelance2([ev({ subtotal: 249.99 })], st(), ctx()).send).toHaveLength(0);
    expect(reasons([ev({ subtotal: 249.99 })])).toEqual(["below-threshold"]);
    expect(selectRelance2([ev({ subtotal: 250 })], st(), ctx()).send.map((e) => e.eventId)).toEqual(["e1"]);
    expect(relance2Owns(249.99)).toBe(false);
    expect(relance2Owns(250)).toBe(true);
  });
  it("skips someone who ordered since the checkout", () => {
    expect(reasons([ev()], st(), ctx({ orderedAfter: (pid) => pid === "p1" }))).toEqual(["ordered"]);
  });
  it("window is ~20–40 h after the checkout", () => {
    expect(selectRelance2([ev({ at: agoH(19) })], st(), ctx()).skipped[0]).toMatchObject({ reason: "too-recent", final: false });
    expect(selectRelance2([ev({ at: agoH(41) })], st(), ctx()).skipped[0]).toMatchObject({ reason: "too-old", final: true });
    expect(selectRelance2([ev({ at: agoH(39) })], st(), ctx()).send).toHaveLength(1);
  });
  it("only after reminder #1 really went out (same consent basis)", () => {
    expect(selectRelance2([ev()], st({ sent: {} }), ctx()).skipped[0]).toMatchObject({ reason: "no-relance-1", final: false });
  });
  it("never after the generic reminder #2, never twice, one per person", () => {
    expect(reasons([ev()], st(), ctx({ checkout2Sent: (id) => id === "e1" }))).toEqual(["checkout-2-sent"]);
    expect(reasons([ev()], st({ events2: { e1: agoH(1) } }))).toEqual(["done"]);
    expect(reasons([ev()], st({ profiles2: { p1: agoH(24 * 10) } }))).toEqual(["cooldown"]);
    const r = selectRelance2([ev({ eventId: "a", at: agoH(30) }), ev({ eventId: "b", at: agoH(22) })], st(), ctx());
    expect(r.send.map((e) => e.eventId)).toEqual(["b"]);
  });
  it("waits while the person gets a reminder #1 (other checkout) in this run or < 12 h ago", () => {
    expect(reasons([ev()], st(), ctx({ busy: (p) => p === "p1" }))).toEqual(["busy"]);
    expect(reasons([ev()], st({ profiles: { p1: agoH(2) } }))).toEqual(["busy"]);
  });
  it("internal, no link, no email → nothing", () => {
    expect(reasons([ev({ email: "qa-x@ameublodirect.ca" })])).toEqual(["internal"]);
    expect(reasons([ev({ recoverUrl: null })])).toEqual(["no-url"]);
    expect(reasons([ev({ email: null })])).toEqual(["no-email"]);
  });
});

describe("discount payload", () => {
  it("15 $ off the order, ≥ 250 $, 1 use, once per customer, 48 h, no stacking with the 2nd-item BXGY", () => {
    const input = relance2DiscountInput("RELANCE15-ABCDEFGHJK", now);
    expect(input).toEqual({
      title: "RELANCE15-ABCDEFGHJK",
      code: "RELANCE15-ABCDEFGHJK",
      startsAt: "2026-11-13T20:00:00.000Z",
      endsAt: "2026-11-15T20:00:00.000Z",
      customerSelection: { all: true },
      customerGets: { value: { discountAmount: { amount: "15.00", appliesOnEachItem: false } }, items: { all: true } },
      minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: "250.00" } },
      usageLimit: 1,
      appliesOncePerCustomer: true,
      combinesWith: { productDiscounts: false, orderDiscounts: false, shippingDiscounts: true },
    });
  });
  it("codes are uppercase, prefixed, 10 random chars, unique", () => {
    const codes = new Set(Array.from({ length: 200 }, generateRelance2Code));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(c).toMatch(/^RELANCE15-[A-HJ-NP-Z2-9]{10}$/);
  });
  it("sends discountCodeBasicCreate; collision → null; other userErrors throw", async () => {
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const gql = vi.fn(async () => reply({ data: { discountCodeBasicCreate: { codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/1" }, userErrors: [] } } }));
    const input = relance2DiscountInput("RELANCE15-ABCDEFGHJK", now);
    expect(await createRelance2Discount(input, gql)).toEqual({ discountId: "gid://shopify/DiscountCodeNode/1" });
    const sent = JSON.parse((gql.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent).toEqual({ query: DISCOUNT_MUTATION, variables: { d: input } });
    expect(await createRelance2Discount(input, async () => reply({ data: { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ message: "Code must be unique", code: "TAKEN" }] } } }))).toBeNull();
    await expect(createRelance2Discount(input, async () => reply({ data: { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ message: "bad", code: "INVALID" }] } } }))).rejects.toThrow(/userErrors/);
  });
});

describe("ensureRelance2Codes", () => {
  const deps = (state: RelanceState) => {
    let n = 0;
    return {
      now, state,
      save: vi.fn(async (s: RelanceState) => { void s; }),
      create: vi.fn(async () => ({ discountId: `gid://d/${++n}` })),
      genCode: () => `${CODE_PREFIX}TESTCODE0${n}`,
    };
  };
  it("creates one code per checkout and saves it before any email", async () => {
    const d = deps(st());
    const r = await ensureRelance2Codes([ev()], d);
    expect(d.create).toHaveBeenCalledTimes(1);
    expect(d.save).toHaveBeenCalledTimes(1);
    expect(r.ready[0].code).toMatchObject({ code: "RELANCE15-TESTCODE00", discountId: "gid://d/1", endsAt: "2026-11-15T20:00:00.000Z" });
    expect(d.state.codes.e1.code).toBe("RELANCE15-TESTCODE00");
  });
  it("idempotent: a retry reuses the stored code, never a second one", async () => {
    const d = deps(st());
    await ensureRelance2Codes([ev()], d);
    const again = await ensureRelance2Codes([ev()], { ...d, now: new Date(now.getTime() + 3600e3) });
    expect(d.create).toHaveBeenCalledTimes(1);
    expect(again.ready[0].code.code).toBe("RELANCE15-TESTCODE00");
    // the state survives a save/load round trip (pruneState keeps it)
    expect(pruneState(JSON.parse(JSON.stringify(d.state)), now).codes.e1.code).toBe("RELANCE15-TESTCODE00");
  });
  it("retries once on a code collision", async () => {
    const d = deps(st());
    d.create.mockResolvedValueOnce(null as never);
    const r = await ensureRelance2Codes([ev()], d);
    expect(d.create).toHaveBeenCalledTimes(2);
    expect(r.ready).toHaveLength(1);
  });
  it("a Shopify error leaves no code stored and no email ready", async () => {
    const d = deps(st());
    d.create.mockRejectedValueOnce(new Error("Shopify 500"));
    const r = await ensureRelance2Codes([ev()], d);
    expect(r.ready).toHaveLength(0);
    expect(r.errors[0].error).toMatch(/500/);
    expect(d.state.codes.e1).toBeUndefined();
  });
  it("dry run creates nothing and saves nothing", async () => {
    const d = deps(st());
    const r = await ensureRelance2Codes([ev(), ev({ eventId: "a", profileId: "p2" })], d, { dryRun: true });
    expect(d.create).not.toHaveBeenCalled();
    expect(d.save).not.toHaveBeenCalled();
    expect(r.ready).toHaveLength(0);
    expect(r.wouldCreate).toHaveLength(2);
    expect(r.wouldCreate[0]).toMatchObject({ code: "RELANCE15-DRYRUN", usageLimit: 1, endsAt: "2026-11-15T20:00:00.000Z" });
    expect(d.state.codes).toEqual({});
  });
});

describe("email", () => {
  it("kill switch is OFF unless exactly \"1\"", () => {
    expect(relance2Enabled(null)).toBe(false);
    expect(relance2Enabled("0")).toBe(false);
    expect(relance2Enabled("true")).toBe(false);
    expect(relance2Enabled("1")).toBe(true);
  });
  it("template shows code, expiry, 250 $ minimum, recover link — never the supplier", () => {
    for (const l of ["fr", "en"] as const) {
      const h = buildRelance2TemplateHtml(l);
      for (const k of ["relance2_code", "relance2_expires", "relance_url", "relance_items_html"]) expect(h).toContain(k);
      expect(h).toContain(l === "fr" ? "250 $ et plus" : "$250 or more");
      expect(h).toContain(l === "fr" ? "48 h" : "48 h");
      expect(h).toContain(l === "fr" ? "Ameublo Direct" : "Furnish Direct");
      expect(h).toContain(l === "fr" ? "{% unsubscribe 'Se désabonner' %}" : "{% unsubscribe 'Unsubscribe' %}");
      const { subject, preview } = relance2Subject(l);
      expect(`${h} ${subject} ${preview}`).not.toMatch(/aosom/i);
    }
    expect(buildRelance2TemplateHtml("en")).not.toContain("Ameublo");
  });
  it("profile properties carry the code and a local expiry", () => {
    const p = relance2ProfileProps(ev(), { code: "RELANCE15-X", discountId: "d", endsAt: "2026-11-15T20:00:00.000Z", at: now.toISOString() }, "<tr></tr>");
    expect(p).toMatchObject({ relance2_code: "RELANCE15-X", relance_url: ev().recoverUrl });
    expect(p.relance2_expires).toMatch(/15 novembre/);
    expect(p.relance2_expires).toMatch(/15/);
  });
});
