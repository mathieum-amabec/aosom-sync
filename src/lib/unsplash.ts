/**
 * Thin wrapper around unsplash-js for blog article image fetching.
 *
 * Unsplash API guideline (https://help.unsplash.com/en/articles/2511258):
 * when an application *uses* a photo (displays it to a user), it must call
 * the photo's `download_location` endpoint. This is not the same as the
 * direct image download — it just records the use for the photographer's
 * stats. `triggerDownload` does that.
 *
 * Attribution: every displayed Unsplash photo must credit the photographer
 * by name with a link to their Unsplash profile, and include a link back
 * to Unsplash. Both links must carry `utm_source=<app>&utm_medium=referral`.
 */

import { createApi } from "unsplash-js";
import type { ApiResponse } from "unsplash-js/dist/helpers/response";
import type { Photos } from "unsplash-js/dist/methods/search/types/response";
import { env } from "./config";

export interface UnsplashImage {
  id: string;
  url: string;
  altDescription: string;
  photographer: string;
  photographerUrl: string;
  unsplashUrl: string;
  downloadLocation: string;
}

let cachedApi: ReturnType<typeof createApi> | null = null;

function getApi(): ReturnType<typeof createApi> {
  if (!cachedApi) {
    // Node 18+ has global fetch. Pass it explicitly so unsplash-js does
    // not try to import `node-fetch` (which is not a dep here).
    cachedApi = createApi({
      accessKey: env.unsplashAccessKey,
      fetch: globalThis.fetch,
    });
  }
  return cachedApi;
}

function buildAttributionUrl(base: string): string {
  const app = encodeURIComponent(env.unsplashAppName);
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}utm_source=${app}&utm_medium=referral`;
}

/**
 * Search Unsplash for landscape photos matching `query`. Returns up to
 * `count` images, oldest-first within Unsplash's relevance ordering.
 *
 * Throws on API error so callers can fail fast instead of inserting
 * silently broken image markup into an article.
 */
export async function searchImages(
  query: string,
  count: number = 3,
): Promise<UnsplashImage[]> {
  if (!query.trim()) {
    throw new Error("searchImages: query must be non-empty");
  }
  const safeCount = Math.max(1, Math.min(30, Math.floor(count)));

  const api = getApi();
  const result: ApiResponse<Photos> = await api.search.getPhotos({
    query,
    perPage: safeCount,
    orientation: "landscape",
    contentFilter: "high",
  });

  if (result.type !== "success") {
    const msg = Array.isArray(result.errors) ? result.errors.join("; ") : "unknown error";
    throw new Error(`Unsplash search failed for "${query}": ${msg}`);
  }

  const photos = result.response?.results ?? [];
  if (photos.length === 0) {
    throw new Error(`Unsplash returned no results for "${query}"`);
  }

  return photos.slice(0, safeCount).map((p): UnsplashImage => ({
    id: p.id,
    url: p.urls.regular,
    altDescription: (p.alt_description || p.description || query).slice(0, 200),
    photographer: p.user.name,
    photographerUrl: buildAttributionUrl(p.user.links.html),
    unsplashUrl: buildAttributionUrl("https://unsplash.com/"),
    downloadLocation: p.links.download_location,
  }));
}

/**
 * Notify Unsplash that an image is being used. Required by the API
 * guidelines whenever an image is rendered to a user.
 *
 * Non-fatal: logs but does not throw. Failing the article create over
 * a download-ping error would be worse than missing one ping.
 */
export async function triggerDownload(downloadLocation: string): Promise<void> {
  if (!downloadLocation) return;
  try {
    const api = getApi();
    const result = await api.photos.trackDownload({ downloadLocation });
    if (result.type !== "success") {
      const msg = Array.isArray(result.errors) ? result.errors.join("; ") : "unknown";
      console.warn(`[unsplash] trackDownload non-success: ${msg}`);
    }
  } catch (err) {
    console.warn(`[unsplash] trackDownload threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}
