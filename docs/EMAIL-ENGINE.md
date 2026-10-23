# Own email engine (Resend)

Started 2026-10-21. Mat found Klaviyo too expensive and wants full control over the email text
through an API. The flow logic stays in aosom-sync and sending moves from Klaviyo campaigns (the
relays, `flow-relay.ts` / `relance-paiement.ts`) to Resend. Triggers still come from Klaviyo
events (free plan): only the sending moves.

**State: built, OFF.** No Resend account yet; `email_engine_mode` = off, so nothing is sent and
the relays behave exactly as before.

## Pieces

| Piece | File |
|---|---|
| Resend transport (fetch, Idempotency-Key, one 429 retry) | `src/lib/email/resend.ts` |
| Single exit door with every check | `src/lib/email/engine.ts` (`sendEmail`) |
| Shell + CASL footer (sender, mailing address, unsubscribe) | `src/lib/email/layout.ts` |
| The 9 flow emails, FR + EN (copy ported from the Klaviyo templates) | `src/lib/email/templates.ts` |
| Who gets what, when; hand-over from the relays | `src/lib/email/flows.ts`, cron `/api/cron/email-flows` (4,19,34,49) |
| Consent (Klaviyo) + unsubscribe sync to Klaviyo | `src/lib/email/consent.ts` |
| Signed unsubscribe links / page (GET asks, POST unsubscribes, RFC 8058 one-click) | `src/lib/email/unsubscribe.ts`, `/api/email/unsubscribe` |
| Bounce / complaint webhook (Svix-signed) | `/api/email/webhook`, `src/lib/email/webhook.ts` |
| Dashboard: switch, address, test list, previews, hand-over per group, results | `email-panel.tsx`, `/api/email/status`, `/api/email/preview` |
| Tables | `email_suppressions`, `email_sends` |

## Flows

| Group | Emails | Timing (same as the relays) | Consent |
|---|---|---|---|
| relance | relance-1, relance-2 | 30 min, 24 h after checkout | own: everyone who started a checkout (Mat, 2026-10-21) |
| bienvenue | bienvenue-1, bienvenue-2 | 10 min, 3 days after signup | express |
| roue | roue-1/2/3 | 10 min, 24 h, 60 h after the spin | own (wheel needs consent) |
| avis | avis | 10 days after fulfilment | own (purchase) |
| baisse-prix | baisse-prix | at the alert | own (request) |

Unsubscribed or Klaviyo-suppressed profiles never get anything. Abandoned-checkout reminders go to
everyone who started a checkout, like the relays (Mat's decision, 2026-10-21).

## Hand-over (no double sends)

- settings `email_engine_mode`: `off` (default) · `test` (only `email_test_recipients`, relays keep serving customers) · `live`.
- settings `email_engine_takeover`: JSON {group: ISO}. In `live` with a complete configuration, a ticked group is skipped by the relays and sent by the engine. Broken configuration → the relays keep every group.
- Both sides read each other's bookkeeping on EVERY run: the engine skips events the relays handled and honours their per-profile cooldowns; the relays skip events the engine handled (`mergeEngineIntoRelay` / `mergeEngineIntoRelance`). So any move back (unticking, leaving `live`, broken config) never resends.
- The relays abort a run (retry in 15 min) if they cannot read the switches, instead of guessing.
- The engine starts 1 h before the hand-over, shares the relays' lease, and stops a flow if Klaviyo's own flow delivers again.
- Mode `test` keeps its own state (`email_flows_state_test`), so it never marks real customers' emails as done.
- Entering `live` restarts each ticked group's hand-over time at that moment.
- Unsubscribes, hard bounces and complaints are pushed to Klaviyo (retried by the cron until done), so the relays stop too.
- A send cut off mid-way (`sending` for 10+ min) is retried; Resend's Idempotency-Key (24 h) prevents a real duplicate.
- `EMAIL_TOKEN_SECRET_PREVIOUS` keeps old unsubscribe links working after a secret rotation (CASL: 60 days).

## Configuration still missing

1. Mat: Resend account, domain verified (SPF/DKIM records + DMARC), API key → env `RESEND_API_KEY`.
2. env `EMAIL_FROM` (e.g. `Ameublo Direct <bonjour@ameublodirect.ca>`), `EMAIL_TOKEN_SECRET` (≥ 32 chars), `RESEND_WEBHOOK_SECRET`; optional `EMAIL_REPLY_TO`.
3. Mat: mailing address for the footer (dashboard field; CASL). Nothing sends without it.
4. Then: mode `test` with Mat's address, spin the wheel / start a checkout, check the emails; tick one group; `live`.

## Later

- Shopify-side consent (`read_customers` scope) instead of Klaviyo's.
- Newsletter/campaigns (one-off sends to a segment).
