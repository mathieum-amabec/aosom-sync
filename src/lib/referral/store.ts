/** Turso access for the programme de parrainage: `referrals` (enrolled customers) and `referral_uses` (friend orders). */
import { ensureSchema } from "@/lib/database";
import type { Referrer } from "./rules";

function parseList(v: unknown): string[] {
  if (v == null) return [];
  try {
    const a = JSON.parse(String(v));
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

function toReferrer(row: Record<string, unknown>): Referrer {
  return {
    id: Number(row.id),
    customerId: row.customer_id == null ? null : String(row.customer_id),
    email: String(row.email),
    lang: String(row.lang) === "en" ? "en" : "fr",
    friendCode: String(row.friend_code ?? ""),
    credits: Number(row.credits ?? 0),
    phoneHashes: parseList(row.phone_hashes),
    addressHashes: parseList(row.address_hashes),
  };
}

export async function getReferrerByFriendCode(code: string): Promise<Referrer | null> {
  const db = await ensureSchema();
  const r = await db.execute({ sql: `SELECT * FROM referrals WHERE friend_code = ?`, args: [code.trim().toUpperCase()] });
  return r.rows[0] ? toReferrer(r.rows[0] as unknown as Record<string, unknown>) : null;
}

export interface NewReferral {
  customerId: string | null;
  emailKey: string;
  email: string;
  lang: "fr" | "en";
  personalCode: string;
  personalDiscountId: string;
  personalExpiresAt: number;
  friendCode: string;
  friendDiscountId: string;
  friendExpiresAt: number;
  phoneHashes: string[];
  addressHashes: string[];
  source: string;
}

/** Enrol one customer. False when that customer (id or normalised email) is already enrolled. */
export async function insertReferral(n: NewReferral, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const db = await ensureSchema();
  const r = await db.execute({
    sql: `INSERT INTO referrals (customer_id, email_key, email, lang, personal_code, personal_discount_id, personal_expires_at,
            friend_code, friend_discount_id, friend_expires_at, credits, phone_hashes, address_hashes, source, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    args: [
      n.customerId, n.emailKey, n.email, n.lang, n.personalCode, n.personalDiscountId, n.personalExpiresAt,
      n.friendCode, n.friendDiscountId, n.friendExpiresAt, JSON.stringify(n.phoneHashes), JSON.stringify(n.addressHashes), n.source, nowSec,
    ],
  });
  return r.rowsAffected === 1;
}

export interface UnsyncedReferral {
  id: number;
  email: string;
  lang: "fr" | "en";
  personalCode: string;
  personalExpiresAt: number;
  friendCode: string;
  friendExpiresAt: number;
}

/** Enrolled customers whose codes are not on their Klaviyo profile yet (a launch run failed half-way). */
export async function unsyncedReferrals(): Promise<UnsyncedReferral[]> {
  const db = await ensureSchema();
  const r = await db.execute(`SELECT id, email, lang, personal_code, personal_expires_at, friend_code, friend_expires_at FROM referrals WHERE klaviyo_synced = 0 ORDER BY id`);
  return r.rows.map((row) => ({
    id: Number(row.id),
    email: String(row.email),
    lang: String(row.lang) === "en" ? ("en" as const) : ("fr" as const),
    personalCode: String(row.personal_code),
    personalExpiresAt: Number(row.personal_expires_at),
    friendCode: String(row.friend_code),
    friendExpiresAt: Number(row.friend_expires_at),
  }));
}

export async function markKlaviyoSynced(id: number): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `UPDATE referrals SET klaviyo_synced = 1 WHERE id = ?`, args: [id] });
}

/** Customer ids and email keys already enrolled (the launch script skips them). */
export async function enrolledKeys(): Promise<{ customerIds: Set<string>; emailKeys: Set<string> }> {
  const db = await ensureSchema();
  const r = await db.execute(`SELECT customer_id, email_key FROM referrals`);
  const customerIds = new Set<string>();
  const emailKeys = new Set<string>();
  for (const row of r.rows) {
    if (row.customer_id != null) customerIds.add(String(row.customer_id));
    emailKeys.add(String(row.email_key));
  }
  return { customerIds, emailKeys };
}

/** Order ids already decided (any verdict, pending included): the cron never looks at them again. */
export async function knownUseOrderIds(orderIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (orderIds.length === 0) return out;
  const db = await ensureSchema();
  for (let i = 0; i < orderIds.length; i += 200) {
    const chunk = orderIds.slice(i, i + 200);
    const r = await db.execute({ sql: `SELECT order_id FROM referral_uses WHERE order_id IN (${chunk.map(() => "?").join(",")})`, args: chunk });
    for (const row of r.rows) out.add(String(row.order_id));
  }
  return out;
}

/** Reserve the order under `claim` (verdict 'pending'). False when the order already has a row. */
export async function reserveUse(v: { orderId: string; orderName: string; friendCode: string; referralId: number | null; claim: string }, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const db = await ensureSchema();
  const r = await db.execute({
    sql: `INSERT INTO referral_uses (order_id, order_name, friend_code, referral_id, verdict, claim, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT(order_id) DO NOTHING`,
    args: [v.orderId, v.orderName, v.friendCode, v.referralId, v.claim, nowSec, nowSec],
  });
  return r.rowsAffected === 1;
}

/** Record a final rejection (only while this request owns the pending row). */
export async function rejectUse(orderId: string, claim: string, reason: string, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const db = await ensureSchema();
  const r = await db.execute({
    sql: `UPDATE referral_uses SET verdict = 'rejected', reason = ?, updated_at = ? WHERE order_id = ? AND verdict = 'pending' AND claim = ?`,
    args: [reason, nowSec, orderId, claim],
  });
  return r.rowsAffected === 1;
}

/** Record the credit (only while this request owns the pending row). */
export async function creditUse(
  orderId: string,
  claim: string,
  c: { code: string; discountId: string; expiresAt: number },
  nowSec = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const db = await ensureSchema();
  const r = await db.execute({
    sql: `UPDATE referral_uses SET verdict = 'credited', credit_code = ?, credit_discount_id = ?, credit_expires_at = ?, updated_at = ?
          WHERE order_id = ? AND verdict = 'pending' AND claim = ?`,
    args: [c.code, c.discountId, c.expiresAt, nowSec, orderId, claim],
  });
  return r.rowsAffected === 1;
}

/** Undo this request's reservation (the credit code could not be created) so the next run retries. */
export async function releaseUse(orderId: string, claim: string): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `DELETE FROM referral_uses WHERE order_id = ? AND verdict = 'pending' AND claim = ?`, args: [orderId, claim] });
}

export async function markNotified(orderId: string): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `UPDATE referral_uses SET notified = 1 WHERE order_id = ?`, args: [orderId] });
}

/**
 * Take one of the referrer's credit slots, atomically: false when they already have MAX credits. Called BEFORE the
 * Shopify code is created, so two orders in a row can never push a referrer past the cap.
 */
export async function takeCreditSlot(referralId: number, max: number): Promise<boolean> {
  const db = await ensureSchema();
  const r = await db.execute({ sql: `UPDATE referrals SET credits = credits + 1 WHERE id = ? AND credits < ?`, args: [referralId, max] });
  return r.rowsAffected === 1;
}

export async function giveBackCreditSlot(referralId: number): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `UPDATE referrals SET credits = MAX(credits - 1, 0) WHERE id = ?`, args: [referralId] });
}

export interface CreditedUse {
  orderId: string;
  referralId: number;
  creditDiscountId: string;
  creditExpiresAt: number;
}

/** Credits still worth re-checking for a refund: credited, code not expired yet. Oldest checks first, bounded. */
export async function creditedUsesToRecheck(nowSec: number, limit: number): Promise<CreditedUse[]> {
  const db = await ensureSchema();
  const r = await db.execute({
    sql: `SELECT order_id, referral_id, credit_discount_id, credit_expires_at FROM referral_uses
          WHERE verdict = 'credited' AND credit_discount_id IS NOT NULL AND credit_expires_at > ?
          ORDER BY updated_at ASC LIMIT ?`,
    args: [nowSec, limit],
  });
  return r.rows.map((row) => ({
    orderId: String(row.order_id),
    referralId: Number(row.referral_id),
    creditDiscountId: String(row.credit_discount_id),
    creditExpiresAt: Number(row.credit_expires_at),
  }));
}

/** Rotate a re-checked credit to the back of the queue. */
export async function touchUse(orderId: string, nowSec: number): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `UPDATE referral_uses SET updated_at = ? WHERE order_id = ?`, args: [nowSec, orderId] });
}

/** The friend was refunded: the credit is withdrawn. `reason` says whether the code had been used already. */
export async function revokeUse(orderId: string, reason: string, nowSec: number): Promise<boolean> {
  const db = await ensureSchema();
  const r = await db.execute({
    sql: `UPDATE referral_uses SET verdict = 'revoked', reason = ?, updated_at = ? WHERE order_id = ? AND verdict = 'credited'`,
    args: [reason, nowSec, orderId],
  });
  return r.rowsAffected === 1;
}

/** Rows stuck in 'pending' (a run crashed between reserving and recording): reported for a human, never auto-retried. */
export async function stuckPendingCount(olderThanSec: number, nowSec: number): Promise<number> {
  const db = await ensureSchema();
  const r = await db.execute({ sql: `SELECT COUNT(*) AS n FROM referral_uses WHERE verdict = 'pending' AND created_at < ?`, args: [nowSec - olderThanSec] });
  return Number(r.rows[0]?.n ?? 0);
}
