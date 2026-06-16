import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/facebook-client", () => ({
  publishVideo: vi.fn().mockResolvedValue({ id: "fb-vid", postId: "fb-vid" }),
  publishWithImage: vi.fn().mockResolvedValue({ id: "fb-img", postId: "fb-img" }),
  publishWithImages: vi.fn().mockResolvedValue({ id: "fb-alb", postId: "fb-alb" }),
  publishText: vi.fn().mockResolvedValue({ id: "fb-txt", postId: "fb-txt" }),
  publishFacebookReel: vi.fn(),
  facebookBrandCreds: vi.fn(),
}));
vi.mock("@/lib/instagram-client", () => ({
  publishPhoto: vi.fn().mockResolvedValue({ id: "ig-photo", creationId: "c1" }),
  publishCarousel: vi.fn().mockResolvedValue({ id: "ig-carousel", creationId: "c3" }),
  publishReel: vi.fn().mockResolvedValue({ id: "ig-reel", creationId: "c2" }),
}));
vi.mock("@/lib/config", () => ({ CHANNEL_META: {} }));
vi.mock("@/lib/database", () => ({
  getFacebookDraft: vi.fn(),
  setDraftChannelState: vi.fn(),
  updateFacebookDraft: vi.fn(),
}));

import { publishSocialPayload } from "@/lib/social-publisher";
import {
  publishVideo,
  publishWithImage,
  publishWithImages,
  publishText,
} from "@/lib/facebook-client";
import { publishPhoto, publishCarousel, publishReel } from "@/lib/instagram-client";

const base = { caption: "Bonjour", brand: "ameublo" as const };

beforeEach(() => vi.clearAllMocks());

describe("publishSocialPayload — facebook routing", () => {
  it("video → publishVideo, returns postId", async () => {
    const r = await publishSocialPayload("facebook", { ...base, videoUrl: "v.mp4", imageUrls: ["a.jpg"] });
    expect(publishVideo).toHaveBeenCalledWith(expect.objectContaining({ videoUrl: "v.mp4", brand: "ameublo", caption: "Bonjour" }));
    expect(publishWithImages).not.toHaveBeenCalled();
    expect(r).toEqual({ postId: "fb-vid" });
  });

  it("2+ images → publishWithImages (album)", async () => {
    await publishSocialPayload("facebook", { ...base, imageUrls: ["a.jpg", "b.jpg"] });
    expect(publishWithImages).toHaveBeenCalledWith(expect.objectContaining({ imageUrls: ["a.jpg", "b.jpg"] }));
    expect(publishWithImage).not.toHaveBeenCalled();
  });

  it("single image → publishWithImage", async () => {
    await publishSocialPayload("facebook", { ...base, imageUrls: ["a.jpg"] });
    expect(publishWithImage).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: "a.jpg" }));
  });

  it("no media → publishText with link", async () => {
    const r = await publishSocialPayload("facebook", { ...base, link: "https://shop/x" });
    expect(publishText).toHaveBeenCalledWith(expect.objectContaining({ message: "Bonjour", link: "https://shop/x" }));
    expect(r).toEqual({ postId: "fb-txt" });
  });

  it("ignores blank/whitespace image URLs", async () => {
    await publishSocialPayload("facebook", { ...base, imageUrls: ["", "  "] });
    expect(publishText).toHaveBeenCalled(); // all filtered → text post
    expect(publishWithImage).not.toHaveBeenCalled();
  });
});

describe("publishSocialPayload — instagram routing", () => {
  it("reelsVideoUrl → publishReel, returns the media id as postId", async () => {
    const r = await publishSocialPayload("instagram", { ...base, reelsVideoUrl: "r.mp4", imageUrls: ["a.jpg"] });
    expect(publishReel).toHaveBeenCalledWith(expect.objectContaining({ videoUrl: "r.mp4" }));
    expect(r).toEqual({ postId: "ig-reel" });
  });

  it("falls back to videoUrl for the reel when reelsVideoUrl is absent", async () => {
    await publishSocialPayload("instagram", { ...base, videoUrl: "sq.mp4" });
    expect(publishReel).toHaveBeenCalledWith(expect.objectContaining({ videoUrl: "sq.mp4" }));
  });

  it("single image → publishPhoto", async () => {
    const r = await publishSocialPayload("instagram", { ...base, imageUrls: ["a.jpg"] });
    expect(publishPhoto).toHaveBeenCalledWith(expect.objectContaining({ imageUrl: "a.jpg" }));
    expect(publishCarousel).not.toHaveBeenCalled();
    expect(r).toEqual({ postId: "ig-photo" });
  });

  it("2+ images → publishCarousel, returns the media id as postId", async () => {
    const r = await publishSocialPayload("instagram", { ...base, imageUrls: ["a.jpg", "b.jpg"] });
    expect(publishCarousel).toHaveBeenCalledWith(expect.objectContaining({ imageUrls: ["a.jpg", "b.jpg"] }));
    expect(publishPhoto).not.toHaveBeenCalled();
    expect(r).toEqual({ postId: "ig-carousel" });
  });

  it("caps a >10-image carousel at 10 items", async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `${i}.jpg`);
    await publishSocialPayload("instagram", { ...base, imageUrls: urls });
    expect(publishCarousel).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrls: urls.slice(0, 10) }),
    );
  });

  it("no media → throws (IG requires media)", async () => {
    await expect(publishSocialPayload("instagram", { ...base })).rejects.toThrow(/requires an image or video/i);
    expect(publishPhoto).not.toHaveBeenCalled();
  });
});
