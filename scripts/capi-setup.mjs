// Registers the Shopify `orders/paid` webhook that feeds the Meta Conversions API.
//   node-x64 --env-file=.env.local scripts/capi-setup.mjs            -> dry run (prints the plan)
//   node-x64 --env-file=.env.local scripts/capi-setup.mjs --apply    -> creates the webhook
// The callback URL carries a secret token (?t=...) that must equal settings.capi_webhook_token in the app DB.
// Pass it as CAPI_WEBHOOK_TOKEN and set the same value in the settings table (docs/META-CAPI.md).
import { gql, loadEnv } from "./_shopify-lib.mjs";

loadEnv();
const apply = process.argv.includes("--apply");
const token = process.env.CAPI_WEBHOOK_TOKEN;
const base = process.env.CAPI_BASE_URL || "https://aosom-sync.vercel.app";
if (!token || token.length < 24) {
  console.error("CAPI_WEBHOOK_TOKEN missing or too short (>= 24 chars, e.g. `openssl rand -hex 24`).");
  process.exit(1);
}
const callbackUrl = `${base}/api/webhooks/shopify-orders-paid?t=${token}`;

const existing = await gql(`{ webhookSubscriptions(first: 50, topics: ORDERS_PAID) { nodes { id endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } } }`);
const nodes = existing.data?.webhookSubscriptions?.nodes ?? [];
const mine = nodes.filter((n) => (n.endpoint?.callbackUrl || "").includes("/api/webhooks/shopify-orders-paid"));
console.log(`existing orders/paid webhooks: ${nodes.length} (ours: ${mine.length})`);
if (mine.length) { console.log("already registered:", mine.map((n) => n.id).join(", ")); process.exit(0); }
if (!apply) { console.log("dry run — would register", callbackUrl.replace(token, "***")); process.exit(0); }

const r = await gql(
  `mutation($u: URL!) { webhookSubscriptionCreate(topic: ORDERS_PAID, webhookSubscription: { callbackUrl: $u, format: JSON }) { webhookSubscription { id } userErrors { field message } } }`,
  { u: callbackUrl },
);
const out = r.data?.webhookSubscriptionCreate;
if (out?.userErrors?.length) { console.error(JSON.stringify(out.userErrors)); process.exit(1); }
console.log("registered", out?.webhookSubscription?.id);
