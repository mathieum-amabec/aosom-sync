# Pinterest auto-Pins — provisioning

Status as of **2026-08-18**: the client and the dry-run script are merged, and **nothing runs
in production**. No route, no cron, no `src/app` file imports `pinterest-client.ts`, and
`.env.local` has zero `PINTEREST_ACCESS_TOKEN` / `PINTEREST_BOARD_ID`, so the live path is
unreachable until the account is provisioned.

## 0. The thing that trips everyone up first

**`PINTEREST_TAG_ID` cannot publish a Pin.**

It is the conversion tag served into the storefront by `/api/pixel/pinterest-script` — the
Pinterest analogue of the Meta pixel id. It is a *public* identifier embedded in client-side
JS. It measures conversions; it authorizes nothing.

There is also **no separate "Pinterest Ads API"** with its own credential. Pinterest exposes
one API (v5). The `/v5/ad_accounts/…` endpoints are the same API with *additional* scopes
(`ads:read` / `ads:write`), and promoting a Pin still requires creating the Pin first through
`POST /v5/pins`. Going the ads route is strictly **more** prerequisites, never fewer.

Probed against the live API on 2026-08-18:

| Request | Result |
|---|---|
| `POST /v5/pins` — no token | `401 {"code":2,"message":"Authentication failed."}` |
| `GET /v5/ad_accounts` — no token | `401 {"code":2,"message":"Authentication failed."}` |
| `GET /v5/ad_accounts` — `Authorization: Bearer <PINTEREST_TAG_ID>` | `401 {"code":2,"message":"Authentication failed."}` |

## 1. Business account + domain claim

1. Convert the Pinterest account to **Business** (or create one) at
   <https://www.pinterest.com/business/create/>.
2. **Claim `ameublodirect.ca`**: Settings → Claimed accounts → Claim website. Do this early —
   it gates Rich Pins (the ones that show live price and availability), and it is the step
   with a review delay.
3. Create the destination **board** (e.g. "Mobilier de patio"). Note its id from the board URL
   or `GET /v5/boards` → `PINTEREST_BOARD_ID`.

A board is mandatory. Pinterest has no default board, and a Pin created without `board_id` is
rejected outright.

## 2. Developer app

1. <https://developers.pinterest.com/apps/> → create an app, linked to the business account.
2. Request scopes **`pins:write`** and **`boards:read`**. Add `ads:read` / `ads:write` only if
   promoted Pins are wanted later — they are not needed for organic publishing.
3. Note the app id / secret, then run the OAuth flow to mint a **refresh token**, and exchange
   it for an access token → `PINTEREST_ACCESS_TOKEN`.

⚠ Pinterest access tokens are **short-lived** (30 days) and refresh tokens last a year. The
current client takes an access token directly; wiring the refresh exchange is a follow-up and
is called out in the code comments.

## 3. Environment

```bash
PINTEREST_ACCESS_TOKEN=   # OAuth token with pins:write + boards:read
PINTEREST_BOARD_ID=       # destination board — required, there is no default
```

`missingPinterestEnv()` reports exactly which of the two is absent, and
`pinterestClientFromEnv()` degrades to dry-run rather than throwing, so nothing breaks while
they are unset.

## 4. Verify

```bash
# renders the exact Pin, sends nothing, needs no credentials
node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs \
  scripts/pinterest-pin-dryrun.mts <SKU>

# creates it for real — refuses without both env vars
node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs \
  scripts/pinterest-pin-dryrun.mts <SKU> --apply
```

## 5. Known gaps before auto-publishing

These are deliberate, and the dry-run prints the first two as warnings on every run:

- **Title language.** The script reads `products.name`, which is the raw **English** Aosom
  title. The curated FR title lives only on the Shopify product. Resolve it via
  `GET products/{id}.json?fields=title` before publishing, or Pins ship in English on a
  French-primary store.
- **Image choice.** It uses `products.image1`, the white-background shot. Pinterest performs
  markedly better with lifestyle photography; prefer the Shopify position-1 image, which the
  social pipeline already treats as the lifestyle photo.
- **Queue wiring is NOT done.** `publication_queue.platform` has a
  `CHECK (platform IN ('facebook','instagram','both','shopify_blog'))`. SQLite cannot `ALTER`
  a CHECK, so adding `'pinterest'` means rebuilding the table — and that table holds live
  scheduled posts. That migration was intentionally deferred rather than run to enable code
  that cannot execute yet. Do it in the same change that lands the credentials.
- **Publishing belongs in `queue-publisher.ts`, not `job4-social.ts`.** `job4-social` only
  *generates* drafts; `/api/cron/publisher` drains the queue and publishes. The Pinterest
  dispatch case goes next to `facebook` / `instagram` there.
