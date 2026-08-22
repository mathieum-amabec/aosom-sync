/**
 * Brand tokens for the FFmpeg video pipeline (Ameublo Direct / Furnish Direct).
 *
 * Single source of truth for the visual identity applied to generated product
 * videos — colors, typography, logos, output format, the bottom branded band,
 * and background music defaults. The slideshow engine
 * (src/lib/video-engines/ffmpeg-slideshow.ts) reads from here so a brand tweak
 * is a one-file change rather than scattered magic numbers across the pipeline.
 *
 * Paths under `logos` and `music.dir` are repo-relative (resolved against the
 * project root / public dir at render time), not URLs.
 */
export const VIDEO_BRAND = {
  colors: {
    navy: '#1A2340',
    gold: '#D4A853',
    offWhite: '#FAFAF8',
  },
  font: {
    family: 'DM Sans',
    titleWeight: 700,
    bodyWeight: 400,
  },
  logos: {
    fr: 'Logo/logo-fr.png',
    en: 'Logo/logo-en.png',
  },
  format: {
    width: 1080,
    height: 1920,
    aspectRatio: '9:16',
    // min lowered from 15→6 so the 2.4s/slide baseline is honored for the
    // realistic 3-6 product range (3→7.2s … 6→14.4s). 1-2 products floor to 6s
    // (a literal 2.4s single-slide clip isn't a publishable video).
    durationTarget: { min: 6, max: 30 },
  },
  overlay: {
    bandHeight: 200,
    storeUrl: 'ameublodirect.ca',
  },
  music: {
    dir: 'public/music/',
    volume: -12, // dB
  },
} as const;
