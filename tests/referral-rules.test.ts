import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  CODE_SPECS,
  addressKey,
  evaluateReferral,
  friendCodeOf,
  generateFriendCode,
  generatePersonalCode,
  identityHash,
  normalizePhone,
  parseReferralMode,
  referralDiscountInput,
  shouldRevoke,
  specWithinFloor,
  type ReferralOrder,
  type Referrer,
} from "@/lib/referral/rules";
import { evaluateDiscounts, toDiscountInfo } from "@/lib/margin-guard";
import { shopifyEligibility, klaviyoBlocks, profileImportBody } from "@/lib/referral/launch";

const NOW = new Date("2026-12-01T15:00:00Z");

describe("referral codes pass the margin guard", () => {
  for (const kind of ["personal", "friend", "credit"] as const) {
    it(`${kind}: fixed 10 $ once per order, minimum 100 $, ≤ 10 %, combines with shipping only`, () => {
      const code = kind === "friend" ? generateFriendCode() : generatePersonalCode();
      const input = referralDiscountInput(code, kind, NOW);
      expect(input.customerGets.value.discountAmount).toEqual({ amount: "10.00", appliesOnEachItem: false });
      expect(input.minimumRequirement.subtotal.greaterThanOrEqualToSubtotal).toBe("100.00");
      expect(input.combinesWith).toEqual({ orderDiscounts: false, productDiscounts: false, shippingDiscounts: true });
      expect(input.appliesOncePerCustomer).toBe(true);
      expect(input.title.startsWith(code)).toBe(true);
      // Feed the exact shape the margin guard reads from Shopify back through its own evaluator.
      const info = toDiscountInfo({
        __typename: "DiscountCodeBasic",
        title: input.title,
        status: "ACTIVE",
        combinesWith: { productDiscounts: input.combinesWith.productDiscounts, orderDiscounts: input.combinesWith.orderDiscounts },
        minimumRequirement: { __typename: "DiscountMinimumSubtotal", greaterThanOrEqualToSubtotal: { amount: input.minimumRequirement.subtotal.greaterThanOrEqualToSubtotal } },
        customerGets: { value: { __typename: "DiscountAmount", amount: { amount: input.customerGets.value.discountAmount.amount }, appliesOnEachItem: false } },
      });
      const verdict = evaluateDiscounts([info, info, info]);
      expect(verdict.problems).toEqual([]);
      expect(verdict.worst).toBeCloseTo(0.1, 9);
    });
  }
  it("usage limits and lifetimes match the approved design", () => {
    const p = referralDiscountInput("MERCI10-AAAAAA", "personal", NOW);
    const f = referralDiscountInput("AMI-AAAAAA", "friend", NOW);
    const c = referralDiscountInput("MERCI10-BBBBBB", "credit", NOW);
    expect(p.usageLimit).toBe(1);
    expect(f.usageLimit).toBe(10);
    expect(c.usageLimit).toBe(1);
    const days = (x: { startsAt: string; endsAt: string }) => (Date.parse(x.endsAt) - Date.parse(x.startsAt)) / 86_400_000;
    expect(days(p)).toBe(60);
    expect(days(f)).toBe(90);
    expect(days(c)).toBe(60);
  });
  it("refuses a spec above MAX_DISCOUNT and a wrong prefix", () => {
    expect(specWithinFloor({ amount: 15, minSubtotal: 100 })).toBe(false);
    expect(Object.values(CODE_SPECS).every(specWithinFloor)).toBe(true);
    expect(() => referralDiscountInput("AMI-AAAAAA", "personal", NOW)).toThrow();
    expect(() => referralDiscountInput("MERCI10-AAAAAA", "friend", NOW)).toThrow();
  });
  it("codes have the right shape and no ambiguous characters", () => {
    for (let i = 0; i < 50; i++) {
      expect(generatePersonalCode()).toMatch(/^MERCI10-[A-HJ-NP-Z2-9]{6}$/);
      expect(generateFriendCode()).toMatch(/^AMI-[A-HJ-NP-Z2-9]{6}$/);
    }
  });
});

describe("mode", () => {
  it("defaults to off", () => {
    expect(parseReferralMode(null)).toBe("off");
    expect(parseReferralMode("bogus")).toBe("off");
    expect(parseReferralMode("dry")).toBe("dry");
    expect(parseReferralMode("live")).toBe("live");
  });
});

describe("normalisation", () => {
  it("phone: digits, leading 1 dropped", () => {
    expect(normalizePhone("+1 (514) 555-0123")).toBe("5145550123");
    expect(normalizePhone("514.555.0123")).toBe("5145550123");
    expect(normalizePhone("12")).toBeNull();
  });
  it("address: two spellings of the same place meet", () => {
    const a = addressKey({ address1: "123, Rue Saint-Denis", address2: "App. 4", zip: "h2x 1k5" });
    const b = addressKey({ address1: "123 saint denis", address2: "4", zip: "H2X1K5" });
    expect(a).toBe(b);
    expect(addressKey({ address1: "123 Saint-Denis", zip: "H2X 1K6" })).not.toBe(a);
    expect(addressKey({ address1: "", zip: "H2X1K5" })).toBeNull();
  });
  it("friendCodeOf picks the AMI- code, case-insensitive", () => {
    expect(friendCodeOf(["BIENVENUE20", "ami-abc234"])).toBe("AMI-ABC234");
    expect(friendCodeOf(["MERCI10-ABC234"])).toBeNull();
  });
});

const referrer: Referrer = {
  id: 1,
  customerId: "gid://shopify/Customer/1",
  email: "Jean.Tremblay+promo@gmail.com",
  lang: "fr",
  friendCode: "AMI-ABC234",
  credits: 0,
  phoneHashes: [identityHash("5145550123")],
  addressHashes: [identityHash(addressKey({ address1: "123 rue Saint-Denis", zip: "H2X1K5" }) as string)],
};

const order = (o: Partial<ReferralOrder> = {}): ReferralOrder => ({
  id: "gid://shopify/Order/9",
  name: "#1300",
  createdAt: "2026-12-01T12:00:00Z",
  cancelled: false,
  test: false,
  financialStatus: "PAID",
  discountCodes: ["AMI-ABC234"],
  email: "amie@example.com",
  phone: "4185550000",
  customerId: "gid://shopify/Customer/2",
  shippingAddress: { address1: "9 rue des Érables", zip: "G1R 2B3", phone: null },
  ...o,
});

describe("anti-fraud verdict", () => {
  it("a paid first order from a different person is credited", () => {
    expect(evaluateReferral(order(), referrer, 0)).toEqual({ kind: "credit" });
  });
  it("unknown code", () => {
    expect(evaluateReferral(order(), null, 0)).toEqual({ kind: "reject", reason: "unknown-code" });
  });
  it("not paid yet → wait (nothing recorded)", () => {
    expect(evaluateReferral(order({ financialStatus: "PENDING" }), referrer, 0).kind).toBe("wait");
    expect(evaluateReferral(order({ financialStatus: "AUTHORIZED" }), referrer, 0).kind).toBe("wait");
  });
  it("cancelled / refunded / test", () => {
    expect(evaluateReferral(order({ cancelled: true }), referrer, 0)).toEqual({ kind: "reject", reason: "cancelled" });
    expect(evaluateReferral(order({ financialStatus: "VOIDED" }), referrer, 0)).toEqual({ kind: "reject", reason: "cancelled" });
    expect(evaluateReferral(order({ financialStatus: "REFUNDED" }), referrer, 0)).toEqual({ kind: "reject", reason: "refunded" });
    expect(evaluateReferral(order({ financialStatus: "PARTIALLY_REFUNDED" }), referrer, 0)).toEqual({ kind: "reject", reason: "refunded" });
    expect(evaluateReferral(order({ test: true }), referrer, 0)).toEqual({ kind: "reject", reason: "test-order" });
  });
  it("self-referral: same customer, same normalised email (gmail dots/+tags), same phone, same address", () => {
    expect(evaluateReferral(order({ customerId: "gid://shopify/Customer/1" }), referrer, 0)).toEqual({ kind: "reject", reason: "same-customer" });
    expect(evaluateReferral(order({ email: "jeantremblay@googlemail.com" }), referrer, 0)).toEqual({ kind: "reject", reason: "same-email" });
    expect(evaluateReferral(order({ phone: "+1 514-555-0123" }), referrer, 0)).toEqual({ kind: "reject", reason: "same-phone" });
    expect(evaluateReferral(order({ phone: null, shippingAddress: { address1: "1", zip: "A1A1A1", phone: "514 555 0123" } }), referrer, 0)).toEqual({ kind: "reject", reason: "same-phone" });
    expect(evaluateReferral(order({ shippingAddress: { address1: "123, Saint-Denis", zip: "h2x 1k5" } }), referrer, 0)).toEqual({ kind: "reject", reason: "same-address" });
  });
  it("not the friend's first order", () => {
    expect(evaluateReferral(order(), referrer, 1)).toEqual({ kind: "reject", reason: "not-first-order" });
  });
  it("referrer already has 5 credits", () => {
    expect(evaluateReferral(order(), { ...referrer, credits: 5 }, 0)).toEqual({ kind: "reject", reason: "max-credits" });
    expect(evaluateReferral(order(), { ...referrer, credits: 4 }, 0)).toEqual({ kind: "credit" });
  });
  it("revocation on refund or cancel", () => {
    expect(shouldRevoke({ cancelled: false, financialStatus: "PAID" })).toBe(false);
    expect(shouldRevoke({ cancelled: false, financialStatus: "REFUNDED" })).toBe(true);
    expect(shouldRevoke({ cancelled: true, financialStatus: "PAID" })).toBe(true);
  });
});

describe("launch eligibility", () => {
  const enrolled = { customerIds: new Set<string>(["gid://shopify/Customer/5"]), emailKeys: new Set<string>(["deja@x.ca"]) };
  const buyers = new Set(["gid://shopify/Customer/1"]);
  const c = (o: Partial<Parameters<typeof shopifyEligibility>[0]> = {}) => ({ id: "gid://shopify/Customer/1", email: "a@x.ca", phone: null, locale: "fr", marketingState: "NOT_SUBSCRIBED", addresses: [], ...o });
  it("a recent buyer (implied consent) or a subscriber is eligible", () => {
    expect(shopifyEligibility(c(), buyers, enrolled)).toEqual({ ok: true, source: "buyer" });
    expect(shopifyEligibility(c({ id: "gid://shopify/Customer/2", marketingState: "SUBSCRIBED" }), buyers, enrolled)).toEqual({ ok: true, source: "subscriber" });
  });
  it("unsubscribed, no email, neither, already enrolled → excluded", () => {
    expect(shopifyEligibility(c({ marketingState: "UNSUBSCRIBED" }), buyers, enrolled)).toMatchObject({ ok: false, reason: "shopify-unsubscribed" });
    expect(shopifyEligibility(c({ email: null }), buyers, enrolled)).toMatchObject({ ok: false, reason: "no-email" });
    expect(shopifyEligibility(c({ id: "gid://shopify/Customer/3" }), buyers, enrolled)).toMatchObject({ ok: false, reason: "not-buyer-nor-subscriber" });
    expect(shopifyEligibility(c({ id: "gid://shopify/Customer/5" }), buyers, enrolled)).toMatchObject({ ok: false, reason: "already-enrolled" });
    expect(shopifyEligibility(c({ email: "Deja@X.ca" }), buyers, enrolled)).toMatchObject({ ok: false, reason: "already-enrolled" });
  });
  it("Klaviyo: unsubscribed or suppressed blocks; never-subscribed does not", () => {
    expect(klaviyoBlocks({ consent: "UNSUBSCRIBED" })).toBe(true);
    expect(klaviyoBlocks({ consent: "NEVER_SUBSCRIBED", suppression: [{ reason: "HARD_BOUNCE" }] })).toBe(true);
    expect(klaviyoBlocks({ consent: "NEVER_SUBSCRIBED", suppression: [] })).toBe(false);
    expect(klaviyoBlocks(null)).toBe(false);
  });
  it("templates: valid Klaviyo unsubscribe in both languages, team signature, no supplier name", () => {
    for (const f of ["parrainage-merci.html", "parrainage-credit.html"]) {
      const html = fs.readFileSync(path.join(process.cwd(), "docs", "klaviyo", f), "utf8");
      expect(html).toContain("{% unsubscribe 'Se désabonner' %}");
      expect(html).toContain("{% unsubscribe 'Unsubscribe' %}");
      expect(html).toContain("L'équipe Ameublo Direct");
      expect(html).toContain("The Furnish Direct team");
      expect(html).not.toMatch(/aosom|costway/i);
      expect(html).toMatch(/\$ ou plus \(avant taxes\)/);
      expect(html).toMatch(/or more \(before taxes\)/);
    }
  });
  it("profile import never touches consent", () => {
    const b = profileImportBody("a@x.ca", { code: "MERCI10-A", code_ami: "AMI-A", langue: "fr", code_expire: "x", code_ami_expire: "y" });
    expect(JSON.stringify(b)).not.toMatch(/subscri|consent/i);
    expect(b.data.attributes.properties.parrainage.code_ami).toBe("AMI-A");
  });
});
