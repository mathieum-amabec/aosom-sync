# Klaviyo Flows — Created via API (reference)

The four core email flows were created **programmatically** against the live Klaviyo
account on **2026-06-08** by `scripts/setup-klaviyo-flows.mjs`. This file records the
flow/template/trigger IDs for future reference and wiring.

> **All flows are in `draft` status — nothing sends.** Klaviyo will not deliver any
> email until a human reviews the copy and switches each flow to **Live** in the
> dashboard (Flows → flow → top-right status toggle). This is intentional: the API
> builds the structure; a human approves the marketing before it goes out.

> For account/dashboard setup, the bilingual strategy, and the deliverability
> checklist, see **[KLAVIYO-SETUP.md](./KLAVIYO-SETUP.md)**. This file is the
> machine-created counterpart (the IDs + how it was built).

---

## API facts (important)

- **Flow creation requires API revision `2025-01-15`** (the *Create Flow* endpoint does
  not exist before `2024-07-15`). The server-side client `src/lib/klaviyo-client.ts`
  uses `2023-10-15` for events/profiles — that revision returns **404** on `POST /flows/`.
  The setup script uses `2025-01-15` for writes and `2023-10-15` for reads.
- **Sender:** `info@ameublodirect.ca` (label `AmeubloDirect`) — the account's
  `default_sender_email` (from `GET /accounts/`).
- **`template_id` is cloned into the flow** at creation: each `[Flow] …` source template
  below is copied into the flow's email action. Editing the source template afterward does
  **not** change the live flow email — edit the email inside the flow in the dashboard.

## Created resources

### List
| Name | ID | Purpose |
| --- | --- | --- |
| `Newsletter` | `YnAkcW` | Trigger for the Welcome Series (newsletter signups) |

### Trigger metrics
| Metric | ID | Source | Used by |
| --- | --- | --- | --- |
| `Checkout Started` | `Rycc4h` | Shopify | Abandoned Cart |
| `Placed Order` | `SbdeEU` | Shopify | Post-Purchase |
| `Price Drop Alert` | `SVCFpn` | Custom (API) | Price Drop Alert |

> `Price Drop Alert` is a **custom metric** bootstrapped by sending one seed event
> (profile `ops-seed@ameublodirect.ca`) so the flow has a metric to trigger on. Our
> `src/lib/klaviyo-client.ts` `trackEvent(...)` is the eventual producer — fire it with the
> metric name **`Price Drop Alert`** when a real price-drop subscriber exists (see
> KLAVIYO-SETUP.md §"Server-side events"; note the doc's earlier example used `"Price Drop"`
> — use `"Price Drop Alert"` to match this flow's trigger).

### Email templates (source; bilingual FR over EN)
| Key | Name | ID |
| --- | --- | --- |
| welcome_1 | `[Flow] Welcome 1 — Bienvenue` | `XiwKGi` |
| welcome_2 | `[Flow] Welcome 2 — Notre histoire` | `SnZD6G` |
| cart_1 | `[Flow] Cart 1 — Rappel panier` | `X9geZw` |
| cart_2 | `[Flow] Cart 2 — Rappel + offre` | `UDc4x2` |
| postpurchase_1 | `[Flow] Post-Purchase — Avis` | `UpihuQ` |
| pricedrop_1 | `[Flow] Price Drop — Notification` | `UR4PqF` |

### Flows (all `draft`)
| Flow | ID | Trigger | Sequence |
| --- | --- | --- | --- |
| `Welcome Series (FR/EN)` | `XJghtC` | List `Newsletter` | Email 1 (immédiat) → délai **3 j** → Email 2 |
| `Abandoned Cart (FR/EN)` | `Wcjr3F` | Metric `Checkout Started` | Délai **1 h** → Email 1 → délai **23 h** (≈24 h total) → Email 2 |
| `Post-Purchase — Review Request (FR/EN)` | `TGfezb` | Metric `Placed Order` | Délai **14 j** → Email (demande d'avis) |
| `Price Drop Alert (FR/EN)` | `W34UkT` | Metric `Price Drop Alert` | Email immédiat (lien produit via `{{ event.url }}`) |

Direct links: `https://www.klaviyo.com/flow/<ID>/edit` (e.g. `…/flow/XJghtC/edit`).

---

## Bilingual approach (and what's deferred to the dashboard)

Each template stacks **FR (Ameublo Direct)** over **EN (Furnish Direct)** in one email.
A language **conditional-split** was deliberately **not** built by the script because it
needs a `Language`/locale profile property that the Shopify→Klaviyo sync does not populate
yet (see KLAVIYO-SETUP.md §3). Once that property exists, add a `conditional-split` near the
top of each flow in the dashboard and branch to FR/EN versions.

EN links currently point to **`ameublodirect.ca/en`** (the working EN locale subfolder),
not `furnishdirect.ca`, because that domain is **not connected yet**
(see [FURNISHDIRECT-DOMAIN-SETUP.md](./FURNISHDIRECT-DOMAIN-SETUP.md)). Switch EN links to
`https://furnishdirect.ca` once DNS/SSL is live.

## Before going live (human checklist)

1. Review/refine copy + subject lines for each email (FR and EN) in the dashboard.
2. **Abandoned Cart / Price Drop**: add Klaviyo dynamic blocks (cart line items / dropped
   product) — the templates ship with generic copy + safe default links only.
3. **Post-Purchase**: the review CTA links to the storefront. Judge.me's own review-request
   email may be preferable; the public `judge.me/reviews/ameublodirect.myshopify.com` URL
   currently 404s, so it is intentionally not linked here.
4. Send a test of every email (FR + EN) to a seed address; check rendering on mobile.
5. Confirm sender domain authentication (DKIM/SPF) before flipping to Live.
6. Flip each flow `draft → live`.

## Welcome coupon — BIENVENUE10 (created 2026-06-14)

The Welcome flow hands out a 10%-off code. Created in Shopify via
`scripts/shopify-create-discount.mjs --apply` (idempotent; needs the token's
`write_discounts` scope):

| Resource | ID | Detail |
| --- | --- | --- |
| Price rule | `1916108374121` | percentage **−10%**, `customer_selection: all`, `once_per_customer: true`, `usage_limit: null`, **no expiry** (`ends_at: null`) |
| Discount code | `17247691178089` | code **`BIENVENUE10`** |

**Remaining (dashboard, human):** insert `BIENVENUE10` into the Welcome Series email
(`XJghtC`, template `[Flow] Welcome 1 — Bienvenue` `XiwKGi`) and flip the flow
`draft → live` after the pre-launch checklist above. The code is store-wide (any
customer who types it gets 10% once), so the Welcome email is just the distribution
channel — there's no per-flow "attach" in Klaviyo.

## Re-running / idempotency

`node scripts/setup-klaviyo-flows.mjs` is **idempotent**: it matches existing lists,
metrics, templates, and flows **by name** and skips anything already present, so re-running
will not create duplicates. To rebuild a flow from scratch, delete it in the dashboard
(or `DELETE /api/flows/{id}/`) first, then re-run.
