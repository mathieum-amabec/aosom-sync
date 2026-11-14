# Meta Conversions API (CAPI)

Server-side events sent to pixel `214720653324969` in addition to the browser pixel (Meta's "redundant setup").
Both domains (ameublodirect.ca, furnishdirect.ca) share the pixel. **Everything is OFF by default.**

| Event | Browser | Server | Dedup key |
|---|---|---|---|
| Purchase | Custom Web Pixel (`docs/meta-custom-web-pixel.js`) | Shopify `orders/paid` webhook → `/api/webhooks/shopify-orders-paid` | `event_id` = `checkout_token` (= browser `eid`) |
| ViewContent / AddToCart | ScriptTag (`/api/pixel/script`) `fbq(..., {eventID})` | same script relays to `POST /api/capi/event` | shared random id |

Customer data (email, phone, name, city, state, zip, country, customer id) is SHA-256 hashed after Meta's
normalisation (`src/lib/meta-capi.ts`). IP, user agent, `_fbp`, `_fbc` are sent raw as Meta requires.

## Settings keys (table `settings`)
- `capi_enabled` = `1` to enable (anything else = no-op, routes answer 200 "skipped").
- `capi_test_event_code` = code from Events Manager → Test events. While set, events go to the Test tab only and are NOT recorded as sent.
- `capi_webhook_token` = secret for the webhook URL (`?t=`), >= 24 chars.

Needs `META_ACCESS_TOKEN` (already used for the Marketing API; must allow the pixel/dataset).

## Rollout
1. Merge + deploy.
2. Set `capi_webhook_token`; `CAPI_WEBHOOK_TOKEN=<same> node-x64 --env-file=.env.local scripts/capi-setup.mjs --apply`.
3. Set `capi_test_event_code` and `capi_enabled=1`; browse the store / place a test order; check Events Manager → Test events:
   events show "Server" + "Browser" and are marked **Deduplicated**.
4. Clear `capi_test_event_code` to go live. Rollback: `capi_enabled=0`.
