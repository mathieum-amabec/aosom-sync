/**
 * Beds withdrawn from automatic selection.
 *
 * WHY THIS EXISTS AS A LIST RATHER THAN A DELETED FILE
 * The mp3s under `src/audio/` are gitignored, so "retiring" a bed by deleting it works only
 * on the one machine that deletes it. Every other clone still has the file, and both pickers
 * below enumerate the directory — so the retired bed would quietly come back. A list in the
 * code is the only form of retirement that travels with the repo.
 *
 * Retirement is about AUTOMATIC selection only. A retired file is still perfectly usable when
 * something names it explicitly (a pinned `musicUrl`, a one-off script), and its TRACK_GAIN
 * entry is deliberately kept so that an explicit use is still level-matched.
 *
 * ── the roster ────────────────────────────────────────────────────────────
 * mixkit-corporate-22.mp3 — retired 2026-09-10. Held the `bureau` family until Golden Storm
 *   replaced it; rejected on listening as too downbeat, and it measured as the slowest-moving
 *   bed in the pool (194 onsets/min). Removing it from the family was not enough on its own:
 *   pickMusic's no-family fallback and the slideshow's uniform-random picker both enumerate
 *   the whole directory, so it could still have surfaced on a product whose type matches no
 *   family, or on any slideshow render.
 */

/** Filenames only, matched case-insensitively against the basename of any path. */
export const RETIRED_TRACKS: readonly string[] = ["mixkit-corporate-22.mp3"];

/** Basename of a path that may use either separator — the audio pool mixes both on Windows. */
export function trackBasename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf(String.fromCharCode(92)));
  return i >= 0 ? p.slice(i + 1) : p;
}

export function isRetiredTrack(p: string): boolean {
  const b = trackBasename(p).toLowerCase();
  return RETIRED_TRACKS.some((r) => r.toLowerCase() === b);
}

/**
 * Drop retired beds from a candidate pool.
 *
 * Returns the pool UNCHANGED when every candidate is retired. A silent or crashed render is
 * worse than a bed nobody loves, and both callers treat an empty pool as a hard failure — so
 * the retirement yields rather than taking the last track away.
 */
export function dropRetiredTracks(pool: string[]): string[] {
  const kept = pool.filter((p) => !isRetiredTrack(p));
  return kept.length > 0 ? kept : pool;
}
