/** The referral-credits engine against the REAL Turso store (in-memory libsql) with Shopify and Klaviyo mocked. */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import type { Client } from "@libsql/client";
import type { ReferralCreditDeps } from "@/lib/referral/credits";
import type { ReferralOrder } from "@/lib/referral/rules";

process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "test";

let db: Client;
let store: typeof import("@/lib/referral/store");
let engine: typeof import("@/lib/referral/credits");
let rules: typeof import("@/lib/referral/rules");

beforeAll(async () => {
  const mod = await import("@/lib/database");
  db = await mod.ensureSchema();
  store = await import("@/lib/referral/store");
  engine = await import("@/lib/referral/credits");
  rules = await import("@/lib/referral/rules");
});

const NOW = new Date("2026-12-01T15:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

const order = (n: number, o: Partial<ReferralOrder> = {}): ReferralOrder => ({
  id: `gid://shopify/Order/${n}`,
  name: `#${n}`,
  createdAt: "2026-12-01T12:00:00Z",
  cancelled: false,
  test: false,
  financialStatus: "PAID",
  discountCodes: ["AMI-ABC234"],
  email: `ami${n}@example.com`,
  phone: null,
  customerId: `gid://shopify/Customer/${100 + n}`,
  shippingAddress: { address1: `${n} rue des Érables`, zip: "G1R 2B3" },
  ...o,
});

let orders: ReferralOrder[];
let codeSeq: number;

function deps(over: Partial<ReferralCreditDeps> = {}): ReferralCreditDeps {
  return {
    getSetting: vi.fn(async () => null),
    fetchFriendOrders: vi.fn(async () => orders),
    knownUseOrderIds: store.knownUseOrderIds,
    getReferrerByFriendCode: store.getReferrerByFriendCode,
    fetchCustomerIdentity: vi.fn(async () => ({ phones: [], addresses: [] })),
    countPriorOrders: vi.fn(async () => 0),
    reserveUse: (v) => store.reserveUse(v, NOW_S),
    rejectUse: (id, c, r) => store.rejectUse(id, c, r, NOW_S),
    creditUse: (id, c, x) => store.creditUse(id, c, x, NOW_S),
    releaseUse: store.releaseUse,
    markNotified: store.markNotified,
    takeCreditSlot: store.takeCreditSlot,
    giveBackCreditSlot: store.giveBackCreditSlot,
    createCreditCode: vi.fn(async () => ({ code: `MERCI10-C${++codeSeq}`, discountId: `gid://shopify/DiscountCodeNode/${codeSeq}`, endsAt: "2027-01-30T15:00:00.000Z" })),
    notifyCredit: vi.fn(async () => ({ ok: true })),
    creditedUsesToRecheck: store.creditedUsesToRecheck,
    fetchOrderStatus: vi.fn(async () => ({ cancelled: false, financialStatus: "PAID" })),
    discountUsage: vi.fn(async () => 0),
    deactivateDiscount: vi.fn(async () => {}),
    revokeUse: store.revokeUse,
    touchUse: store.touchUse,
    stuckPendingCount: store.stuckPendingCount,
    randomClaim: () => Math.random().toString(36).slice(2),
    ...over,
  };
}

async function enrol(credits = 0) {
  await store.insertReferral({
    customerId: "gid://shopify/Customer/1",
    emailKey: "parrain@example.com",
    email: "parrain@example.com",
    lang: "fr",
    personalCode: "MERCI10-P00001",
    personalDiscountId: "gid://shopify/DiscountCodeNode/p",
    personalExpiresAt: NOW_S + 60 * 86400,
    friendCode: "AMI-ABC234",
    friendDiscountId: "gid://shopify/DiscountCodeNode/f",
    friendExpiresAt: NOW_S + 90 * 86400,
    phoneHashes: [rules.identityHash("5145550123")],
    addressHashes: [],
    source: "buyer",
  }, NOW_S);
  if (credits) await db.execute({ sql: `UPDATE referrals SET credits = ?`, args: [credits] });
}

const credits = async () => Number((await db.execute(`SELECT credits FROM referrals`)).rows[0].credits);
const uses = async () => (await db.execute(`SELECT * FROM referral_uses ORDER BY order_id`)).rows;

beforeEach(async () => {
  await db.execute(`DELETE FROM referral_uses`);
  await db.execute(`DELETE FROM referrals`);
  orders = [order(1)];
  codeSeq = 0;
});

describe("runReferralCredits", () => {
  it("off by default: reads the setting and does nothing else", async () => {
    await enrol();
    const d = deps();
    const r = await engine.runReferralCredits({ deps: d, now: NOW });
    expect(r.mode).toBe("off");
    expect(d.fetchFriendOrders).not.toHaveBeenCalled();
    expect(d.createCreditCode).not.toHaveBeenCalled();
  });

  it("dry creates nothing: no Shopify code, no Klaviyo event, no Turso row", async () => {
    await enrol();
    orders = [order(1), order(2, { email: "parrain@example.com" })];
    const d = deps();
    const r = await engine.runReferralCredits({ deps: d, mode: "dry", now: NOW });
    expect(r.credited).toBe(1);
    expect(r.rejected).toBe(1);
    expect(d.createCreditCode).not.toHaveBeenCalled();
    expect(d.notifyCredit).not.toHaveBeenCalled();
    expect(d.deactivateDiscount).not.toHaveBeenCalled();
    expect(await uses()).toHaveLength(0);
    expect(await credits()).toBe(0);
  });

  it("live credits a valid friend order once, emails the referrer without naming the friend", async () => {
    await enrol();
    const d = deps();
    const r = await engine.runReferralCredits({ deps: d, mode: "live", now: NOW });
    expect(r.credited).toBe(1);
    expect(d.createCreditCode).toHaveBeenCalledTimes(1);
    expect(d.notifyCredit).toHaveBeenCalledTimes(1);
    const [email, props] = vi.mocked(d.notifyCredit).mock.calls[0];
    expect(email).toBe("parrain@example.com");
    expect(JSON.stringify(props)).not.toMatch(/ami1|example\.com|#1|Érables/);
    expect(props).toMatchObject({ code: "MERCI10-C1", montant: 10, minimum: 100, langue: "fr" });
    const rows = await uses();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verdict: "credited", credit_code: "MERCI10-C1", notified: 1 });
    expect(await credits()).toBe(1);
  });

  it("idempotent per order: a second run (or a double fire) never credits the same order again", async () => {
    await enrol();
    const d = deps();
    await engine.runReferralCredits({ deps: d, mode: "live", now: NOW });
    const again = await engine.runReferralCredits({ deps: d, mode: "live", now: NOW });
    expect(again.alreadyDecided).toBe(1);
    expect(again.credited).toBe(0);
    expect(d.createCreditCode).toHaveBeenCalledTimes(1);
    expect(await credits()).toBe(1);
  });

  it("concurrent runs: only one reserves the order", async () => {
    await enrol();
    const d = deps();
    const [a, b] = await Promise.all([
      engine.runReferralCredits({ deps: d, mode: "live", now: NOW }),
      engine.runReferralCredits({ deps: d, mode: "live", now: NOW }),
    ]);
    expect(a.credited + b.credited).toBe(1);
    expect(d.createCreditCode).toHaveBeenCalledTimes(1);
  });

  it("rejections are recorded once with their reason; unpaid orders are left for a later run", async () => {
    await enrol();
    orders = [
      order(1, { phone: "+1 514 555 0123" }),
      order(2, { financialStatus: "PENDING" }),
      order(3, { discountCodes: ["AMI-ZZZZZZ"] }),
    ];
    const d = deps({ countPriorOrders: vi.fn(async () => 0) });
    const r = await engine.runReferralCredits({ deps: d, mode: "live", now: NOW });
    expect(r).toMatchObject({ credited: 0, rejected: 2, waiting: 1 });
    const rows = await uses();
    expect(rows.map((x) => [x.order_id, x.verdict, x.reason])).toEqual([
      ["gid://shopify/Order/1", "rejected", "same-phone"],
      ["gid://shopify/Order/3", "rejected", "unknown-code"],
    ]);
  });

  it("not the friend's first order → rejected (prior-order search only paid when the rest passes)", async () => {
    await enrol();
    const d = deps({ countPriorOrders: vi.fn(async () => 2) });
    const r = await engine.runReferralCredits({ deps: d, mode: "live", now: NOW });
    expect(r.rejected).toBe(1);
    expect((await uses())[0]).toMatchObject({ reason: "not-first-order" });
  });

  it("the referrer's LIVE Shopify address catches a self-referral", async () => {
    await enrol();
    orders = [order(1, { shippingAddress: { address1: "77 boul. René-Lévesque", zip: "H3B 1X9" } })];
    const d = deps({ fetchCustomerIdentity: vi.fn(async () => ({ phones: [], addresses: [{ address1: "77 René Lévesque", zip: "h3b1x9" }] })) });
    await engine.runReferralCredits({ deps: d, mode: "live", now: NOW });
    expect((await uses())[0]).toMatchObject({ verdict: "rejected", reason: "same-address" });
  });

  it("max 5 credits per referrer", async () => {
    await enrol(4);
    orders = [order(1), order(2)];
    const d = deps();
    const r = await engine.runReferralCredits({ deps: d, mode: "live", now: NOW });
    expect(r.credited).toBe(1);
    expect(r.rejected).toBe(1);
    expect(d.createCreditCode).toHaveBeenCalledTimes(1);
    expect(await credits()).toBe(5);
  });

  it("a failed code creation releases the order and the slot, so the next run retries", async () => {
    await enrol();
    const d = deps({ createCreditCode: vi.fn(async () => { throw new Error("shopify down"); }) });
    const r = await engine.runReferralCredits({ deps: d, mode: "live", now: NOW });
    expect(r.failed).toBe(1);
    expect(await uses()).toHaveLength(0);
    expect(await credits()).toBe(0);
  });

  it("a failed lookup decides nothing (fail closed)", async () => {
    await enrol();
    const d = deps({ countPriorOrders: vi.fn(async () => { throw new Error("timeout"); }) });
    const r = await engine.runReferralCredits({ deps: d, mode: "live", now: NOW });
    expect(r.failed).toBe(1);
    expect(d.createCreditCode).not.toHaveBeenCalled();
    expect(await uses()).toHaveLength(0);
  });

  it("friend refunded before the credit was used → credit deactivated, slot given back", async () => {
    await enrol();
    const d = deps();
    await engine.runReferralCredits({ deps: d, mode: "live", now: NOW });
    orders = [];
    const d2 = deps({ fetchOrderStatus: vi.fn(async () => ({ cancelled: false, financialStatus: "REFUNDED" })), discountUsage: vi.fn(async () => 0) });
    const r = await engine.runReferralCredits({ deps: d2, mode: "live", now: NOW });
    expect(r.revoked).toBe(1);
    expect(d2.deactivateDiscount).toHaveBeenCalledWith("gid://shopify/DiscountCodeNode/1");
    expect((await uses())[0]).toMatchObject({ verdict: "revoked", reason: "refunded" });
    expect(await credits()).toBe(0);
  });

  it("refund after the credit was spent: recorded, nothing to deactivate, slot kept", async () => {
    await enrol();
    await engine.runReferralCredits({ deps: deps(), mode: "live", now: NOW });
    orders = [];
    const d2 = deps({ fetchOrderStatus: vi.fn(async () => ({ cancelled: true, financialStatus: "REFUNDED" })), discountUsage: vi.fn(async () => 1) });
    await engine.runReferralCredits({ deps: d2, mode: "live", now: NOW });
    expect(d2.deactivateDiscount).not.toHaveBeenCalled();
    expect((await uses())[0]).toMatchObject({ verdict: "revoked", reason: "refunded-after-use" });
    expect(await credits()).toBe(1);
  });

  it("dry never deactivates a credit", async () => {
    await enrol();
    await engine.runReferralCredits({ deps: deps(), mode: "live", now: NOW });
    orders = [];
    const d2 = deps({ fetchOrderStatus: vi.fn(async () => ({ cancelled: false, financialStatus: "REFUNDED" })) });
    const r = await engine.runReferralCredits({ deps: d2, mode: "dry", now: NOW });
    expect(r.revoked).toBe(1);
    expect(d2.deactivateDiscount).not.toHaveBeenCalled();
    expect((await uses())[0]).toMatchObject({ verdict: "credited" });
  });
});
