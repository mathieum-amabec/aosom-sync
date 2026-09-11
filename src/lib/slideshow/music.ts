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
import { isRetiredTrack } from "@/lib/music-retired";

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

  // These two are positional ("first file in the directory"), so a retired bed that sorts
  // early would become the default for every render that does not pin a track.
  const fromAudio = listTracks(path.resolve(root, "src/audio")).filter((t) => !isRetiredTrack(t));
  if (fromAudio.length > 0) return fromAudio[0];

  const fromPublic = listTracks(path.resolve(root, "public/music")).filter((t) => !isRetiredTrack(t));
  if (fromPublic.length > 0) return fromPublic[0];

  // TODO: bundle a royalty-free track under src/audio/ or public/music/ —
  // none found, so renders fall back to a silent video.
  return null;
}

/** All bundled royalty-free tracks (src/audio + public/music), absolute paths. */
export function listAllMusicTracks(): string[] {
  const root = process.cwd();
  // Retired beds are dropped here, which covers pickMusicTrack() too since it draws from
  // this list. Without it a bed pulled from a family would still surface on slideshows,
  // which enumerate the same directory.
  //
  // This is a HARD filter, unlike pickMusic's fallback: a slideshow with no track renders
  // silent by design (pickMusicTrack returns null), so there is no crash to avoid by
  // keeping a retired bed as the last resort.
  return [
    ...listTracks(path.resolve(root, "src/audio")),
    ...listTracks(path.resolve(root, "public/music")),
  ].filter((t) => !isRetiredTrack(t));
}

/**
 * A uniformly-random bundled track for this render, so consecutive slideshows don't
 * all share the same music (rotation). Unlike getDefaultMusicTrack() it does NOT
 * prefer PREFERRED_TRACK — every bundled track has an equal chance. With one track
 * bundled it returns that track; with none it returns null (silent video).
 */
export function pickMusicTrack(): string | null {
  const all = listAllMusicTracks();
  if (all.length === 0) return null;
  return all[Math.floor(Math.random() * all.length)];
}
