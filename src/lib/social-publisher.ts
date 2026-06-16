/**
 * Multi-channel publishing orchestration.
 * Shared by the API route and the auto-post job so both go through the same code path.
 */
import {
  publishWithImage,
  publishWithImages,
  publishText,
  publishVideo,
  publishFacebookReel,
  facebookBrandCreds,
  type FacebookBrand,
} from "./facebook-client";
import { publishPhoto, publishReel as publishInstagramReel } from "./instagram-client";
import { CHANNEL_META, type ChannelKey } from "./config";
import {
  getFacebookDraft,
  setDraftChannelState,
  updateFacebookDraft,
  type ChannelState,
} from "./database";

/**
 * The branded hero image (GET /api/image-preview) is stored on a draft with locale=fr
 * (Ameublo). For EN channels (Furnish Direct) rewrite that URL's locale to "en" so the
 * compositor uses the EN logo. Only the image-preview URL carries a locale param; raw
 * Aosom product photos (and any other URL) pass through untouched.
 */
export function localizeBrandedImageUrls(urls: string[], language: "FR" | "EN"): string[] {
  const target = language === "EN" ? "en" : "fr";
  return urls.map((u) => {
    if (typeof u !== "string" || !u.includes("/api/image-preview")) return u;
    try {
      const url = new URL(u);
      if (url.searchParams.has("locale")) url.searchParams.set("locale", target);
      return url.toString();
    } catch {
      return u; // relative / non-absolute URL — leave as-is
    }
  });
}

/**
 * Normalized social-post payload — the single source of truth for "which media → which
 * Graph API call". Both the draft publisher (publishDraftToChannel) and the queue consumer
 * (queue-publisher) build one of these so the FB/IG media routing lives in exactly one place.
 */
export interface SocialPayload {
  caption: string;
  brand: FacebookBrand; // === InstagramBrand ("ameublo" | "furnish")
  /** Public image URLs already localized/branded by the caller. */
  imageUrls?: string[];
  /** Square video for the Facebook feed. */
  videoUrl?: string;
  /** Vertical 9:16 video for an Instagram Reel (falls back to videoUrl). */
  reelsVideoUrl?: string;
  /** Optional link for a Facebook text-only post (ignored by Instagram). */
  link?: string;
}

/**
 * Publish one normalized payload to one platform, picking the right Graph API call from the
 * available media:
 *   facebook  → video → multi-photo album (≥2) → single photo → text(+link)
 *   instagram → reel (reelsVideoUrl ?? videoUrl) → single photo (IG requires media)
 * Returns the published post id. Throws on a publish failure or when Instagram has no media.
 */
export async function publishSocialPayload(
  platform: "facebook" | "instagram",
  p: SocialPayload,
): Promise<{ postId: string }> {
  const images = (p.imageUrls ?? []).filter((u) => typeof u === "string" && u.trim() !== "");

  if (platform === "facebook") {
    if (p.videoUrl) {
      const r = await publishVideo({ caption: p.caption, videoUrl: p.videoUrl, brand: p.brand });
      return { postId: r.postId };
    }
    if (images.length >= 2) {
      const r = await publishWithImages({ caption: p.caption, imageUrls: images, brand: p.brand });
      return { postId: r.postId };
    }
    if (images.length === 1) {
      const r = await publishWithImage({ caption: p.caption, imageUrl: images[0], brand: p.brand });
      return { postId: r.postId };
    }
    const r = await publishText({ message: p.caption, brand: p.brand, link: p.link });
    return { postId: r.postId };
  }

  // instagram — requires media; prefer a Reel, else a single photo.
  const reel = p.reelsVideoUrl ?? p.videoUrl;
  if (reel) {
    const r = await publishInstagramReel({ caption: p.caption, videoUrl: reel, brand: p.brand });
    return { postId: r.id };
  }
  if (images.length === 0) {
    throw new Error("Instagram requires an image or video URL");
  }
  const r = await publishPhoto({ caption: p.caption, imageUrl: images[0], brand: p.brand });
  return { postId: r.id };
}

/**
 * Publish a Reel to a Facebook Page from a public video URL.
 *
 * The locale selects the brand's Page token (fr → Ameublo, en → Furnish Direct)
 * while `pageId` is the explicit target Page, so a caller can publish to any Page
 * it owns. `videoUrl` must be publicly fetchable (e.g. a Vercel /api/video-serve
 * URL) — Meta downloads it server-side via the resumable `/video_reels` flow.
 *
 * Instagram Reels are already covered by the draft path (publishDraftToChannel →
 * publishInstagramReel); this is the Facebook-Page counterpart, returning the
 * published reel's post id.
 */
export async function publishReel(options: {
  videoUrl: string;
  caption: string;
  pageId: string;
  locale: "fr" | "en";
}): Promise<{ postId: string }> {
  const brand: FacebookBrand = options.locale === "en" ? "furnish" : "ameublo";
  const { token, label } = facebookBrandCreds(brand);
  const { postId } = await publishFacebookReel({
    caption: options.caption,
    videoUrl: options.videoUrl,
    pageId: options.pageId,
    token,
    label,
  });
  return { postId };
}

/**
 * Publish one draft to one channel. Returns the ChannelState to record.
 * Never throws: on failure returns { status: "error", error }.
 */
export async function publishDraftToChannel(draftId: number, channelKey: ChannelKey): Promise<ChannelState> {
  const draft = await getFacebookDraft(draftId);
  if (!draft) return { status: "error", error: "Draft not found" };

  const meta = CHANNEL_META[channelKey];

  // Refuse to post the wrong language. Legacy drafts (created before bilingual support)
  // and any drafts where EN generation failed won't have postTextEn. Posting French to an
  // EN channel is a brand-level bug, so fail loud instead of falling back.
  if (meta.language === "EN" && !draft.postTextEn) {
    return { status: "error", error: "English caption missing (postTextEn is null); regenerate the draft to publish to EN channels" };
  }
  const caption = meta.language === "FR" ? draft.postText : draft.postTextEn!;

  // Pick public image URLs. Both platforms require at least one (Facebook via Graph API
  // `url` or `attached_media`, Instagram via media container).
  // Priority: draft.imageUrls (v0.1.8.0+ multi-photo) → [draft.imageUrl] (v0.1.5.0 snapshot)
  //   → [draft.unsplashImageUrl] (content_template drafts: themed stock photo)
  //   → [draft.productImage] (JOIN fallback for legacy product drafts).
  // Unsplash beats productImage: content_template drafts carry an incidental real
  // SKU only to satisfy the FK, so that product's image is irrelevant to the post —
  // the themed Unsplash photo is the intended image. unsplashImageUrl is only set
  // for content_template drafts, so product drafts still fall through to productImage.
  const imageUrls =
    draft.imageUrls && draft.imageUrls.length > 0
      ? draft.imageUrls
      : draft.imageUrl
      ? [draft.imageUrl]
      : draft.unsplashImageUrl
      ? [draft.unsplashImageUrl]
      : draft.productImage
      ? [draft.productImage]
      : [];
  // Per-channel logo: EN channels get the EN-branded hero image.
  const localizedImageUrls = localizeBrandedImageUrls(imageUrls, meta.language);
  if (meta.platform !== "facebook" && meta.platform !== "instagram") {
    return { status: "error", error: `Unknown platform: ${meta.platform}` };
  }

  try {
    // Shared FB/IG media routing — the same implementation the queue consumer uses, so the
    // "which media → which Graph call" logic lives in exactly one place (publishSocialPayload).
    const { postId } = await publishSocialPayload(meta.platform, {
      caption,
      brand: meta.brand as FacebookBrand,
      imageUrls: localizedImageUrls,
      videoUrl: draft.videoUrl ?? undefined,
      reelsVideoUrl: draft.reelsVideoUrl ?? undefined,
    });
    return {
      status: "published",
      publishedId: postId,
      publishedAt: Math.floor(Date.now() / 1000),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", error: msg };
  }
}

/**
 * Publish a draft to multiple channels in parallel, recording per-channel state.
 * Returns the per-channel results and the updated draft.
 */
export async function publishDraftToChannels(
  draftId: number,
  channelKeys: ChannelKey[]
): Promise<{ channel: ChannelKey; state: ChannelState }[]> {
  const results = await Promise.all(
    channelKeys.map(async (k) => {
      const state = await publishDraftToChannel(draftId, k);
      await setDraftChannelState(draftId, k, state);
      return { channel: k, state };
    })
  );

  const firstOk = results.find((r) => r.state.status === "published");
  if (firstOk) {
    await updateFacebookDraft(draftId, {
      status: "published",
      published_at: firstOk.state.publishedAt,
      facebook_post_id: firstOk.state.publishedId || null,
    });
  }

  return results;
}
