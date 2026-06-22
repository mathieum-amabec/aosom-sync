import { env, META } from "./config";
import { uploadWatermarkedImage, type HostedWatermark } from "./image-watermark";

/**
 * Instagram Graph API wrapper for Business account publishing.
 *
 * Instagram requires a PUBLIC image_url (Meta's servers fetch it).
 * Unlike Facebook, it does NOT accept binary uploads. So for photos/carousels we stamp
 * the brand footer (see image-watermark.ts), host the watermarked PNG on Vercel Blob,
 * and hand Meta that public URL — then delete the temp blob once publishing is done.
 *
 * Publish flow is two-step:
 *   1. POST /{ig_user_id}/media  → returns creation_id
 *   2. POST /{ig_user_id}/media_publish → publishes the container → returns media_id
 *
 * Reels (vertical 9:16 video) use the same two-step flow with media_type=REELS, but
 * the container must finish server-side processing (Meta downloads + transcodes the
 * MP4) before it can be published — so publishReel polls status_code until FINISHED.
 */

export type InstagramBrand = "ameublo" | "furnish";

export interface InstagramPublishResult {
  id: string;      // media id (the published post)
  creationId: string; // container id used for the publish step
}

interface BrandCreds {
  igUserId: string;
  token: string;
  label: string;
}

function brandCreds(brand: InstagramBrand): BrandCreds {
  if (brand === "ameublo") {
    return {
      igUserId: env.instagramAmeubloAccountId,
      // IG uses the Page Access Token of the linked Facebook Page
      token: env.facebookAmeubloPageToken,
      label: "Instagram Ameublo Direct",
    };
  }
  if (brand === "furnish") {
    const igId = process.env.INSTAGRAM_FURNISH_ACCOUNT_ID;
    if (!igId) throw new Error("INSTAGRAM_FURNISH_ACCOUNT_ID not configured yet");
    return { igUserId: igId, token: env.facebookFurnishPageToken, label: "Instagram Furnish Direct" };
  }
  throw new Error(`Unknown Instagram brand: ${brand}`);
}

/**
 * Test the Instagram connection by fetching account info.
 */
export async function testConnection(brand: InstagramBrand = "ameublo"): Promise<{ username: string; id: string; brand: InstagramBrand }> {
  const { igUserId, token } = brandCreds(brand);
  const res = await fetch(`${META.GRAPH_API_URL}/${igUserId}?fields=username,id`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.error) throw new Error(`${brand}: ${data.error.message}`);
  return { username: data.username, id: data.id, brand };
}

/**
 * Publish a photo post to an Instagram Business account.
 *
 * The source image is watermarked with the brand footer and hosted on Vercel Blob;
 * Meta fetches that public URL server-side (IG can't take a binary upload). The temp
 * blob is deleted in `finally` — by the time publish returns, Meta has already ingested
 * the image at container creation.
 *
 * Note: Instagram caption limit is 2200 characters, up to 30 hashtags.
 */
export async function publishPhoto(opts: {
  caption: string;
  imageUrl: string;
  brand: InstagramBrand;
}): Promise<InstagramPublishResult> {
  const { igUserId, token, label } = brandCreds(opts.brand);

  // Instagram caps captions at 2200 chars; trim defensively
  const caption = opts.caption.length > 2200 ? opts.caption.slice(0, 2197) + "..." : opts.caption;

  // Watermark → host on Blob → hand IG the public URL.
  const hosted = await uploadWatermarkedImage(opts.imageUrl, opts.brand);
  try {
    // Step 1: Create media container
    const createRes = await fetch(`${META.GRAPH_API_URL}/${igUserId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ image_url: hosted.url, caption }),
    });

    if (createRes.status === 429) {
      throw new Error(`${label}: Instagram rate limit, retry later`);
    }

    const createData = await createRes.json();
    if (createData.error) throw new Error(`${label} (create): ${createData.error.message}`);
    const creationId: string = createData.id;
    if (!creationId) throw new Error(`${label}: no creation_id returned`);

    // Step 2: Publish the container
    const publishRes = await fetch(`${META.GRAPH_API_URL}/${igUserId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ creation_id: creationId }),
    });

    const publishData = await publishRes.json();
    if (publishData.error) throw new Error(`${label} (publish): ${publishData.error.message}`);
    return { id: publishData.id, creationId };
  } finally {
    await hosted.cleanup();
  }
}

const CAROUSEL_MIN_ITEMS = 2;
const CAROUSEL_MAX_ITEMS = 10;
const CAROUSEL_UPLOAD_DELAY_MS = 500; // Meta throttles rapid /media POSTs (mirrors the FB album path)

/**
 * Publish a multi-photo carousel to an Instagram Business account (2–10 images).
 *
 * Three-step flow (per Meta Graph API docs):
 *   1. One child container per image → POST /{ig-user-id}/media with image_url +
 *      is_carousel_item=true (NO caption on children). Collect each returned id.
 *   2. Carousel container → POST /{ig-user-id}/media with media_type=CAROUSEL,
 *      children=<child ids>, and the caption.
 *   3. Publish → POST /{ig-user-id}/media_publish with the carousel creation_id.
 *
 * Unlike Reels, image containers process near-instantly, so (like publishPhoto)
 * there's no status polling. Every child upload must succeed: a partial carousel
 * would publish in the wrong order / with missing photos, so any child failure
 * aborts before publishing. Use publishPhoto for a single image.
 */
export async function publishCarousel(opts: {
  caption: string;
  imageUrls: string[];
  brand: InstagramBrand;
}): Promise<InstagramPublishResult> {
  if (opts.imageUrls.length < CAROUSEL_MIN_ITEMS || opts.imageUrls.length > CAROUSEL_MAX_ITEMS) {
    throw new Error(
      `Instagram carousel requires ${CAROUSEL_MIN_ITEMS}–${CAROUSEL_MAX_ITEMS} images (got ${opts.imageUrls.length})`,
    );
  }

  const { igUserId, token, label } = brandCreds(opts.brand);
  const caption = opts.caption.length > 2200 ? opts.caption.slice(0, 2197) + "..." : opts.caption;

  // Each child needs a public URL, so watermark+host every image on Blob; track the
  // hosted blobs so we can delete them all once publishing finishes (or fails).
  const hosted: HostedWatermark[] = [];
  try {
    // Step 1: create one child container per image (no caption on children).
    const childIds: string[] = [];
    for (let i = 0; i < opts.imageUrls.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, CAROUSEL_UPLOAD_DELAY_MS));
      const h = await uploadWatermarkedImage(opts.imageUrls[i], opts.brand);
      hosted.push(h);
      const res = await fetch(`${META.GRAPH_API_URL}/${igUserId}/media`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ image_url: h.url, is_carousel_item: true }),
      });
      if (res.status === 429) throw new Error(`${label}: Instagram rate limit on carousel item ${i + 1}, retry later`);
      const data = await res.json();
      if (data.error) throw new Error(`${label} (carousel item ${i + 1}): ${data.error.message}`);
      if (!data.id) throw new Error(`${label}: no creation_id for carousel item ${i + 1}`);
      childIds.push(String(data.id));
    }

    // Step 2: create the parent CAROUSEL container referencing the children.
    const createRes = await fetch(`${META.GRAPH_API_URL}/${igUserId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ media_type: "CAROUSEL", children: childIds.join(","), caption }),
    });
    if (createRes.status === 429) throw new Error(`${label}: Instagram rate limit on carousel container, retry later`);
    const createData = await createRes.json();
    if (createData.error) throw new Error(`${label} (create carousel): ${createData.error.message}`);
    const creationId: string = createData.id;
    if (!creationId) throw new Error(`${label}: no creation_id returned for carousel`);

    // Step 3: publish the carousel container.
    const publishRes = await fetch(`${META.GRAPH_API_URL}/${igUserId}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ creation_id: creationId }),
    });
    const publishData = await publishRes.json();
    if (publishData.error) throw new Error(`${label} (publish carousel): ${publishData.error.message}`);
    console.log(`[PUBLISH] ${label} carousel posted with ${childIds.length} photos (media: ${publishData.id})`);
    return { id: publishData.id, creationId };
  } finally {
    await Promise.all(hosted.map((h) => h.cleanup()));
  }
}

const REEL_POLL_INTERVAL_MS = 4_000;
const REEL_POLL_TIMEOUT_MS = 120_000; // IG transcode of a short clip is usually < 1min

/** Poll a media container until it finishes processing. Resolves when the container
 * is FINISHED, throws on ERROR/EXPIRED or when it isn't ready before the timeout. */
async function waitForContainerReady(
  creationId: string,
  token: string,
  label: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? REEL_POLL_INTERVAL_MS;
  const deadline = Date.now() + (opts.timeoutMs ?? REEL_POLL_TIMEOUT_MS);
  for (;;) {
    const res = await fetch(`${META.GRAPH_API_URL}/${creationId}?fields=status_code,status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.error) throw new Error(`${label} (status): ${data.error.message}`);
    const code = data.status_code as string | undefined;
    if (code === "FINISHED") return;
    if (code === "ERROR" || code === "EXPIRED") {
      throw new Error(`${label}: reel container ${code}${data.status ? ` — ${data.status}` : ""}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label}: reel container not ready after ${Math.round((opts.timeoutMs ?? REEL_POLL_TIMEOUT_MS) / 1000)}s (last status ${code ?? "unknown"})`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Publish a Reel (vertical 9:16 video) to an Instagram Business account.
 * videoUrl MUST be a public MP4 URL — Meta fetches and transcodes it server-side.
 *
 * Three steps: create a REELS container, poll until it finishes processing, then
 * publish. `opts` lets tests shrink the poll interval/timeout.
 */
export async function publishReel(opts: {
  caption: string;
  videoUrl: string;
  brand: InstagramBrand;
  poll?: { intervalMs?: number; timeoutMs?: number };
}): Promise<InstagramPublishResult> {
  const { igUserId, token, label } = brandCreds(opts.brand);
  const caption = opts.caption.length > 2200 ? opts.caption.slice(0, 2197) + "..." : opts.caption;

  // Step 1: create the REELS media container.
  const createRes = await fetch(`${META.GRAPH_API_URL}/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ media_type: "REELS", video_url: opts.videoUrl, caption }),
  });
  if (createRes.status === 429) throw new Error(`${label}: Instagram rate limit, retry later`);
  const createData = await createRes.json();
  if (createData.error) throw new Error(`${label} (create reel): ${createData.error.message}`);
  const creationId: string = createData.id;
  if (!creationId) throw new Error(`${label}: no creation_id returned for reel`);

  // Step 2: wait for Meta to finish downloading/transcoding the video.
  await waitForContainerReady(creationId, token, label, opts.poll);

  // Step 3: publish the finished container.
  const publishRes = await fetch(`${META.GRAPH_API_URL}/${igUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ creation_id: creationId }),
  });
  const publishData = await publishRes.json();
  if (publishData.error) throw new Error(`${label} (publish reel): ${publishData.error.message}`);
  return { id: publishData.id, creationId };
}
