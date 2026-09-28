/**
 * Studio music library — tracks live in the public Blob store under `studio/music/`, so the
 * Vercel renderer can download them (the local src/audio folder is gitignored and never
 * deployed). Seeded by scripts/studio-seed-music.mjs; Mat can add tracks from the /studio page.
 */
import { list } from "@vercel/blob";

export const STUDIO_MUSIC_PREFIX = "studio/music/";

export interface StudioTrack {
  url: string;
  name: string;
  size: number;
}

/** "mixkit-golden-storm-470.mp3" → "Golden Storm" (drops the source prefix and catalogue number). */
export function trackDisplayName(pathname: string): string {
  const file = pathname.split("/").pop() ?? pathname;
  const base = file
    .replace(/\.(mp3|m4a|wav|aac)$/i, "")
    .replace(/^(mixkit|joyinsound|sigmamusicart|pixabay)-/i, "")
    .replace(/(^|-)no-copyright/gi, "")
    .replace(/-\d{2,}$/g, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return base ? base.replace(/\b\w/g, (c) => c.toUpperCase()) : file;
}

export async function listStudioTracks(): Promise<StudioTrack[]> {
  const out: StudioTrack[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: STUDIO_MUSIC_PREFIX, cursor, limit: 1000 });
    for (const b of page.blobs) {
      if (!/\.(mp3|m4a|wav|aac)$/i.test(b.pathname)) continue;
      out.push({ url: b.url, name: trackDisplayName(b.pathname), size: b.size });
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => a.name.localeCompare(b.name, "fr"));
}
