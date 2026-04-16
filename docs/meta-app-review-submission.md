# Meta App Review — Submission Kit (Aosom Sync)

This document contains everything needed to move the Meta (Facebook) app used
by Aosom Sync from **Development Mode** to **Live Mode** via App Review.

- **App name:** Aosom Sync
- **Production URL:** https://aosom-sync.vercel.app
- **Privacy policy URL:** https://aosom-sync.vercel.app/privacy
- **App icon:** `public/meta-app-icon-1024.png` (1024×1024) and `public/meta-app-icon-512.png` (512×512)
- **Review login URL:** https://aosom-sync.vercel.app/login
- **Review username:** `meta-review`
- **Review password:** _(value of `META_REVIEW_PASSWORD` set on Vercel — share this with the reviewer)_

---

## 1. Permission descriptions

Paste these verbatim into the Meta App Dashboard → App Review → Permissions
and Features section when submitting each permission.

### `pages_manage_posts`

> Aosom Sync is an **internal tool** used by our company to manage marketing
> content on Facebook Pages that we own and operate as part of our e-commerce
> business (Ameublodirect, a Canadian outdoor-furniture retailer).
>
> The application automates the creation of post drafts from our Shopify
> product catalogue. Each post goes through a **strict human-in-the-loop
> workflow** before any publishing occurs:
>
> 1. Our nightly sync ingests new products and price changes from our
>    supplier catalogue into our internal database.
> 2. The application generates a draft Facebook post (text + images) for a
>    selected product using a language model.
> 3. The draft is stored in our internal dashboard at `/social` in the
>    "pending review" state. **No post is ever published automatically.**
> 4. A team member reviews the generated text, can edit it, reorder or remove
>    images, and explicitly clicks **Approve**.
> 5. The team member then clicks **Publish**, which uses
>    `pages_manage_posts` to publish the reviewed post to the Facebook Page.
>
> The application only ever publishes to Facebook Pages that our own team
> administers (we are listed as Page admins). It does not post to Pages that
> do not belong to our business. Without this permission, our team would have
> to manually copy-paste every draft into the Facebook UI, which defeats the
> purpose of the internal tool.

### `pages_read_engagement`

> Aosom Sync displays a small performance dashboard for the Facebook posts
> **that the application itself has published**. After a post is live, we
> read reach, reactions, and comment counts via `pages_read_engagement` so
> our team can see how the content is performing and decide whether to
> promote, repeat, or adjust future drafts.
>
> The data is only used inside our internal dashboard at `/social`. It is
> never shared with third parties and is only read for Pages that we own.
> Without this permission, the team has no visibility into whether the
> automation is producing effective content.

---

## 2. Test credentials for the Meta reviewer

Paste the block below into the App Review → "Test user credentials" field:

```
URL: https://aosom-sync.vercel.app/login
Username: meta-review
Password: <value of META_REVIEW_PASSWORD set on Vercel>

Steps to test:
1. Open https://aosom-sync.vercel.app/login
2. Log in with the credentials above
3. You will land on the Social Media tab (/social). The reviewer account
   is restricted to Social Media and Settings only — other sections are
   hidden to keep the review focused on the Facebook publishing workflow.
4. Existing drafts are listed on the page. To create a new one, click
   "Generate Highlight" — this picks a product from our catalogue and
   generates a draft post (text + 1–5 images).
5. The generated draft appears in the pending list. Click it to review the
   text and images. Use the "Photos" button to reorder or remove images.
6. Click "Approve" to mark the draft as ready.
7. Click "Publish" to publish the post to our Facebook Page. The draft row
   will update with the Facebook post ID once publishing succeeds.
8. Open the Facebook Page in a new tab to confirm the post is visible.
```

> **Security note for internal use:** the `meta-review` user has a dedicated
> `reviewer` role and is enforced at the middleware level (`src/proxy.ts`).
> Any attempt to reach `/`, `/catalog`, `/sync`, `/import`, or `/collections`
> is redirected to `/social`. API routes outside the allowlist return 403.
> After Meta approves the app, delete the `META_REVIEW_PASSWORD` env var on
> Vercel and run a one-time `DELETE FROM users WHERE username = 'meta-review'`
> against the Turso database to revoke the account.

---

## 3. Screencast script (2–3 minutes)

Meta requires a screencast that shows the full workflow for each requested
permission. Record it with OBS Studio (macOS/Windows/Linux), QuickTime
(macOS), or the built-in Windows Game Bar (`Win+G`). Export as MP4, 1080p.

### Before recording
- [ ] Open a **fresh private/incognito window** (no cached auth)
- [ ] Have the Facebook Page `/Ameublodirect` open in a separate tab but
      hidden until Scene 6
- [ ] Make sure there is at least one product in the catalogue eligible
      for `/social` → "Generate Highlight"
- [ ] Close notifications, Slack, email to keep the recording clean

### Scene 1 — Login (0:00 – 0:20)
1. Open `https://aosom-sync.vercel.app/login`
2. Type `meta-review` / `<META_REVIEW_PASSWORD>`
3. Click **Sign in** — land on `/social`
4. **Narration:** "This is Aosom Sync, our internal tool. I'm signing in as
   the reviewer account Meta will use."

### Scene 2 — Tour of Social Media tab (0:20 – 0:45)
1. Scroll through the list of existing Facebook drafts
2. Point out the "Pending review" / "Approved" / "Published" states
3. **Narration:** "Every post lives here as a draft until a human approves
   and publishes it. Nothing is auto-posted."

### Scene 3 — Generate a new draft (0:45 – 1:15)
1. Click **Generate Highlight**
2. Wait for the Claude-generated text + images to load
3. **Narration:** "We select a product from our Shopify catalogue and the
   application drafts a post. This is purely local — no Facebook call yet."

### Scene 4 — Review and approve (1:15 – 1:45)
1. Click the new draft to open it
2. Use the **Photos** action to reorder/remove an image
3. Edit the caption text slightly
4. Click **Approve**
5. **Narration:** "The operator reviews the text, edits if needed,
   reorders the photos, and approves."

### Scene 5 — Publish to Facebook (1:45 – 2:15)
1. Click **Publish**
2. Wait for the success indicator + Facebook post ID to appear
3. **Narration:** "Publishing uses the `pages_manage_posts` permission to
   post to a Facebook Page we own."

### Scene 6 — Verify on Facebook (2:15 – 2:45)
1. Switch to the Facebook tab for `/Ameublodirect`
2. Refresh the Page → the new post is visible
3. **Narration:** "Here is the post on our Facebook Page. This is the only
   way posts are ever created by the application — human approval,
   explicit publish, our own Page."

### After recording
- [ ] Trim dead time at the start/end
- [ ] Verify the screencast is under 3 minutes
- [ ] Upload to the Meta App Review submission form (max ~100 MB)

---

## 4. Complete checklist

### ✅ Already done by Claude Code (on branch `feature/meta-app-review`)

1. ✅ **Privacy policy page** at `/privacy` (FR + EN, clean white theme,
   publicly accessible — `src/app/privacy/page.tsx`)
2. ✅ **`/privacy` added to public paths** in `src/proxy.ts` so Meta can
   reach it without authentication
3. ✅ **Reviewer role system** added to the `users` table (idempotent
   migration in `src/lib/database.ts`)
4. ✅ **`meta-review` user** seeded automatically on first login when the
   `META_REVIEW_PASSWORD` env var is set (`src/app/api/auth/route.ts`)
5. ✅ **Role-based access enforcement** in `src/proxy.ts`: reviewer can
   only reach `/social`, `/settings`, `/api/social`, `/api/settings`,
   `/api/auth`, `/api/health`, `/privacy`. Everything else redirects to
   `/social` (pages) or returns 403 (APIs).
6. ✅ **Sidebar filtered by role** — reviewer sees only "Social Media"
   and "Settings" (`src/components/sidebar.tsx`)
7. ✅ **Session tokens carry the role** (`src/lib/auth.ts`) — old tokens
   from before this change force a re-login
8. ✅ **App icons generated** at `public/meta-app-icon-1024.png` and
   `public/meta-app-icon-512.png` (`scripts/generate-app-icon.js`)
9. ✅ **Submission documentation** (this file) — permission descriptions,
   test credentials template, screencast script
10. ✅ **`.env.example` updated** with `META_REVIEW_PASSWORD`

### 🔧 To do by Mat (manual)

All URLs below assume you are signed in as the app's business admin on
https://developers.facebook.com.

#### Step 1 — Merge and deploy
1. Open PR from `feature/meta-app-review` → `main`, review, merge
2. On Vercel project `aosom-sync`, add env var `META_REVIEW_PASSWORD`
   (pick a strong password — you will share it with Meta). Apply to
   Production environment.
3. Wait for Vercel production deploy to finish
4. Visit https://aosom-sync.vercel.app/privacy → should render without
   asking for login
5. Visit https://aosom-sync.vercel.app/login and log in as
   `meta-review` / `<META_REVIEW_PASSWORD>`. Confirm you land on
   `/social` and that the sidebar only shows Social Media + Settings.
   Try typing `/catalog` in the URL — should redirect you back to
   `/social`.

#### Step 2 — Business Verification (if not already done)
1. Go to https://business.facebook.com/settings/security
2. Under **Business Verification**, click **Start Verification**
3. Provide legal business name, address, phone number that match public
   records (Registraire des entreprises du Québec for Ameublodirect)
4. Upload one of: articles of incorporation, utility bill, or business
   license. Quebec `Registre des entreprises` extract works.
5. Wait for approval (1–5 business days). **App Review cannot start until
   this is approved.**

#### Step 3 — Configure the Meta App
1. Go to https://developers.facebook.com/apps/ and open the Aosom Sync app
2. **Basic Settings** (left sidebar → Settings → Basic):
   - App Icon: upload `public/meta-app-icon-1024.png`
   - Privacy Policy URL: `https://aosom-sync.vercel.app/privacy`
   - User data deletion: `https://aosom-sync.vercel.app/privacy`
     (the privacy page covers the deletion process)
   - Category: **Business**
   - App Domains: `aosom-sync.vercel.app`
3. **App Review → Permissions and Features** (left sidebar → App Review):
   - Find `pages_manage_posts`, click **Request Advanced Access**
   - Find `pages_read_engagement`, click **Request Advanced Access**

#### Step 4 — Submit for review
1. In **App Review → Requests**, click **Create New Request**
2. Select both permissions
3. For each permission, paste the description from section **1** of this
   document into the "How will your app use this permission?" field
4. Paste the test credentials block from section **2** into the "Test user
   credentials" field
5. Upload the screencast MP4 from section **3**
6. Click **Submit for Review**
7. Wait 3–7 business days for Meta to respond. They may reject once with
   specific feedback — iterate and resubmit.

#### Step 5 — After approval
1. In the Meta App Dashboard, toggle the app from **Development** to
   **Live** (top bar)
2. Test publishing a real post from the main `admin` account in production
3. Revoke the reviewer account:
   - Remove `META_REVIEW_PASSWORD` env var from Vercel
   - Open the Turso shell and run:
     `DELETE FROM users WHERE username = 'meta-review';`
4. Delete the `feature/meta-app-review` branch if merged

---

## 5. Quick reference — files touched on this branch

| File | Purpose |
| --- | --- |
| `src/app/privacy/page.tsx` | Public FR/EN privacy policy |
| `src/proxy.ts` | `/privacy` public + reviewer role enforcement |
| `src/lib/config.ts` | `AUTH.ROLES`, `AUTH.REVIEWER_ALLOWED_PREFIXES`, `UserRole` type |
| `src/lib/database.ts` | `users.role` column + migration, updated `getUserByUsername`/`createUser` |
| `src/lib/auth.ts` | Session token carries role; `getSession`, `getSessionRole`, `isPathAllowedForRole` |
| `src/app/api/auth/route.ts` | Seeds `meta-review` user from `META_REVIEW_PASSWORD` |
| `src/app/(dashboard)/layout.tsx` | Async, reads role, passes to `Sidebar` |
| `src/components/sidebar.tsx` | Accepts `role` prop, filters nav for reviewer |
| `scripts/generate-app-icon.js` | Renders the 1024 + 512 PNG icons via sharp |
| `public/meta-app-icon-1024.png` | Generated icon |
| `public/meta-app-icon-512.png` | Generated icon |
| `.env.example` | `META_REVIEW_PASSWORD` documented |
| `docs/meta-app-review-submission.md` | This file |
