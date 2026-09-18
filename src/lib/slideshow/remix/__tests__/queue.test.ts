import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildRemixQueueDraft, REMIX_THEMES } from "@/lib/slideshow/remix/queue";
import type { RemixResult } from "@/lib/slideshow/remix/types";

describe("buildRemixQueueDraft", () => {
  it("builds a draft payload from a real (non-dry-run) result", () => {
    const result: RemixResult = { blobUrl: "https://blob.example/remix/ete-cour/123.mp4", clipCount: 6 };
    const draft = buildRemixQueueDraft("ete-cour", result, "fr", 1758000000000);

    expect(draft.contentId).toBe("remix:ete-cour:1758000000000");
    expect(draft.platform).toBe("both");
    expect(draft.metadata).toEqual({ source: "remix", theme: "ete-cour" });

    const payload = JSON.parse(draft.payload);
    expect(payload.reelsVideoUrl).toBe(result.blobUrl);
    expect(payload.brand).toBe("ameublo");
    expect(typeof payload.caption).toBe("string");
    expect(payload.caption.length).toBeGreaterThan(0);
    expect(payload.caption).toContain("6");
  });

  it("uses an English caption for language='en'", () => {
    const result: RemixResult = { blobUrl: "https://blob.example/remix/maison/1.mp4", clipCount: 4 };
    const draft = buildRemixQueueDraft("maison", result, "en", 1);
    const payload = JSON.parse(draft.payload);
    expect(payload.caption.toLowerCase()).toContain("ideas");
  });

  it("throws when the result is a dry-run manifest (no blobUrl)", () => {
    const result: RemixResult = {
      clipCount: 3,
      manifest: { theme: "soldes", clips: [], estimatedDurationSec: 10, wouldUploadTo: "x", dryRun: true },
    };
    expect(() => buildRemixQueueDraft("soldes", result, "fr")).toThrow(/dry run/i);
  });

  it("produces a distinct contentId per timestamp (no collision on repeat calls)", () => {
    const result: RemixResult = { blobUrl: "https://blob.example/x.mp4", clipCount: 5 };
    const a = buildRemixQueueDraft("enfants", result, "fr", 100);
    const b = buildRemixQueueDraft("enfants", result, "fr", 200);
    expect(a.contentId).not.toBe(b.contentId);
  });
});

describe("REMIX_THEMES", () => {
  it("covers all 6 themes the render engine knows about", () => {
    expect(REMIX_THEMES).toEqual(["ete-cour", "maison", "enfants", "bureau", "animaux", "soldes"]);
  });
});

// ─── generateAndQueueRemix orchestration ──────────────────────────────────

const addToQueue = vi.fn();
const getOccupiedQueueSlots = vi.fn();
const getSetting = vi.fn();
class QueueSlotTakenError extends Error {}

vi.mock("@/lib/database", () => ({
  addToQueue: (...args: unknown[]) => addToQueue(...args),
  getOccupiedQueueSlots: (...args: unknown[]) => getOccupiedQueueSlots(...args),
  getSetting: (...args: unknown[]) => getSetting(...args),
  QueueSlotTakenError,
}));

const getNextAvailableSlot = vi.fn();
const parseVideoSchedule = vi.fn();
vi.mock("@/lib/publication-scheduler", () => ({
  getNextAvailableSlot: (...args: unknown[]) => getNextAvailableSlot(...args),
  parseVideoSchedule: (...args: unknown[]) => parseVideoSchedule(...args),
}));

const renderRemix = vi.fn();
vi.mock("@/lib/slideshow/remix/render", () => ({
  renderRemix: (...args: unknown[]) => renderRemix(...args),
  introTitle: (theme: string, n: number, language: string) =>
    language === "en" ? `${n} ideas` : `${n} idées pour ${theme}`,
}));

describe("generateAndQueueRemix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSetting.mockResolvedValue(null);
    parseVideoSchedule.mockReturnValue({ platform: "both" });
    getOccupiedQueueSlots.mockResolvedValue([]);
    getNextAvailableSlot.mockResolvedValue({ sqlite: "2026-09-25 09:00:00", at: 1758790800 });
    addToQueue.mockResolvedValue(42);
  });

  it("always inserts with status: 'draft' — never auto-schedules or publishes", async () => {
    renderRemix.mockResolvedValue({ blobUrl: "https://blob.example/r.mp4", clipCount: 7 });
    const { generateAndQueueRemix } = await import("@/lib/slideshow/remix/generate");

    const result = await generateAndQueueRemix({ theme: "ete-cour" });

    expect(addToQueue).toHaveBeenCalledTimes(1);
    const call = addToQueue.mock.calls[0][0];
    expect(call.status).toBe("draft");
    expect(call.contentType).toBe("video");
    expect(result.queueId).toBe(42);
  });

  it("throws and never calls addToQueue when render produces no blobUrl", async () => {
    renderRemix.mockResolvedValue({ clipCount: 0, manifest: { theme: "x", clips: [], estimatedDurationSec: 0, wouldUploadTo: "x", dryRun: true } });
    const { generateAndQueueRemix } = await import("@/lib/slideshow/remix/generate");

    await expect(generateAndQueueRemix({ theme: "maison" })).rejects.toThrow();
    expect(addToQueue).not.toHaveBeenCalled();
  });

  it("throws when no free video slot exists, rather than skipping the slot check", async () => {
    renderRemix.mockResolvedValue({ blobUrl: "https://blob.example/r.mp4", clipCount: 3 });
    getNextAvailableSlot.mockResolvedValue(null);
    const { generateAndQueueRemix } = await import("@/lib/slideshow/remix/generate");

    await expect(generateAndQueueRemix({ theme: "animaux" })).rejects.toThrow(/no free/i);
    expect(addToQueue).not.toHaveBeenCalled();
  });
});
