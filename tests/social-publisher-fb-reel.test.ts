import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/facebook-client", () => ({
  publishFacebookReel: vi.fn().mockResolvedValue({ id: "reel1", postId: "reel1" }),
  facebookBrandCreds: vi.fn((brand: string) =>
    brand === "furnish"
      ? { pageId: "FURNISH_PAGE", token: "FURNISH_TOK", label: "Furnish Direct" }
      : { pageId: "AMEUBLO_PAGE", token: "AMEUBLO_TOK", label: "Ameublo Direct" },
  ),
  // unused by this test but imported by social-publisher
  publishWithImage: vi.fn(),
  publishWithImages: vi.fn(),
  publishText: vi.fn(),
  publishVideo: vi.fn(),
}));
vi.mock("@/lib/instagram-client", () => ({ publishPhoto: vi.fn(), publishReel: vi.fn() }));
vi.mock("@/lib/database", () => ({
  getFacebookDraft: vi.fn(),
  setDraftChannelState: vi.fn(),
  updateFacebookDraft: vi.fn(),
}));
vi.mock("@/lib/config", () => ({ CHANNEL_META: {} }));

import { publishReel } from "@/lib/social-publisher";
import { publishFacebookReel, facebookBrandCreds } from "@/lib/facebook-client";

describe("social-publisher.publishReel (Facebook Page reel)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes fr → Ameublo token and passes the explicit pageId", async () => {
    const r = await publishReel({ videoUrl: "https://cdn/r.mp4", caption: "Bonjour", pageId: "PAGE_X", locale: "fr" });
    expect(r).toEqual({ postId: "reel1" });
    expect(facebookBrandCreds).toHaveBeenCalledWith("ameublo");
    expect(publishFacebookReel).toHaveBeenCalledWith({
      caption: "Bonjour",
      videoUrl: "https://cdn/r.mp4",
      pageId: "PAGE_X",
      token: "AMEUBLO_TOK",
      label: "Ameublo Direct",
    });
  });

  it("routes en → Furnish token", async () => {
    await publishReel({ videoUrl: "https://cdn/r.mp4", caption: "Hello", pageId: "PAGE_Y", locale: "en" });
    expect(facebookBrandCreds).toHaveBeenCalledWith("furnish");
    expect(publishFacebookReel).toHaveBeenCalledWith(
      expect.objectContaining({ token: "FURNISH_TOK", pageId: "PAGE_Y" }),
    );
  });
});
