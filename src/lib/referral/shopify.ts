/** Shopify Admin GraphQL for the programme de parrainage: friend orders, referral codes, credit revocation. */
import { shopifyFetch } from "@/lib/shopify-client";
import {
  FRIEND_PREFIX,
  generateFriendCode,
  generatePersonalCode,
  referralDiscountInput,
  type AddressLike,
  type ReferralCodeKind,
  type ReferralOrder,
} from "./rules";

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await shopifyFetch("/graphql.json", { method: "POST", body: JSON.stringify({ query, variables }) });
  const j = (await res.json()) as { data?: T; errors?: unknown };
  if (!res.ok || j.errors || !j.data) throw new Error(`referral GraphQL failed: ${JSON.stringify(j.errors ?? res.status).slice(0, 300)}`);
  return j.data;
}

/** Shopify search wants second precision. */
const noMillis = (iso: string) => iso.replace(/\.\d{3}Z$/, "Z");

type RawOrder = {
  id: string; name: string; createdAt: string; cancelledAt: string | null; test: boolean; displayFinancialStatus: string | null;
  discountCodes: string[] | null; email: string | null; phone: string | null; customer: { id: string } | null; shippingAddress: AddressLike | null;
};

export function toReferralOrder(o: RawOrder): ReferralOrder {
  return {
    id: o.id,
    name: o.name,
    createdAt: o.createdAt,
    cancelled: !!o.cancelledAt,
    test: !!o.test,
    financialStatus: o.displayFinancialStatus ?? "",
    discountCodes: o.discountCodes ?? [],
    email: o.email,
    phone: o.phone,
    customerId: o.customer?.id ?? null,
    shippingAddress: o.shippingAddress,
  };
}

const ORDERS_QUERY = `query refOrders($q: String!, $after: String) {
  orders(first: 100, after: $after, query: $q, sortKey: CREATED_AT) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id name createdAt cancelledAt test displayFinancialStatus discountCodes email phone
      customer { id }
      shippingAddress { address1 address2 city zip countryCodeV2 phone }
    }
  }
}`;

/** Every order created since `sinceIso` that carries an AMI- code (filtered here, not by Shopify search). */
export async function fetchFriendOrders(sinceIso: string, maxPages = 10): Promise<ReferralOrder[]> {
  const out: ReferralOrder[] = [];
  const since = Date.parse(sinceIso);
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const d: { orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RawOrder[] } } = await gql(ORDERS_QUERY, {
      q: `created_at:>=${noMillis(sinceIso)}`,
      after,
    });
    for (const n of d.orders.nodes) {
      if (Date.parse(n.createdAt) < since) continue;
      if ((n.discountCodes ?? []).some((c) => c.trim().toUpperCase().startsWith(FRIEND_PREFIX))) out.push(toReferralOrder(n));
    }
    if (!d.orders.pageInfo.hasNextPage || !d.orders.pageInfo.endCursor) break;
    after = d.orders.pageInfo.endCursor;
  }
  return out;
}

/** Escape a value for a Shopify search query string. */
function q(v: string): string {
  return `"${v.replace(/["\\]/g, "")}"`;
}

/**
 * The friend's orders placed BEFORE this one, by customer or by email (Shopify search is not trusted with the date
 * bound, so it is re-checked here). Cancelled ones count: a friend who already ordered once is not a new customer.
 */
export async function countPriorOrders(o: Pick<ReferralOrder, "id" | "createdAt" | "customerId" | "email">): Promise<number> {
  const terms: string[] = [];
  const custNum = o.customerId?.split("/").pop();
  if (custNum && /^\d+$/.test(custNum)) terms.push(`customer_id:${custNum}`);
  if (o.email) terms.push(`email:${q(o.email.trim())}`);
  if (terms.length === 0) return 0;
  const d: { orders: { nodes: Array<{ id: string; createdAt: string; test: boolean }> } } = await gql(
    `query refPrior($q: String!) { orders(first: 5, query: $q) { nodes { id createdAt cancelledAt test } } }`,
    { q: `(${terms.join(" OR ")}) AND created_at:<${noMillis(o.createdAt)}` },
  );
  const before = Date.parse(o.createdAt);
  return d.orders.nodes.filter((n) => n.id !== o.id && !n.test && Date.parse(n.createdAt) < before).length;
}

/** Live phones and address keys of a referrer's Shopify customer (for the self-referral check). */
export async function fetchCustomerIdentity(customerGid: string): Promise<{ phones: string[]; addresses: AddressLike[] } | null> {
  const d: { customer: { phone: string | null; addresses: AddressLike[] } | null } = await gql(
    `query refCustomer($id: ID!) { customer(id: $id) { id email phone addresses(first: 10) { address1 address2 city zip countryCodeV2 phone } } }`,
    { id: customerGid },
  );
  if (!d.customer) return null;
  const phones = [d.customer.phone, ...d.customer.addresses.map((a) => a.phone ?? null)].filter((p): p is string => !!p);
  return { phones, addresses: d.customer.addresses };
}

export async function fetchOrderStatus(orderGid: string): Promise<{ cancelled: boolean; financialStatus: string } | null> {
  const d: { order: { cancelledAt: string | null; displayFinancialStatus: string | null } | null } = await gql(
    `query refOrder($id: ID!) { order(id: $id) { id cancelledAt displayFinancialStatus } }`,
    { id: orderGid },
  );
  if (!d.order) return null;
  return { cancelled: !!d.order.cancelledAt, financialStatus: d.order.displayFinancialStatus ?? "" };
}

const CREATE_MUTATION = `mutation refCode($d: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $d) {
    codeDiscountNode { id }
    userErrors { field message code }
  }
}`;

/** Create one referral code on Shopify. Retries once on a code collision; throws on anything else. */
export async function createReferralDiscount(kind: ReferralCodeKind, now = new Date()): Promise<{ code: string; discountId: string; endsAt: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const code = kind === "friend" ? generateFriendCode() : generatePersonalCode();
    const input = referralDiscountInput(code, kind, now);
    const d: { discountCodeBasicCreate: { codeDiscountNode: { id: string } | null; userErrors: { field?: string[]; message: string; code?: string }[] } | null } =
      await gql(CREATE_MUTATION, { d: input });
    const out = d.discountCodeBasicCreate;
    if (!out) throw new Error("referral discountCodeBasicCreate: empty answer");
    if (out.codeDiscountNode) return { code, discountId: out.codeDiscountNode.id, endsAt: input.endsAt };
    const taken = out.userErrors.some((e) => e.code === "TAKEN" || /taken|unique/i.test(e.message));
    if (!taken) throw new Error(`referral discountCodeBasicCreate userErrors: ${JSON.stringify(out.userErrors).slice(0, 300)}`);
  }
  throw new Error("referral discountCodeBasicCreate: code collision twice");
}

/** How many times a code was used (asyncUsageCount), or null when the discount no longer exists. */
export async function discountUsage(discountGid: string): Promise<number | null> {
  const d: { codeDiscountNode: { codeDiscount: { asyncUsageCount?: number } } | null } = await gql(
    `query refUsage($id: ID!) { codeDiscountNode(id: $id) { id codeDiscount { ... on DiscountCodeBasic { asyncUsageCount status } } } }`,
    { id: discountGid },
  );
  if (!d.codeDiscountNode) return null;
  return Number(d.codeDiscountNode.codeDiscount.asyncUsageCount ?? 0);
}

export async function deactivateDiscount(discountGid: string): Promise<void> {
  const d: { discountCodeDeactivate: { codeDiscountNode: { id: string } | null; userErrors: { message: string }[] } } = await gql(
    `mutation refOff($id: ID!) { discountCodeDeactivate(id: $id) { codeDiscountNode { id } userErrors { field message } } }`,
    { id: discountGid },
  );
  if (!d.discountCodeDeactivate.codeDiscountNode) {
    throw new Error(`referral discountCodeDeactivate: ${JSON.stringify(d.discountCodeDeactivate.userErrors).slice(0, 300)}`);
  }
}
