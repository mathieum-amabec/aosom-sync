/**
 * Ameublo mascot guard — the little sofa with a witch hat is OFF the air (Mat, 2026-10-07: "on enlève
 * complètement le personnage Ameublo et on garde des vidéos réelles").
 *
 * Every Ameublo Studio render (source `ameublo_studio`) burns the mascot into the frame, EXCEPT the
 * faceless real-footage `emotion` style. A mascot video slipped onto the 06:00 slot the morning
 * after the decision, so the block is enforced at both ends: approval refuses to enqueue it, and the
 * publisher refuses to post it if a row got in anyway (old rows, direct DB writes).
 *
 * To bring the mascot back, flip MASCOT_VIDEOS_ALLOWED in a reviewed PR — never at runtime. A row can
 * opt out individually with `metadata.mascotFree === true` (real footage routed through the Studio).
 */
export const MASCOT_VIDEOS_ALLOWED = false;

/** Studio styles verified to carry NO mascot (faceless UGC / real footage). */
const MASCOT_FREE_STYLES: ReadonlySet<string> = new Set(["emotion"]);

export class MascotBlockedError extends Error {
  constructor(detail: string) {
    super(`mascot_blocked: ${detail}`);
    this.name = "MascotBlockedError";
  }
}

/** True when a queue row / Studio video would publish the mascot. Non-Studio rows never do. */
export function carriesMascot(meta: { source?: unknown; style?: unknown; mascotFree?: unknown } | null | undefined): boolean {
  if (!meta || meta.source !== "ameublo_studio") return false;
  if (meta.mascotFree === true) return false;
  return !MASCOT_FREE_STYLES.has(String(meta.style ?? ""));
}

/** Human-readable reason the row is blocked, or null when it may proceed. */
export function mascotBlockReason(meta: { source?: unknown; style?: unknown; mascotFree?: unknown } | null | undefined): string | null {
  if (MASCOT_VIDEOS_ALLOWED || !carriesMascot(meta)) return null;
  return `les vidéos avec la mascotte Ameublo sont désactivées (style « ${String(meta?.style ?? "?")} »). Seules les vidéos réelles sont publiées.`;
}

/** Throw MascotBlockedError when the row would publish the mascot. */
export function assertNoMascot(meta: { source?: unknown; style?: unknown; mascotFree?: unknown } | null | undefined): void {
  const reason = mascotBlockReason(meta);
  if (reason) throw new MascotBlockedError(reason);
}
