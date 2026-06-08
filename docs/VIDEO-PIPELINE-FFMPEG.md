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

## Music

Add royalty-free tracks under `public/music/` (see that folder's README). Empty
folder ⇒ silent video, no error.
