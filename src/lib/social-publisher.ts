/**
 * Multi-channel publishing orchestration.
 * Shared by the API route and the auto-post job so both go through the same code path.
 */
import { publishWithImage, publishWithImages, publishText, type FacebookBrand } from "./facebook-client";
import { publishPhoto } from "./instagram-client";
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
  const primaryImageUrl = localizedImageUrls[0] || null;

  try {
    if (meta.platform === "facebook") {
      const brand = meta.brand as FacebookBrand;
      // Multi-photo album when 2+ URLs, single-photo when 1, text-only when none.
      const result =
        imageUrls.length >= 2
          ? await publishWithImages({ caption, imageUrls: localizedImageUrls, brand })
          : primaryImageUrl
          ? await publishWithImage({ caption, imageUrl: primaryImageUrl, brand })
          : await publishText({ message: caption, brand });
      return {
        status: "published",
        publishedId: result.postId,
        publishedAt: Math.floor(Date.now() / 1000),
      };
    }

    if (meta.platform === "instagram") {
      if (!primaryImageUrl) {
        return { status: "error", error: "No public image URL available for Instagram (draft.imageUrls empty — regenerate draft)" };
      }
      // TODO: IG carousel (3 API calls + parent container) — out of scope for v0.1.8.0.
      // For now, post only the primary image to IG.
      const result = await publishPhoto({
        caption,
        imageUrl: primaryImageUrl,
        brand: meta.brand as "ameublo" | "furnish",
      });
      return {
        status: "published",
        publishedId: result.id,
        publishedAt: Math.floor(Date.now() / 1000),
      };
    }

    return { status: "error", error: `Unknown platform: ${meta.platform}` };
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
