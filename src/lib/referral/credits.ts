/**
 * Hourly referrer credits (cron /api/cron/referral-credits). Reads the orders of the last LOOKBACK_HOURS that carry
 * an AMI- code, decides each ONCE (table `referral_uses`), and for a valid friend order gives the referrer a new
 * MERCI10- code + the Klaviyo event that sends « Votre ami a commandé ». Then re-checks recent credits and withdraws
 * one whose friend order was refunded or cancelled before the referrer used it.
 *
 * Mode `settings.referral_mode` = off | dry | live, DEFAULT off. dry = the same plan, reported, with NO write at all
 * (no Turso row, no Shopify code, no Klaviyo event). Everything external is injected (`deps`) so tests run on mocks.
 */
import {
  LOOKBACK_HOURS,
  MAX_CREDITS_PER_REFERRER,
  REFERRAL_AMOUNT,
  REFERRAL_MIN_SUBTOTAL,
  REFERRAL_MODE_KEY,
  addressKey,
  evaluateReferral,
  formatExpiry,
  friendCodeOf,
  identityHash,
  normalizePhone,
  parseReferralMode,
  shouldRevoke,
  type AddressLike,
  type ReferralMode,
  type ReferralOrder,
  type Referrer,
  type Verdict,
} from "./rules";
import type { CreditedUse } from "./store";

/** Credits re-checked for a refund per run (each costs 1–3 Shopify calls). */
export const RECHECK_PER_RUN = 25;
/** A 'pending' row older than this means a run crashed mid-way: reported, never auto-retried (no double credit). */
const STUCK_AFTER_S = 3600;

export const CREDIT_EVENT = "Parrainage — crédit";

export interface ReferralCreditDeps {
  getSetting(key: string): Promise<string | null>;
  fetchFriendOrders(sinceIso: string): Promise<ReferralOrder[]>;
  knownUseOrderIds(orderIds: string[]): Promise<Set<string>>;
  getReferrerByFriendCode(code: string): Promise<Referrer | null>;
  fetchCustomerIdentity(customerGid: string): Promise<{ phones: string[]; addresses: AddressLike[] } | null>;
  countPriorOrders(o: ReferralOrder): Promise<number>;
  reserveUse(v: { orderId: string; orderName: string; friendCode: string; referralId: number | null; claim: string }): Promise<boolean>;
  rejectUse(orderId: string, claim: string, reason: string): Promise<boolean>;
  creditUse(orderId: string, claim: string, c: { code: string; discountId: string; expiresAt: number }): Promise<boolean>;
  releaseUse(orderId: string, claim: string): Promise<void>;
  markNotified(orderId: string): Promise<void>;
  takeCreditSlot(referralId: number, max: number): Promise<boolean>;
  giveBackCreditSlot(referralId: number): Promise<void>;
  createCreditCode(): Promise<{ code: string; discountId: string; endsAt: string }>;
  notifyCredit(email: string, props: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  creditedUsesToRecheck(nowSec: number, limit: number): Promise<CreditedUse[]>;
  fetchOrderStatus(orderGid: string): Promise<{ cancelled: boolean; financialStatus: string } | null>;
  discountUsage(discountGid: string): Promise<number | null>;
  deactivateDiscount(discountGid: string): Promise<void>;
  revokeUse(orderId: string, reason: string, nowSec: number): Promise<boolean>;
  touchUse(orderId: string, nowSec: number): Promise<void>;
  stuckPendingCount(olderThanSec: number, nowSec: number): Promise<number>;
  randomClaim(): string;
}

export interface OrderDecision {
  order: string;
  verdict: Verdict["kind"] | "skipped";
  reason?: string;
}

export interface ReferralCreditsResult {
  mode: ReferralMode;
  ordersSeen: number;
  alreadyDecided: number;
  decisions: OrderDecision[];
  credited: number;
  rejected: number;
  waiting: number;
  failed: number;
  notifyFailed: number;
  rechecked: number;
  revoked: number;
  stuckPending: number;
}

function empty(mode: ReferralMode): ReferralCreditsResult {
  return { mode, ordersSeen: 0, alreadyDecided: 0, decisions: [], credited: 0, rejected: 0, waiting: 0, failed: 0, notifyFailed: 0, rechecked: 0, revoked: 0, stuckPending: 0 };
}

/** The referrer with their LIVE Shopify phones/addresses added to the stored hashes (the customer may have moved). */
async function withLiveIdentity(deps: ReferralCreditDeps, r: Referrer): Promise<Referrer> {
  if (!r.customerId) return r;
  const live = await deps.fetchCustomerIdentity(r.customerId);
  if (!live) return r;
  const phones = live.phones.map(normalizePhone).filter((p): p is string => !!p).map(identityHash);
  const addrs = live.addresses.map(addressKey).filter((a): a is string => !!a).map(identityHash);
  return { ...r, phoneHashes: [...new Set([...r.phoneHashes, ...phones])], addressHashes: [...new Set([...r.addressHashes, ...addrs])] };
}

export async function runReferralCredits(opts: { deps: ReferralCreditDeps; mode?: ReferralMode; now?: Date }): Promise<ReferralCreditsResult> {
  const { deps } = opts;
  const now = opts.now ?? new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const mode = opts.mode ?? parseReferralMode(await deps.getSetting(REFERRAL_MODE_KEY));
  const out = empty(mode);
  if (mode === "off") return out;
  const live = mode === "live";

  const since = new Date(now.getTime() - LOOKBACK_HOURS * 3600_000).toISOString();
  const orders = await deps.fetchFriendOrders(since);
  out.ordersSeen = orders.length;
  const known = await deps.knownUseOrderIds(orders.map((o) => o.id));

  for (const order of orders) {
    if (known.has(order.id)) {
      out.alreadyDecided++;
      continue;
    }
    const code = friendCodeOf(order.discountCodes);
    if (!code) continue;
    let verdict: Verdict;
    let referrer: Referrer | null = null;
    try {
      const stored = await deps.getReferrerByFriendCode(code);
      referrer = stored ? await withLiveIdentity(deps, stored) : null;
      // Cheap rules first; the prior-order search is only paid for an order that would otherwise be credited.
      verdict = evaluateReferral(order, referrer, 0);
      if (verdict.kind === "credit") verdict = evaluateReferral(order, referrer, await deps.countPriorOrders(order));
    } catch (err) {
      // A read failed: decide nothing now (fail closed), the next hourly run looks again.
      console.warn(`[referral] ${order.name}: lookup failed — ${err instanceof Error ? err.message : String(err)}`);
      out.failed++;
      out.decisions.push({ order: order.name, verdict: "skipped", reason: "lookup-failed" });
      continue;
    }

    out.decisions.push({ order: order.name, verdict: verdict.kind, ...(verdict.kind !== "credit" ? { reason: verdict.reason } : {}) });
    if (verdict.kind === "wait") {
      out.waiting++;
      continue;
    }
    if (verdict.kind === "reject") out.rejected++;
    if (!live) {
      if (verdict.kind === "credit") out.credited++;
      continue;
    }

    const claim = deps.randomClaim();
    if (!(await deps.reserveUse({ orderId: order.id, orderName: order.name, friendCode: code, referralId: referrer?.id ?? null, claim }))) {
      // Another run took it first.
      out.alreadyDecided++;
      continue;
    }
    if (verdict.kind === "reject") {
      await deps.rejectUse(order.id, claim, verdict.reason);
      continue;
    }

    const ref = referrer as Referrer;
    if (!(await deps.takeCreditSlot(ref.id, MAX_CREDITS_PER_REFERRER))) {
      await deps.rejectUse(order.id, claim, "max-credits");
      out.rejected++;
      out.decisions[out.decisions.length - 1] = { order: order.name, verdict: "reject", reason: "max-credits" };
      continue;
    }
    let credit: { code: string; discountId: string; endsAt: string };
    try {
      credit = await deps.createCreditCode();
    } catch (err) {
      console.error(`[referral] ${order.name}: credit code creation failed — ${err instanceof Error ? err.message : String(err)}`);
      await deps.giveBackCreditSlot(ref.id);
      await deps.releaseUse(order.id, claim);
      out.failed++;
      continue;
    }
    const expiresAt = Math.floor(Date.parse(credit.endsAt) / 1000);
    await deps.creditUse(order.id, claim, { code: credit.code, discountId: credit.discountId, expiresAt });
    out.credited++;
    // Loi 25: the email never names the friend, so the event carries nothing about them.
    const sent = await deps.notifyCredit(ref.email, {
      code: credit.code,
      montant: REFERRAL_AMOUNT,
      minimum: REFERRAL_MIN_SUBTOTAL,
      expire_le: formatExpiry(credit.endsAt, ref.lang),
      langue: ref.lang,
    });
    if (sent.ok) await deps.markNotified(order.id);
    else {
      out.notifyFailed++;
      console.warn(`[referral] ${order.name}: Klaviyo event failed — ${sent.error ?? "unknown"}`);
    }
  }

  // ─── Refunds: withdraw an unused credit whose friend order was refunded or cancelled ─────────────────────
  for (const use of await deps.creditedUsesToRecheck(nowSec, RECHECK_PER_RUN)) {
    out.rechecked++;
    try {
      const st = await deps.fetchOrderStatus(use.orderId);
      if (!st || !shouldRevoke(st)) {
        if (live) await deps.touchUse(use.orderId, nowSec);
        continue;
      }
      const used = await deps.discountUsage(use.creditDiscountId);
      out.revoked++;
      if (!live) continue;
      if (used != null && used > 0) {
        // Already spent: nothing to deactivate, and the slot stays taken.
        await deps.revokeUse(use.orderId, "refunded-after-use", nowSec);
        continue;
      }
      if (used != null) await deps.deactivateDiscount(use.creditDiscountId);
      if (await deps.revokeUse(use.orderId, "refunded", nowSec)) await deps.giveBackCreditSlot(use.referralId);
    } catch (err) {
      console.warn(`[referral] recheck ${use.orderId} failed — ${err instanceof Error ? err.message : String(err)}`);
      out.failed++;
    }
  }

  out.stuckPending = await deps.stuckPendingCount(STUCK_AFTER_S, nowSec);
  return out;
}
