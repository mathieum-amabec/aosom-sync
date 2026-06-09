# Video pipeline — FFmpeg slideshow engine

Foundation for the branded short-form video pipeline. This document covers the
FFmpeg dependency and how it resolves locally vs. on Vercel.

## What this is

`src/lib/video-engines/ffmpeg-slideshow.ts` turns 1-6 product photos into a
branded **1080×1920 (9:16)** MP4:

1. Download each product image (`downloadImage` — SSRF/DoS guarded).
2. Resize to 1080×1920 with sharp (`fit: contain`, navy background).
3. Bake a per-product overlay (title + price + CTA) onto each slide.
4. Ken Burns zoom per slide — `zoompan=z='min(zoom+0.0015,1.5)':d=<frames>`.
5. Static branded band at the bottom (navy + logo + `ameublodirect.ca`).
6. Concatenate clips + a random track from `public/music/` (mixed at -18 dB).
7. Export H.264 (`yuv420p`, `+faststart`).

Brand constants live in `src/lib/video-brand-tokens.ts` (`VIDEO_BRAND`).
Runtime length is clamped into `VIDEO_BRAND.format.durationTarget` (15-30 s):
~5 s/slide, padded to 15 s for a single product.

## FFmpeg availability

`resolveFfmpegPath()` resolves the binary in this order:

1. **`FFMPEG_BIN` / `FFMPEG_PATH`** env override (if set).
2. **`ffmpeg-static`** — the npm package ships a platform-specific static
   binary, downloaded by its postinstall script.
3. **`ffmpeg`** on the system `PATH` (last-resort fallback).

### On Vercel (production) ✅

Vercel builds on **linux/x64**, for which `ffmpeg-static` has a binary. Its
postinstall runs during `npm install` at build time and the binary is bundled
into the serverless function, so `resolveFfmpegPath()` returns the static path.
No extra configuration required.

> Note: ffmpeg + sharp + a 4-minute render budget are memory/CPU heavy. Run the
> video route on a Node.js (not Edge) function and consider raising the function
> memory/`maxDuration` if renders approach the limit.

### Local development ⚠️

`ffmpeg-static` has **no `win32-arm64`** build (and `darwin`/`linux` arm64 are
the only arm builds it ships). On a Windows arm64 dev box the static binary is
absent — `ffmpeg-static` resolves to `null` and the engine falls back to a
system `ffmpeg`. To render locally:

- Install ffmpeg and put it on `PATH` (`winget install Gyan.FFmpeg`,
  `brew install ffmpeg`, `apt install ffmpeg`), **or**
- Point `FFMPEG_BIN` at an ffmpeg executable.

The dependency is installed with `--ignore-scripts` locally specifically to skip
the failing arm64 binary download; this does **not** affect the Vercel build,
which runs scripts normally and fetches the linux binary.

`tsc` and `vitest` never execute ffmpeg — the engine's pure helpers (duration
math, filter graph, arg vector, SVG) are unit-tested in isolation
(`tests/ffmpeg-slideshow.test.ts`), so the test suite is green without a binary.

## Storage & delivery (Vercel Blob)

The render writes the MP4 to a local path (`resolveVideoOutputPath`): `/tmp/videos/`
on Vercel, `public/social-videos/` in local dev. **On Vercel `/tmp` is per-instance
and ephemeral** — a render on instance A and a later `GET /api/video-serve/:id` on
instance B would 404. So after a successful render, `runFfmpegGeneration`
(`src/app/api/videos/generate/route.ts`) uploads the MP4 to **Vercel Blob** and
stores the permanent absolute URL in `video_jobs.video_url`:

```ts
const fileBuffer = await readFile(outputPath);
const blob = await put(`videos/video-${jobId}.mp4`, fileBuffer, {
  access: "public",
  contentType: "video/mp4",
  addRandomSuffix: false,   // stable path: a re-render overwrites the same blob
  allowOverwrite: true,
});
// video_url = blob.url   (e.g. https://<store>.public.blob.vercel-storage.com/videos/video-7.mp4)
```

`GET /api/video-serve/:id` already prefers `video_url` and **302-redirects** to it
when it is an `http(s)` URL (the Facebook/Instagram Graph APIs fetch the hosted
URL directly when publishing a Reel), so no change was needed there.

**Config:** set `BLOB_READ_WRITE_TOKEN` in `.env.local` (gitignored) and in the
Vercel project env. Get it from the Vercel dashboard → Storage → your Blob store →
**Read/Write Token**. The `@vercel/blob` SDK reads the token from this env var
automatically.

**Local-dev fallback:** when `BLOB_READ_WRITE_TOKEN` is **unset**, the upload is
skipped and `video_url` falls back to `/api/video-serve/:id`, which streams the
file straight from `public/social-videos/` (with Range support) — so local
playback works with no Blob account. A Blob upload failure on Vercel marks the
job `error` (a video that can't be served durably is treated as a failed render).

## Music

Add royalty-free tracks under `public/music/` (see that folder's README). Empty
folder ⇒ silent video, no error.
