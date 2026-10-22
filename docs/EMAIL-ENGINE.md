# Own email engine (Resend)

Started 2026-10-21. Mat found Klaviyo too expensive and wants full control over the email text
through an API. The plan: keep the flow logic in aosom-sync (it already lives there, see
`flow-relay.ts` and `relance-paiement.ts`) and send through Resend instead of Klaviyo campaigns.

**State: foundation only, OFF.** No flow uses it yet, nothing is sent.

## What exists (v0.5.107.46)

| Piece | File |
|---|---|
| Resend transport (fetch, Idempotency-Key, one 429 retry) | `src/lib/email/resend.ts` |
| Single exit door with every check | `src/lib/email/engine.ts` (`sendEmail`) |
| Shell + CASL footer (sender, mailing address, unsubscribe) | `src/lib/email/layout.ts` |
| Signed unsubscribe links | `src/lib/email/unsubscribe.ts` |
| Unsubscribe page (GET asks, POST unsubscribes, RFC 8058 one-click) | `src/app/api/email/unsubscribe/route.ts` |
| Bounce / complaint webhook (Svix-signed) | `src/app/api/email/webhook/route.ts`, `src/lib/email/webhook.ts` |
| Tables | `email_suppressions`, `email_sends` (`src/lib/database.ts`) |

## Switches and configuration

- settings `email_engine_mode`: `off` (default) · `test` (only `email_test_recipients`) · `live`.
- settings `email_test_recipients`: comma-separated addresses for `test` mode.
- settings `email_mailing_address`: required by CASL in every commercial email. Without it nothing sends.
- env `RESEND_API_KEY`, `EMAIL_FROM` (e.g. `Ameublo Direct <bonjour@ameublodirect.ca>`),
  `EMAIL_REPLY_TO` (optional), `EMAIL_TOKEN_SECRET` (≥ 32 chars), `RESEND_WEBHOOK_SECRET` (`whsec_…`).
- `configProblems()` lists what is missing, in French, for the dashboard.

## Still to do (next sessions)

1. Mat: create the Resend account, verify the domain (SPF/DKIM records + a DMARC record), give the API key.
2. Mat: decide the mailing address shown in the footer (CASL; PO box or other).
3. Flows on the engine, one at a time, each in `test` mode first: abandoned checkout #1/#2,
   welcome, wheel code (roue-1/2/3), post-purchase + review, price drop.
4. Per flow, stop the Klaviyo relay step in the same deploy so nobody gets two emails.
5. Consent source of truth: who may receive marketing (Klaviyo consent today, Shopify
   `emailMarketingConsent` needs the `read_customers` scope the token lacks).
6. Dashboard panel: sends / delivered / opened / clicked per flow (`getEmailSendStats`), plus `configProblems`.
7. Push unsubscribes back to Shopify/Klaviyo so all tools agree.
