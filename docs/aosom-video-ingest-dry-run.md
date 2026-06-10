# Phase 3 — Aosom video ingest (DRY-RUN)

**Date:** 2026-06-10 · **Branche:** `feature/aosom-video-ingest`
**Script:** `scripts/aosom-video-ingest-dry-run.mjs` (read-only API test; **no upload, no product change**)

Goal: validate the Shopify API path for attaching Aosom MP4 videos to products,
without ingesting anything yet.

## Étape 1 — API scopes

Checked via `GET /admin/oauth/access_scopes.json`:

| Scope | Present? |
|---|---|
| `write_products` | ✅ |
| `write_files` | ❌ **missing** |
| `read_files` | ❌ **missing** |

The Phase-0 audit assumed `write_products` was enough. The task asked to confirm all
three — **two are missing**. See the test result below for why this may not block videos.

## Étape 2 — `stagedUploadsCreate(resource: VIDEO)` test (3 products)

17 / 30 top-seller SKUs already carry a `products.video` URL. Tested 3:

| SKU | Vidéo Aosom | HEAD | staged target |
|---|---|---|---|
| `01-0893` | `…/01-0893/01-0893-Outsunny-WEB.mp4` | 200, 2.54 MB, video/mp4 | ✅ GCS target + `external_video_id` |
| `823-002V80` | `…/823-002V80/823-002V80-HOMCOM-WEB.mp4` | 200, 2.99 MB, video/mp4 | ✅ GCS target + `external_video_id` |
| `823-010V81` | `…/823-010V81/823-010V81-WEB.mp4` | 200, 3.12 MB, video/mp4 | ✅ GCS target + `external_video_id` |

All 3 `stagedUploadsCreate` calls **succeeded** (no `userErrors`), returning a
`shopify-video-production-core-originals.storage.googleapis.com` upload URL,
a `resourceUrl` carrying an `external_video_id`, and the signed params
(`GoogleAccessId`, `key`, `policy`, `signature`).

**Key finding:** video staging **works without `write_files`/`read_files`** — product
videos route through Shopify's video service via the product-media path
(`stagedUploadsCreate` + `productCreateMedia`), which `write_products` covers. The
standalone **Files API** (Content → Files) is what needs `write_files`/`read_files`.

## Real ingestion flow (NOT executed — awaiting Mat)

1. `stagedUploadsCreate(resource: VIDEO, fileSize, mimeType: video/mp4)` → staged target ✅ (tested)
2. PUT/POST the MP4 bytes to the staged `url` with the returned params *(not done)*
3. `productCreateMedia(productId, media: [{ originalSource: resourceUrl, mediaContentType: VIDEO }])` *(not done — needs `write_products`, present)*
4. Poll `media.status` (`UPLOADED → PROCESSING → READY`/`FAILED`) *(not done)*

## Recommendation for Mat

- The video path is viable with the **current** token (`write_products`), since step 3
  is product media. **Adding `write_files`+`read_files` is optional** for product videos
  but would be needed if we ever use the standalone Files library.
- Before any backfill, validate the **full** flow (steps 2–4) on **one** product end to
  end (upload bytes + `productCreateMedia` + poll to `READY`). **STOP — awaiting Mat.**
