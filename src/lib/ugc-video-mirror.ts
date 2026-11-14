/**
 * Customer unboxing videos are served from OUR public Vercel Blob store, not
 * hotlinked from the supplier CDN.
 *
 * Why: the supplier URL (…/customer/CA/<sku>.mp4 on the supplier's CDN) put the
 * supplier's name in our storefront's network requests (supplier names are
 * forbidden client-facing), and the homepage reel went blank if the supplier ever
 * moved or blocked the files.
 *
 * How: `scripts/mirror-ugc-videos.mjs` copies each video to a DETERMINISTIC blob
 * path (`ugc-videos/<CA|US>/<file>.mp4`, no random suffix) and lists the mirrored
 * paths in `ugc-videos/manifest.json`. The reel reads that manifest (public, edge
 * cached) and swaps in the mirrored URL. A video not mirrored yet keeps working
 * from its source URL, but mirrored videos are always picked first.
 */

/** Canonical PUBLIC blob store (see CLAUDE.md "Demand-gen uploads need a PUBLIC Blob store"). */
export const UGC_BLOB_BASE =
  process.env.UGC_VIDEO_BASE_URL?.replace(/\/+$/, "") ||
  "https://jcskqp8orcub9i0l.public.blob.vercel-storage.com";

export const UGC_MANIFEST_PATH = "ugc-videos/manifest.json";

/** Blob pathname for a supplier customer-video URL, or null if it is not one. */
export function mirrorPathFor(sourceUrl: string): string | null {
  const m = sourceUrl.match(/\/customer\/(CA|US)\/([A-Za-z0-9._-]+\.mp4)(?:[?#].*)?$/i);
  return m ? `ugc-videos/${m[1].toUpperCase()}/${m[2]}` : null;
}

export function mirrorUrlFor(path: string, base = UGC_BLOB_BASE): string {
  return `${base}/${path}`;
}

export interface UgcManifest {
  /** Mirrored blob pathnames (e.g. "ugc-videos/CA/831-930V00CW.mp4"). */
  paths: string[];
  updatedAt?: string;
}

/** Read the mirror manifest. Any failure = nothing mirrored (the reel falls back to source URLs). */
export async function loadMirroredPaths(fetchImpl: typeof fetch = fetch): Promise<Set<string>> {
  try {
    const res = await fetchImpl(mirrorUrlFor(UGC_MANIFEST_PATH), { next: { revalidate: 1800 } } as RequestInit);
    if (!res.ok) return new Set();
    const data = (await res.json()) as Partial<UgcManifest>;
    return new Set(Array.isArray(data.paths) ? data.paths.filter((p) => typeof p === "string") : []);
  } catch {
    return new Set();
  }
}

/** The URL the storefront should play: our mirror when present, else the source. */
export function resolveVideoUrl(sourceUrl: string, mirrored: Set<string>): { url: string; mirrored: boolean } {
  const path = mirrorPathFor(sourceUrl);
  if (path && mirrored.has(path)) return { url: mirrorUrlFor(path), mirrored: true };
  return { url: sourceUrl, mirrored: false };
}

/**
 * Stable re-order: mirrored candidates first (keeping their relative order, i.e.
 * most-in-stock first), then the rest. Unmirrored ones only fill leftover slots.
 */
export function mirroredFirst<T extends { videoUgc: string }>(candidates: T[], mirrored: Set<string>): T[] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const c of candidates) {
    const p = mirrorPathFor(c.videoUgc);
    (p && mirrored.has(p) ? yes : no).push(c);
  }
  return [...yes, ...no];
}
