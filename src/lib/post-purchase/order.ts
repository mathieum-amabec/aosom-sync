/** Read the order behind a thank-you page through the Admin API (the extension only gives us its id). */
import { shopifyFetch } from "@/lib/shopify-client";
import type { OrderLineInput } from "./offer-rules";

export interface MerciOrder {
  id: string;
  name: string;
  email: string | null;
  createdAt: string;
  cancelled: boolean;
  test: boolean;
  /** Customer GID, or null for a guest order. */
  customerId: string | null;
  /** The random confirmation number the buyer sees on the Thank you page (orderConfirmation.number). */
  confirmationNumber: string | null;
  /** Discount codes used on the order. */
  discountCodes: string[];
  lines: OrderLineInput[];
}

/**
 * The thank-you page id may be an OrderIdentity or Order GID, or a bare number; the numeric part is the order id.
 * Null when it is not a usable id.
 */
export function toOrderGid(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const m = String(raw).match(/^(?:gid:\/\/shopify\/(?:Order|OrderIdentity)\/)?(\d{1,20})$/);
  return m ? `gid://shopify/Order/${m[1]}` : null;
}

const ORDER_QUERY = `query merciOrder($id: ID!) {
  order(id: $id) {
    id name email createdAt cancelledAt test confirmationNumber discountCodes
    customer { id }
    lineItems(first: 50) { nodes {
      title variantTitle quantity
      originalUnitPriceSet { shopMoney { amount } }
      product { id productType }
    } }
  }
}`;

/** The order, or null while Shopify has not created it yet (the thank-you page can render first). */
export async function fetchMerciOrder(gid: string): Promise<MerciOrder | null> {
  const res = await shopifyFetch("/graphql.json", { method: "POST", body: JSON.stringify({ query: ORDER_QUERY, variables: { id: gid } }) });
  const j = (await res.json()) as {
    data?: {
      order: {
        id: string; name: string; email: string | null; createdAt: string; cancelledAt: string | null; test: boolean;
        confirmationNumber: string | null; discountCodes: string[] | null; customer: { id: string } | null;
        lineItems: { nodes: Array<{ title: string; variantTitle: string | null; quantity: number; originalUnitPriceSet: { shopMoney: { amount: string } }; product: { id: string; productType: string } | null }> };
      } | null;
    };
    errors?: unknown;
  };
  if (!res.ok || j.errors) throw new Error(`merci order fetch failed: ${JSON.stringify(j.errors ?? res.status).slice(0, 300)}`);
  const o = j.data?.order;
  if (!o) return null;
  return {
    id: o.id,
    name: o.name,
    email: o.email,
    createdAt: o.createdAt,
    cancelled: !!o.cancelledAt,
    test: o.test,
    customerId: o.customer?.id ?? null,
    confirmationNumber: o.confirmationNumber ?? null,
    discountCodes: o.discountCodes ?? [],
    lines: o.lineItems.nodes.map((l) => ({
      productId: l.product ? l.product.id.split("/").pop() ?? null : null,
      productType: l.product?.productType ?? "",
      title: l.title,
      variantTitle: l.variantTitle,
      price: Number(l.originalUnitPriceSet.shopMoney.amount),
    })),
  };
}

/**
 * Is the caller the buyer of this order? The session token proves only that the request comes from a checkout of our
 * store; the order id in the body could be anyone's. So:
 *   - the confirmation number shown on the buyer's Thank you page must match (when the order has one — all recent
 *     orders do); without one, a logged-in token is required;
 *   - when the token names a customer (`sub`), it must be the order's customer.
 */
export function callerOwnsOrder(order: Pick<MerciOrder, "customerId" | "confirmationNumber">, auth: { sub?: string | null; confirmationNumber?: string | null }): boolean {
  return ownershipProblem(order, auth) === null;
}

/** Why the caller is refused, for the logs (no PII: never the numbers themselves), or null when they own the order. */
export function ownershipProblem(
  order: Pick<MerciOrder, "customerId" | "confirmationNumber">,
  auth: { sub?: string | null; confirmationNumber?: string | null },
): string | null {
  const sub = auth.sub?.trim() || null;
  if (sub && !order.customerId) return "token-customer-on-guest-order";
  if (sub && sub !== order.customerId) return "token-customer-mismatch";
  if (order.confirmationNumber) {
    const given = (auth.confirmationNumber ?? "").trim().toUpperCase();
    if (!given) return "confirmation-missing";
    return given === order.confirmationNumber.trim().toUpperCase() ? null : "confirmation-mismatch";
  }
  return sub ? null : "no-confirmation-and-no-token-customer";
}

/** An order paid with one of our own MERCI codes never gets another offer (no chain of discounts). */
export function usedMerciCode(order: Pick<MerciOrder, "discountCodes">): boolean {
  return order.discountCodes.some((c) => c.trim().toUpperCase().startsWith("MERCI-"));
}
