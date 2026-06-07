# Creatomate — Automated Product Videos

Short branded videos (15–30s) for social posts: product image + title + price +
Ameublo Direct logo + music, rendered via the [Creatomate](https://creatomate.com)
API. This is a **foundation** — the client + pipeline wiring ship here; you create
the template in Creatomate and set three env vars to turn it on.

## 1. Account + API key
1. Sign up at [creatomate.com](https://creatomate.com). The free tier includes
   **5 renders/month** — enough to validate the template and flow.
2. Project Settings → **API key** → copy the key.
3. Set it locally (and in Vercel env for production):
   ```
   CREATOMATE_API_KEY=your_creatomate_api_key
   ```
   When unset, the client no-ops and the pipeline simply posts the image (no video).

## 2. Build the template (1080×1080 square)
In the Creatomate editor, create a template sized **1080×1080** (Instagram/Facebook
square — same as the still image), 15–30s, then add:

| Element | Notes |
|---------|-------|
| **Product image** | Image element named **`product_image`** (dynamic). Fill the frame; add a subtle Ken Burns/zoom if you like. |
| **Title band** | Text element named **`product_title`** over a band (navy `#1A2340`), bottom third. |
| **Price** | Text element named **`price`** (e.g. bottom-right, copper `#C17F3E`). |
| **Logo** | Image element named **`logo_url`** (Ameublo Direct logo), or bake the logo in as a static element if you prefer not to pass it. |
| **Animation** | A **fade-in** on the title/price (and optional background music track). |

Each named element becomes a **modification variable**. The pipeline sends:
`product_image`, `product_title`, `price`, and (optionally) `logo_url`.

Copy the template id (editor URL / "Use template via API") and set:
```
CREATOMATE_TEMPLATE_ID=your_template_id
# Optional — only if logo_url is a variable (not baked into the template):
CREATOMATE_LOGO_URL=https://.../ameublo-logo.png
```

## 3. How the pipeline uses it
`src/lib/creatomate-client.ts`:
- `createVideoFromTemplate(templateId, modifications)` → render job id (or `null`).
- `getVideoStatus(jobId)` → `{ status, url }` (url once `succeeded`).
- `renderVideoAndWait(...)` → starts a render and polls, bounded, returning the MP4 url.

On a **new_product** draft (`job4-social.ts`), when `CREATOMATE_API_KEY` +
`CREATOMATE_TEMPLATE_ID` are set, it renders a video alongside the branded image,
waits up to ~90s, and stores the MP4 url in `facebook_drafts.video_url`. The
publisher then **prefers the video on Facebook** (`publishVideo` → `/{page}/videos`
with `file_url`); falls back to the image when there's no video.

## Foundation limitations (follow-ups)
- **Async timing:** renders are asynchronous. The pipeline waits a bounded ~90s; a
  slower render won't attach to that draft (the image still posts). A webhook or a
  resolver cron to back-fill `video_url` when the render finishes is the next step.
- **Instagram:** the publisher uses the video on **Facebook only**. IG video =
  Reels (a media container with `media_type=REELS` + a processing-status poll, and
  Reels prefer 9:16 not square) — left as a follow-up; IG keeps the branded image.
- **Format:** the template is square (1080×1080), ideal for FB feed video; revisit a
  9:16 variant if/when IG Reels is wired.
