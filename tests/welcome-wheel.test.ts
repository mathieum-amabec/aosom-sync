import { describe, it, expect } from "vitest";
import {
  WHEEL_PRIZES,
  prizeIndexFor,
  prizeWithinFloor,
  normalizeEmailKey,
  isValidEmail,
  generateCode,
  discountInput,
  subscribeBody,
  CODE_TTL_HOURS,
} from "@/lib/welcome-wheel";
import { maxPerItem } from "@/lib/margin-guard";

describe("welcome wheel prizes", () => {
  it("every prize stays inside the profit floor (≤ 10 % of its minimum)", () => {
    for (const p of WHEEL_PRIZES) expect(prizeWithinFloor(p)).toBe(true);
  });

  it("the margin guard bounds every generated code at ≤ 10 % per item", () => {
    for (const p of WHEEL_PRIZES) {
      const m = maxPerItem({ title: p.key, typename: "DiscountCodeBasic", percentage: null, amount: p.amount, amountOnEachItem: false, minSubtotal: p.minSubtotal, combinesWithProduct: false, combinesWithOrder: false });
      expect(m).not.toBeNull();
      expect(m as number).toBeLessThanOrEqual(0.1 + 1e-9);
    }
  });

  it("weights sum to 100 so each slice's size is its real percentage", () => {
    expect(WHEEL_PRIZES.reduce((s, p) => s + p.weight, 0)).toBe(100);
  });

  it("maps a uniform draw onto slices by weight, boundaries included", () => {
    expect(prizeIndexFor(0)).toBe(0);
    expect(prizeIndexFor(44)).toBe(0);
    expect(prizeIndexFor(45)).toBe(1);
    expect(prizeIndexFor(74)).toBe(1);
    expect(prizeIndexFor(75)).toBe(2);
    expect(prizeIndexFor(91)).toBe(2);
    expect(prizeIndexFor(92)).toBe(3);
    expect(prizeIndexFor(98)).toBe(3);
    expect(prizeIndexFor(99)).toBe(4);
    const counts = new Array(WHEEL_PRIZES.length).fill(0);
    for (let r = 0; r < 100; r++) counts[prizeIndexFor(r)]++;
    expect(counts).toEqual(WHEEL_PRIZES.map((p) => p.weight));
  });
});

describe("emails", () => {
  it("collapses gmail aliases to one spin", () => {
    expect(normalizeEmailKey("Jean.Tremblay+roue@Gmail.com")).toBe("jeantremblay@gmail.com");
    expect(normalizeEmailKey("jeantremblay@googlemail.com")).toBe("jeantremblay@gmail.com");
    expect(normalizeEmailKey("jean.tremblay+x@videotron.ca")).toBe("jean.tremblay@videotron.ca");
  });

  it("validates emails", () => {
    expect(isValidEmail("a@b.ca")).toBe(true);
    expect(isValidEmail("nope")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail(42)).toBe(false);
  });
});

describe("Shopify code", () => {
  it("generates readable unique-looking codes", () => {
    const c = generateCode();
    expect(c).toMatch(/^ROUE-[A-HJ-NP-Z2-9]{6}$/);
  });

  it("is single-use, 72 h, minimum subtotal, shipping-combinable only", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const d = discountInput("ROUE-ABCDEF", WHEEL_PRIZES[1], now);
    expect(d.code).toBe("ROUE-ABCDEF");
    expect(new Date(d.endsAt).getTime() - now.getTime()).toBe(CODE_TTL_HOURS * 3600_000);
    expect(d.usageLimit).toBe(1);
    expect(d.appliesOncePerCustomer).toBe(true);
    expect(d.customerGets.value.discountAmount).toEqual({ amount: "25.00", appliesOnEachItem: false });
    expect(d.minimumRequirement.subtotal.greaterThanOrEqualToSubtotal).toBe("250.00");
    expect(d.combinesWith).toEqual({ orderDiscounts: false, productDiscounts: false, shippingDiscounts: true });
  });
});

describe("Klaviyo subscribe body", () => {
  it("records SUBSCRIBED consent and the wheel list when configured", () => {
    const b = subscribeBody("a@b.ca", "LIST1");
    expect(b.data.attributes.profiles.data[0].attributes.subscriptions.email.marketing.consent).toBe("SUBSCRIBED");
    expect(Object.keys(b.data.attributes.profiles.data[0].attributes).sort()).toEqual(["email", "subscriptions"]);
    expect(b.data.relationships?.list.data.id).toBe("LIST1");
    expect(subscribeBody("a@b.ca", null).data.relationships).toBeUndefined();
  });
});
