/** Production wiring of the referral-credits cron: Turso store + Shopify Admin + Klaviyo. */
import crypto from "crypto";
import { getSetting } from "@/lib/database";
import { dispatchEvent } from "@/lib/email/dispatch";
import type { ReferralCreditDeps } from "./credits";
import { CREDIT_EVENT } from "./credits";
import * as shop from "./shopify";
import * as store from "./store";

export function defaultReferralDeps(): ReferralCreditDeps {
  return {
    getSetting,
    fetchFriendOrders: (since) => shop.fetchFriendOrders(since),
    knownUseOrderIds: store.knownUseOrderIds,
    getReferrerByFriendCode: store.getReferrerByFriendCode,
    fetchCustomerIdentity: shop.fetchCustomerIdentity,
    countPriorOrders: shop.countPriorOrders,
    reserveUse: (v) => store.reserveUse(v),
    rejectUse: (id, claim, reason) => store.rejectUse(id, claim, reason),
    creditUse: (id, claim, c) => store.creditUse(id, claim, c),
    releaseUse: store.releaseUse,
    markNotified: store.markNotified,
    takeCreditSlot: store.takeCreditSlot,
    giveBackCreditSlot: store.giveBackCreditSlot,
    createCreditCode: () => shop.createReferralDiscount("credit"),
    // Klaviyo event (flow) by default; with settings email_provider = "resend" the email itself through Resend.
    // One email per credit code: the idem key never lets a retry mail it twice.
    notifyCredit: (email, props) => dispatchEvent(CREDIT_EVENT, email, props, { idemKey: `parrainage-credit:${String(props.code ?? "")}`, maxDelayH: 7 * 24 }),
    creditedUsesToRecheck: store.creditedUsesToRecheck,
    fetchOrderStatus: shop.fetchOrderStatus,
    discountUsage: shop.discountUsage,
    deactivateDiscount: shop.deactivateDiscount,
    revokeUse: store.revokeUse,
    touchUse: store.touchUse,
    stuckPendingCount: store.stuckPendingCount,
    randomClaim: () => crypto.randomBytes(12).toString("hex"),
  };
}
