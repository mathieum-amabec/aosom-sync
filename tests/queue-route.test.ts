import { describe, it, expect, vi, beforeEach } from "vitest";

// Verifies GET /api/queue: auth gate, reads publication_queue via getPendingQueue(),
// extracts a truncated caption/title preview + thumbnail from the JSON payload, and
// converts the SQLite datetime TEXT (UTC) scheduled_at to unix seconds.

function mockAuth(authed: boolean) {
  vi.doMock("@/lib/auth", () => ({
    isAuthenticated: vi.fn().mockResolvedValue(authed),
  }));
}

function mockDatabase(items: unknown[]) {
  vi.doMock("@/lib/database", () => ({
    getPendingQueue: vi.fn().mockResolvedValue(items),
  }));
}

function item(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    contentType: "social",
    contentId: "draft-1",
    platform: "both",
    payload: JSON.stringify({ caption: "Bonjour le monde", brand: "ameublo", imageUrl: "https://img/x.jpg" }),
    scheduledAt: "2025-12-08 15:00:00",
    status: "pending",
    error: null,
    createdAt: "2025-12-01 10:00:00",
    publishedAt: null,
    ...over,
  };
}

async function callGet() {
  const mod = await import("@/app/api/queue/route");
  return mod.GET();
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("GET /api/queue", () => {
  it("returns 401 when not authenticated", async () => {
    mockAuth(false);
    mockDatabase([]);
    const res = await callGet();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("maps a social item: caption preview, image, platform, status, unix scheduledAt", async () => {
    mockAuth(true);
    mockDatabase([item()]);
    const res = await callGet();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    const d = body.data[0];
    expect(d.preview).toBe("Bonjour le monde");
    expect(d.imageUrl).toBe("https://img/x.jpg");
    expect(d.platform).toBe("both");
    expect(d.status).toBe("pending");
    // 2025-12-08 15:00:00 UTC === 1765206000 unix seconds
    expect(d.scheduledAt).toBe(1765206000);
  });

  it("falls back to imageUrls[0] when imageUrl is absent", async () => {
    mockAuth(true);
    mockDatabase([
      item({ payload: JSON.stringify({ caption: "x", brand: "furnish", imageUrls: ["", "https://img/y.jpg"] }) }),
    ]);
    const body = await (await callGet()).json();
    expect(body.data[0].imageUrl).toBe("https://img/y.jpg");
  });

  it("uses title + featuredImage.src for a blog item", async () => {
    mockAuth(true);
    mockDatabase([
      item({
        platform: "shopify_blog",
        contentType: "blog",
        payload: JSON.stringify({
          title: "Mon article",
          bodyHtml: "<p>...</p>",
          lang: "fr",
          featuredImage: { src: "https://img/blog.jpg" },
        }),
      }),
    ]);
    const body = await (await callGet()).json();
    expect(body.data[0].preview).toBe("Mon article");
    expect(body.data[0].imageUrl).toBe("https://img/blog.jpg");
  });

  it("truncates a long caption to 140 chars with an ellipsis", async () => {
    mockAuth(true);
    const longCaption = "a".repeat(300);
    mockDatabase([item({ payload: JSON.stringify({ caption: longCaption, brand: "ameublo" }) })]);
    const body = await (await callGet()).json();
    expect(body.data[0].preview.length).toBe(140);
    expect(body.data[0].preview.endsWith("…")).toBe(true);
  });

  it("drops a non-https imageUrl (mixed-content guard)", async () => {
    mockAuth(true);
    mockDatabase([item({ payload: JSON.stringify({ caption: "x", brand: "ameublo", imageUrl: "http://insecure/x.jpg" }) })]);
    const body = await (await callGet()).json();
    expect(body.data[0].imageUrl).toBeNull();
  });

  it("does not throw on a non-object payload (valid JSON, wrong shape)", async () => {
    mockAuth(true);
    mockDatabase([item({ payload: "42" })]);
    const body = await (await callGet()).json();
    expect(body.data[0].preview).toBe("");
    expect(body.data[0].imageUrl).toBeNull();
  });

  it("does not throw on a malformed payload — empty preview, null image", async () => {
    mockAuth(true);
    mockDatabase([item({ payload: "not json{{" })]);
    const body = await (await callGet()).json();
    expect(body.data[0].preview).toBe("");
    expect(body.data[0].imageUrl).toBeNull();
  });

  it("returns scheduledAt null for an unparseable datetime", async () => {
    mockAuth(true);
    mockDatabase([item({ scheduledAt: "garbage" })]);
    const body = await (await callGet()).json();
    expect(body.data[0].scheduledAt).toBeNull();
  });
});
