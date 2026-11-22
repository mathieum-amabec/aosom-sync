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
    id name email createdAt cancelledAt test
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
    lines: o.lineItems.nodes.map((l) => ({
      productId: l.product ? l.product.id.split("/").pop() ?? null : null,
      productType: l.product?.productType ?? "",
      title: l.title,
      variantTitle: l.variantTitle,
      price: Number(l.originalUnitPriceSet.shopMoney.amount),
    })),
  };
}
