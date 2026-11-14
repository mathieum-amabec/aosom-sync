# Halloween ads (real footage, bilingual FR/EN, no mascot)

Builds vertical 1080x1920 Reels from product videos: flash cuts, FR (orange) + EN (white) overlays, a synthesized horror sound bed
(no licensed audio), a closing card with the order deadline and a "conditions apply depending on your location" line.
Written 2026-10-07 for the Oct 8-23 Halloween run; reuse the generator for other seasonal pushes (swap clip pools and copy).

**No mascot.** The Ameublo character is off the air (see `src/lib/mascot-guard.ts`). Everything here uses real product footage.

## Setup
- Node 22 + ffmpeg 8 with `drawtext` (`FFMPEG_BIN=/path/to/ffmpeg`), a bold condensed font (`FONT_FILE=/path/to/font.ttf`, default Windows Impact).
- Source clips go in `scripts/halloween-ads/src/` as `p-<sku>.mp4` (git-ignored). They are the supplier product videos, e.g.
  `https://uspm.aosomcdn.com/videos/en/8/<sku>/<sku>-WEB.mp4` (`CLIPS` in `build.mjs` lists the SKUs). Only use segments you checked for
  burned-in spec text ("Level: IP44", "Size L", supplier logos); the pools in `build.mjs` are the verified-clean ones.
- DB/Blob scripts read `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `BLOB_READ_WRITE_TOKEN` (the PUBLIC Blob store, Meta ingests the URL directly).

## Run
```bash
node scripts/halloween-ads/build.mjs V05          # one video  -> out/halloween-V05.mp4
bash scripts/halloween-ads/render-all.sh          # V01..V16, three at a time (about 2 min per batch; lower the batch size if RAM is tight)
node scripts/halloween-ads/enqueue-initial.mjs    # dry-run: upload + cancel mascot rows + enqueue 06:00/06:05 slots (add --apply)
node scripts/halloween-ads/update-urls-and-captions.mjs --apply   # re-upload and rewrite url + caption on pending rows
node scripts/halloween-ads/gallery.mjs            # out/calendrier-halloween.html: one card per day, read live from the queue
```
Queue rows are `content_type='sequential_ad'`, `metadata.keepCaption=true` (the publisher keeps the caption as written), `source='halloween_real'`.

## Things that bit us
- Check the order-by date against the storefront's own delivery windows before promising "arrives in time" (site: 4-8 business days QC/ON/Maritimes).
- Render peaks hot: trim to <= -1 dBFS (`-af volume=-2dB`) before upload.
- Three parallel ffmpeg renders use about 3 GB; close other apps first.
- `build.mjs` variants V03..V16 are seeded random picks from the clean pools; V14-V16 carry "last days" hooks.
