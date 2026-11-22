/**
 * Shopify side of the offre de remerciement: one unique, single-use percentage code per offered variant, valid until
 * the offer's expiry, combinable with shipping discounts only (never with the 2nd-item promo or BIENVENUE20), plus the
 * nightly cleanup of expired MERCI codes so the discount list does not grow forever.
 */
import crypto from "crypto";
import { shopifyFetch } from "@/lib/shopify-client";
import { MAX_DISCOUNT } from "@/lib/sell-price-rule";
import { discountAmount } from "./offer-rules";

export const CODE_PREFIX = "MERCI-";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export function generateMerciCode(): string {
  let s = "";
  for (let i = 0; i < 7; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `${CODE_PREFIX}${s}`;
}

/**
 * The offer is "X % on ONE article". A percentage code would take X % off every unit of the variant in the cart, so the
 * code is a fixed amount (price × X %) taken ONCE per order (appliesOnEachItem: false) on that variant only, with a
 * minimum subtotal of the variant's price — amount / minimum = X %, which keeps the margin guard's bound ≤ MAX_DISCOUNT.
 */
export function merciDiscountInput(code: string, v: { variantId: string; pct: number; price: number; orderName: string | null }, now: Date, endsAt: Date) {
  if (!(v.pct > 0) || v.pct / 100 > MAX_DISCOUNT + 1e-9) throw new Error(`merci: ${v.pct} % exceeds MAX_DISCOUNT`);
  if (!(v.price > 0)) throw new Error("merci: price required");
  const amount = discountAmount(v.price, v.pct);
  return {
    // Title starts with the code (MERCI-…) so the cleanup can find these by prefix.
    title: `${code} — Offre de remerciement${v.orderName ? ` — ${v.orderName}` : ""}`,
    code,
    startsAt: now.toISOString(),
    endsAt: endsAt.toISOString(),
    customerSelection: { all: true },
    customerGets: {
      value: { discountAmount: { amount: amount.toFixed(2), appliesOnEachItem: false } },
      items: { products: { productVariantsToAdd: [`gid://shopify/ProductVariant/${v.variantId}`] } },
    },
    minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: v.price.toFixed(2) } },
    usageLimit: 1,
    appliesOncePerCustomer: true,
    combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
  };
}

const CREATE_MUTATION = `mutation merciCode($d: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $d) {
    codeDiscountNode { id }
    userErrors { field message code }
  }
}`;

export async function createMerciDiscount(v: { variantId: string; pct: number; price: number; orderName: string | null }, now: Date, endsAt: Date): Promise<{ code: string; discountId: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const code = generateMerciCode();
    const input = merciDiscountInput(code, v, now, endsAt);
    const res = await shopifyFetch("/graphql.json", { method: "POST", body: JSON.stringify({ query: CREATE_MUTATION, variables: { d: input } }) });
    const j = (await res.json()) as {
      data?: { discountCodeBasicCreate?: { codeDiscountNode: { id: string } | null; userErrors: { field?: string[]; message: string; code?: string }[] } };
      errors?: unknown;
    };
    const out = j.data?.discountCodeBasicCreate;
    if (!res.ok || j.errors || !out) throw new Error(`merci discountCodeBasicCreate failed: ${JSON.stringify(j.errors ?? res.status).slice(0, 300)}`);
    if (out.codeDiscountNode) return { code, discountId: out.codeDiscountNode.id };
    const taken = out.userErrors.some((e) => e.code === "TAKEN" || /taken|unique/i.test(e.message));
    if (!taken) throw new Error(`merci discountCodeBasicCreate userErrors: ${JSON.stringify(out.userErrors).slice(0, 300)}`);
  }
  throw new Error("merci discountCodeBasicCreate: code collision twice");
}

// ─── Cleanup ──────────────────────────────────────────────────────────────

/** Codes ended more than this long ago are deleted (kept a little for support questions). */
export const CLEANUP_AFTER_MS = 2 * 86_400_000;
const MAX_DELETES_PER_RUN = 100;

interface ExpiredNode {
  id: string;
  title: string;
  endsAt: string | null;
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await shopifyFetch("/graphql.json", { method: "POST", body: JSON.stringify({ query, variables }) });
  const j = (await res.json()) as { data?: T; errors?: unknown };
  if (!res.ok || j.errors || !j.data) throw new Error(`merci cleanup GraphQL failed: ${JSON.stringify(j.errors ?? res.status).slice(0, 300)}`);
  return j.data;
}

/** Which of these discount nodes may be deleted: ours (title prefix) and ended before `cutoff`. */
export function deletableMerciNodes(nodes: ExpiredNode[], cutoff: Date): ExpiredNode[] {
  return nodes.filter((n) => n.title.startsWith(CODE_PREFIX) && n.endsAt != null && new Date(n.endsAt).getTime() < cutoff.getTime());
}

/** Delete MERCI codes that ended over 2 days ago. `dryRun` lists them without deleting. */
export async function cleanupExpiredMerciCodes(opts: { dryRun?: boolean; now?: Date } = {}): Promise<{ found: number; deleted: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - CLEANUP_AFTER_MS);
  const nodes: ExpiredNode[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const d: { codeDiscountNodes: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ id: string; codeDiscount: { title?: string; endsAt?: string | null } }> } } = await gql(
      `query($a: String) { codeDiscountNodes(first: 100, after: $a, query: "title:${CODE_PREFIX}* AND status:expired") {
        pageInfo { hasNextPage endCursor }
        nodes { id codeDiscount { ... on DiscountCodeBasic { title endsAt } } }
      } }`,
      { a: after },
    );
    for (const n of d.codeDiscountNodes.nodes) nodes.push({ id: n.id, title: n.codeDiscount.title ?? "", endsAt: n.codeDiscount.endsAt ?? null });
    if (!d.codeDiscountNodes.pageInfo.hasNextPage || !d.codeDiscountNodes.pageInfo.endCursor) break;
    after = d.codeDiscountNodes.pageInfo.endCursor;
  }
  const doomed = deletableMerciNodes(nodes, cutoff).slice(0, MAX_DELETES_PER_RUN);
  if (opts.dryRun) return { found: doomed.length, deleted: 0 };
  let deleted = 0;
  for (const n of doomed) {
    const out: { discountCodeDelete: { deletedCodeDiscountId: string | null; userErrors: { message: string }[] } } = await gql(
      `mutation($id: ID!) { discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { message } } }`,
      { id: n.id },
    );
    if (out.discountCodeDelete.deletedCodeDiscountId) deleted++;
    else console.warn(`[merci] could not delete ${n.id}: ${JSON.stringify(out.discountCodeDelete.userErrors)}`);
  }
  return { found: doomed.length, deleted };
}
