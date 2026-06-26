/**
 * Default royalty-free music for slideshow renders.
 *
 * The project already ships two no-copyright tracks under `src/audio/` (used by
 * scripts/render-demand-gen.mjs) and any number under `public/music/` (used by
 * the ffmpeg slideshow engine). getDefaultMusicTrack resolves an absolute path
 * to one of those existing tracks so renders stay on cleared, royalty-free
 * audio — no new licensing surface is introduced.
 *
 * Returns null (never throws) when no track is bundled, so the renderer can
 * fall back to a silent video rather than failing the whole job.
 */
import path from "path";
import fs from "fs";

/** The no-copyright track render-demand-gen.mjs settled on (chill / ambient). */
const PREFERRED_TRACK = "src/audio/joyinsound-no-copyright-chill-music-403411.mp3";

const AUDIO_EXT = /\.(mp3|m4a|aac|wav|ogg)$/i;

/** First royalty-free track found under `dir` (absolute paths), or []. */
function listTracks(dir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((f) => AUDIO_EXT.test(f)).map((f) => path.join(dir, f));
}

/**
 * Absolute path to the default royalty-free music track, or null if none is
 * bundled. Resolution order:
 *   1. The preferred `src/audio` ambient track (the demand-gen default).
 *   2. Any other `src/audio/*` track.
 *   3. Any `public/music/*` track (the slideshow engine's library).
 */
export function getDefaultMusicTrack(): string | null {
  const root = process.cwd();

  const preferred = path.resolve(root, PREFERRED_TRACK);
  if (fs.existsSync(preferred)) return preferred;

  const fromAudio = listTracks(path.resolve(root, "src/audio"));
  if (fromAudio.length > 0) return fromAudio[0];

  const fromPublic = listTracks(path.resolve(root, "public/music"));
  if (fromPublic.length > 0) return fromPublic[0];

  // TODO: bundle a royalty-free track under src/audio/ or public/music/ —
  // none found, so renders fall back to a silent video.
  return null;
}
