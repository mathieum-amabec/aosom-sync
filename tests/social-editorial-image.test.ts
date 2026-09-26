/**
 * Editorial (content_template) posts carry a placeholder sku (the first products row — the
 * "Classic Adirondack Chair"). Before 2026-09-25 the direct publish path fell back to that
 * product's photo, and 3 live Facebook posts went out with an unsold chair on unrelated text;
 * the queue path meanwhile dropped the post's real (Unsplash) photo entirely.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/facebook-client", () => ({
  publishVideo: vi.fn().mockResolvedValue({ id: "vid1", postId: "vid1" }),
  publishWithImage: vi.fn().mockResolvedValue({ id: "img1", postId: "img1" }),
  publishWithImages: vi.fn().mockResolvedValue({ id: "alb1", postId: "alb1" }),
  publishText: vi.fn().mockResolvedValue({ id: "txt1", postId: "txt1" }),
}));
vi.mock("@/lib/instagram-client", () => ({ publishPhoto: vi.fn().mockResolvedValue({ id: "ig1", creationId: "c1" }) }));
vi.mock("@/lib/database", () => ({ getFacebookDraft: vi.fn(), setDraftChannelState: vi.fn(), updateFacebookDraft: vi.fn() }));
vi.mock("@/lib/config", () => ({
  CHANNEL_META: {
    fb_ameublo: { platform: "facebook", brand: "ameublo", language: "FR" },
    ig_ameublo: { platform: "instagram", brand: "ameublo", language: "FR" },
  },
}));

import { draftImageUrls, draftToQueueItems, publishDraftToChannel } from "@/lib/social-publisher";
import { publishWithImage, publishText, publishVideo } from "@/lib/facebook-client";
import { getFacebookDraft, type FacebookDraft } from "@/lib/database";

const CHAIR = "https://img-us.aosomcdn.com/adirondack-chair.jpg";
const UNSPLASH = "https://images.unsplash.com/photo-living-room";

function draft(over: Partial<FacebookDraft> = {}): FacebookDraft {
  return {
    id: 7, sku: "01-0016", triggerType: "content_template", language: "fr",
    postText: "Pourquoi ton canapé te paraît énorme?", postTextEn: "Why does your sofa look huge?",
    imagePath: null, imageUrl: null, imageUrls: [], videoUrl: null, reelsVideoUrl: null,
    oldPrice: null, newPrice: null, status: "approved", scheduledAt: null, publishedAt: null,
    facebookPostId: null, channels: {}, createdAt: 0, hookId: null, approvedAt: null, reviewedBy: null,
    reviewNotes: null, unsplashImageUrl: null, unsplashPhotographer: null, unsplashPhotographerUrl: null,
    productImage: CHAIR, productName: "Classic Adirondack Chair Muskoka Chair",
    ...over,
  } as FacebookDraft;
}

describe("draftImageUrls — one rule for both publish paths", () => {
  it("editorial post: its own photos, then Unsplash — never the placeholder product's photo", () => {
    expect(draftImageUrls(draft({ imageUrls: ["a", "b"] }), { allowProductImage: true })).toEqual(["a", "b"]);
    expect(draftImageUrls(draft({ imageUrl: "a" }), { allowProductImage: true })).toEqual(["a"]);
    expect(draftImageUrls(draft({ unsplashImageUrl: UNSPLASH }), { allowProductImage: true })).toEqual([UNSPLASH]);
    expect(draftImageUrls(draft(), { allowProductImage: true })).toEqual([]); // NOT [CHAIR]
  });

  it("product post: the product-photo fallback still applies where the caller allows it", () => {
    const p = draft({ triggerType: "stock_highlight", sku: "84A-148" });
    expect(draftImageUrls(p, { allowProductImage: true })).toEqual([CHAIR]);
    expect(draftImageUrls(p)).toEqual([]); // the queue path never uses the JOIN fallback
  });
});

describe("draftToQueueItems — the queue now carries the editorial photo", () => {
  it("includes the Unsplash photo (it used to be dropped → text-only posts)", () => {
    const [item] = draftToQueueItems(draft({ unsplashImageUrl: UNSPLASH }), ["fb_ameublo"] as never);
    expect(item.payload).toMatchObject({ imageUrl: UNSPLASH, imageUrls: [UNSPLASH] });
  });
  it("never puts the placeholder product photo in the payload", () => {
    const [item] = draftToQueueItems(draft(), ["fb_ameublo"] as never);
    expect(JSON.stringify(item.payload)).not.toContain(CHAIR);
  });
});

describe("publishDraftToChannel — direct 'Publier' on an editorial post", () => {
  beforeEach(() => vi.clearAllMocks());

  it("REFUSES an editorial post with no photo of its own instead of posting the chair", async () => {
    vi.mocked(getFacebookDraft).mockResolvedValue(draft());
    const state = await publishDraftToChannel(7, "fb_ameublo" as never);
    expect(state).toEqual({ status: "error", error: "Contenu éditorial sans photo — ajoutez une photo avant de publier" });
    expect(publishWithImage).not.toHaveBeenCalled();
    expect(publishText).not.toHaveBeenCalled();
  });

  it("publishes an editorial post with its Unsplash photo", async () => {
    vi.mocked(getFacebookDraft).mockResolvedValue(draft({ unsplashImageUrl: UNSPLASH }));
    const state = await publishDraftToChannel(7, "fb_ameublo" as never);
    expect(state.status).toBe("published");
    expect(publishWithImage).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: UNSPLASH }));
  });

  it("an editorial VIDEO post without a photo is not blocked", async () => {
    vi.mocked(getFacebookDraft).mockResolvedValue(draft({ videoUrl: "https://cdn/v.mp4" }));
    const state = await publishDraftToChannel(7, "fb_ameublo" as never);
    expect(state.status).toBe("published");
    expect(publishVideo).toHaveBeenCalled();
  });

  it("product drafts keep their product-photo fallback (unchanged behaviour)", async () => {
    vi.mocked(getFacebookDraft).mockResolvedValue(draft({ triggerType: "stock_highlight", sku: "84A-148" }));
    const state = await publishDraftToChannel(7, "fb_ameublo" as never);
    expect(state.status).toBe("published");
    expect(publishWithImage).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: CHAIR }));
  });
});
