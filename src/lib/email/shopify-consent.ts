/**
 * Email-marketing consent on the Shopify CUSTOMER — what Shopify Email campaigns (Boxing Day, seasons) mail to.
 *
 *   - UNSUBSCRIBED: an unsubscribe / hard bounce / complaint from one of OUR emails is pushed to the matching Shopify
 *     customer, so a Shopify Email campaign never mails that person again (CASL). Never creates a customer.
 *   - SUBSCRIBED: only while settings `email_consent_to_shopify` = "1". Creates the customer when needed. OFF by
 *     default because Klaviyo's Shopify integration copies every new Shopify customer into Klaviyo — turn it on once
 *     that sync is disconnected, or it refills the 250-profile free plan (docs/EMAIL-GRATUIT.md).
 *
 * Needs `read_customers` + `write_customers` (both granted, checked 2026-11-27).
 */
export const CONSENT_TO_SHOPIFY_KEY = "email_consent_to_shopify";

type Gql = (query: string, variables: Record<string, unknown>) => Promise<{ data?: Record<string, unknown>; errors?: unknown }>;

async function defaultGql(query: string, variables: Record<string, unknown>) {
  const { shopifyFetch } = await import("@/lib/shopify-client");
  const res = await shopifyFetch("/graphql.json", { method: "POST", body: JSON.stringify({ query, variables }) });
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}`);
  return (await res.json()) as { data?: Record<string, unknown>; errors?: unknown };
}

const FIND = `query consentFind($q: String!) { customers(first: 1, query: $q) { nodes { id emailMarketingConsent { marketingState } } } }`;
const UPDATE = `mutation consentUpdate($input: CustomerEmailMarketingConsentUpdateInput!) {
  customerEmailMarketingConsentUpdate(input: $input) { customer { id } userErrors { field message } }
}`;
const CREATE = `mutation consentCreate($input: CustomerInput!) { customerCreate(input: $input) { customer { id } userErrors { field message } } }`;

export type ShopifyConsentResult = "updated" | "unchanged" | "created" | "no-customer";

/** Thrown when Shopify refuses this address for good (validation error): the caller stops retrying it. */
export class ShopifyConsentRefused extends Error {}

export async function setShopifyEmailConsent(
  email: string,
  state: "SUBSCRIBED" | "UNSUBSCRIBED",
  opts: { locale?: string | null; now?: Date; gql?: Gql } = {},
): Promise<ShopifyConsentResult> {
  const gql = opts.gql ?? defaultGql;
  const addr = email.trim().toLowerCase();
  if (!/^[^\s@"]+@[^\s@"]+\.[^\s@"]{2,}$/.test(addr)) throw new ShopifyConsentRefused("invalid email");
  const at = (opts.now ?? new Date()).toISOString();
  const consent = state === "SUBSCRIBED"
    ? { marketingState: "SUBSCRIBED", marketingOptInLevel: "SINGLE_OPT_IN", consentUpdatedAt: at }
    : { marketingState: "UNSUBSCRIBED", consentUpdatedAt: at };

  const found = await gql(FIND, { q: `email:"${addr}"` });
  if (found.errors) throw new Error(`customers query: ${JSON.stringify(found.errors).slice(0, 200)}`);
  const node = ((found.data?.customers as { nodes?: Array<{ id: string; emailMarketingConsent?: { marketingState?: string } | null }> } | undefined)?.nodes ?? [])[0];

  const errorsOf = (j: { data?: Record<string, unknown>; errors?: unknown }, key: string) => {
    if (j.errors) throw new Error(`${key}: ${JSON.stringify(j.errors).slice(0, 200)}`);
    const ue = (j.data?.[key] as { userErrors?: Array<{ message: string }> } | undefined)?.userErrors ?? [];
    if (ue.length) throw new ShopifyConsentRefused(`${key}: ${ue.map((e) => e.message).join("; ").slice(0, 200)}`);
  };

  if (!node) {
    if (state === "UNSUBSCRIBED") return "no-customer";
    const lang = (opts.locale ?? "").toLowerCase().startsWith("en") ? "en" : "fr";
    const created = await gql(CREATE, { input: { email: addr, locale: lang, emailMarketingConsent: consent, tags: ["consentement-site"] } });
    errorsOf(created, "customerCreate");
    return "created";
  }
  if ((node.emailMarketingConsent?.marketingState ?? "").toUpperCase() === state) return "unchanged";
  // never re-subscribe someone who unsubscribed on Shopify's side: only a new, explicit opt-in there may do that
  if (state === "SUBSCRIBED" && (node.emailMarketingConsent?.marketingState ?? "").toUpperCase() === "UNSUBSCRIBED") return "unchanged";
  const upd = await gql(UPDATE, { input: { customerId: node.id, emailMarketingConsent: consent } });
  errorsOf(upd, "customerEmailMarketingConsentUpdate");
  return "updated";
}
