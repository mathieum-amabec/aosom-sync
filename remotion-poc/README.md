# Remotion POC — spike, not production

Reproduces the v3 ffmpeg ad design (v0.5.84.0, PR #454) in Remotion, to compare quality,
reliability and render time. **Nothing in the production video pipeline is touched.**

## Why

Three structural limits were hit building the ffmpeg creative:

1. `drawbox` refuses an animated alpha inside its colour (`black@'min(1,t)'` → *Invalid alpha
   value specifier*), so opacity and geometry had to be driven by different mechanisms.
2. An expression `fontsize` **segfaults ffmpeg 8.1.1** mid-encode (exit 139, empty stderr,
   truncated file). The price "pop" is faked with constant-size draws gated by `enable=`.
3. ffmpeg cannot report text width, so the word-by-word hook computes every word's x in
   TypeScript from a 0.6-em guess. Getting that wrong stacked the whole headline on one spot.

## What is pinned

`v3-inputs.json` carries the Vision segment, the product zone, the Haiku copy, the font sizes
and the music pick **verbatim from the ffmpeg run's own stdout**. Nothing is recomputed — no
Vision call, no Haiku call, no re-hash. The engine is the only variable.

## Run

```
npm install
node render.mjs          # POC_OUT overrides the output directory
```

Needs the assets under `public/` (gitignored — they are the same binaries the production
pipeline reads):

```
public/clips/{836-068WT,833-804WT,D04-169}.mp4   <- src/ugc/
public/audio/*.mp3                                <- src/audio/
public/brand/logo.png                             <- Logo/officiel-transparent.png
public/brand/DMSans.ttf                           <- fonts/DMSans.ttf
```

## Licence

Remotion 4.0.522. The free licence covers "a for-profit organization with up to 3 employees"
for commercial video. Note the terms change in Remotion 5.0.
