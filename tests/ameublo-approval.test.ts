import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  getAmeubloTestVideo: vi.fn(),
  getOccupiedAmeubloSlots: vi.fn(),
  getSetting: vi.fn(),
  addToQueue: vi.fn(),
  cancelPendingQueueItems: vi.fn(),
  setAmeubloQueueId: vi.fn(),
  getProduct: vi.fn(),
  findAmeubloTwin: vi.fn(),
}));
const { SlotTaken } = vi.hoisted(() => ({ SlotTaken: class SlotTaken extends Error {} }));
vi.mock("@/lib/database", () => ({ ...db, QueueSlotTakenError: SlotTaken }));

import { approveAmeubloVideo, bulkApproveAmeubloVideos, cancelAmeubloVideo, approvalBlocker } from "@/lib/ameublo-approval";

const NOW = Date.parse("2026-10-05T12:00:00Z"); // Monday 08:00 Toronto
const video = (o: Record<string, unknown> = {}) => ({
  id: 1, lang: "fr", style: "vitrine", caption: "Belle trouvaille", video_url: "https://blob/x.mp4",
  verdict: null, qa_verdict: "pass", queue_id: null, queue_status: null, series: "Série A", campaign: "maison-2026",
  skus: ["A1"], prices: { A1: 99.99 }, ...o,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  Object.values(db).forEach((f) => f.mockReset());
  db.getSetting.mockResolvedValue(null);
  db.getOccupiedAmeubloSlots.mockResolvedValue([]);
  db.addToQueue.mockResolvedValue(55);
  db.getProduct.mockResolvedValue({ price: 99.99 });
});

describe("approveAmeubloVideo", () => {
  it("queues a pending sequential_ad on the FR share of the grid and links the video", async () => {
    db.getAmeubloTestVideo.mockResolvedValue(video());
    const r = await approveAmeubloVideo(1);
    expect(r).toMatchObject({ success: true, queueId: 55 });
    const arg = db.addToQueue.mock.calls[0][0];
    expect(arg).toMatchObject({ contentType: "sequential_ad", contentId: "ameublo:1", platform: "both", status: "pending" });
    expect(JSON.parse(arg.payload)).toMatchObject({ brand: "ameublo", reelsVideoUrl: "https://blob/x.mp4" });
    expect(arg.metadata).toMatchObject({ source: "ameublo_studio", keepCaption: true, lang: "fr", renderedPrices: { A1: 99.99 } });
    // FR keeps the 1st/3rd/5th/7th time of the day: 07:45, 12:15, 16:15 or 20:15 Toronto (EDT = UTC-4) -> 11:45 / 16:15 / 20:15 / 00:15 UTC
    expect(["11:45:00", "16:15:00", "20:15:00", "00:15:00"]).toContain(arg.scheduledAt.slice(11));
    expect(db.setAmeubloQueueId).toHaveBeenCalledWith(1, 55);
  });

  it("books English videos on the other hours with the furnish brand", async () => {
    db.getAmeubloTestVideo.mockResolvedValue(video({ lang: "en" }));
    await approveAmeubloVideo(1);
    const arg = db.addToQueue.mock.calls[0][0];
    expect(JSON.parse(arg.payload).brand).toBe("furnish");
    expect(["13:45:00", "18:30:00", "22:30:00", "01:45:00"]).toContain(arg.scheduledAt.slice(11));
  });

  it("retries the next slot when one is taken", async () => {
    db.getAmeubloTestVideo.mockResolvedValue(video());
    db.addToQueue.mockRejectedValueOnce(new SlotTaken()).mockResolvedValueOnce(56);
    const r = await approveAmeubloVideo(1);
    expect(r).toMatchObject({ success: true, queueId: 56 });
    expect(db.addToQueue).toHaveBeenCalledTimes(2);
    expect(db.addToQueue.mock.calls[1][0].scheduledAt).not.toBe(db.addToQueue.mock.calls[0][0].scheduledAt);
  });

  it("refuses a stale price without queuing anything", async () => {
    db.getAmeubloTestVideo.mockResolvedValue(video());
    db.getProduct.mockResolvedValue({ price: 89.99 });
    const r = await approveAmeubloVideo(1);
    expect(r).toMatchObject({ success: false, status: 409 });
    expect(db.addToQueue).not.toHaveBeenCalled();
  });

  it("refuses bad / QA-failed / old-series / already scheduled videos", async () => {
    const cases: [Record<string, unknown>, boolean][] = [
      [{ verdict: "bad" }, false],
      [{ qa_verdict: "fail" }, false],
      [{ lang: null, style: null }, false],
      [{ queue_id: 9, queue_status: "pending" }, false],
      [{ queue_id: 9, queue_status: "cancelled" }, true],
    ];
    for (const [o, ok] of cases) {
      db.getAmeubloTestVideo.mockResolvedValue(video(o));
      db.addToQueue.mockClear();
      const r = await approveAmeubloVideo(1);
      expect(r.success).toBe(ok);
    }
  });

  it("lets the operator force past a QA fail, but not past a 'bad' verdict", async () => {
    expect(approvalBlocker(video({ qa_verdict: "fail" }) as never, true)).toBeNull();
    expect(approvalBlocker(video({ verdict: "bad" }) as never, true)).not.toBeNull();
  });
});

describe("langue jumelle", () => {
  it("approuver une version planifie aussi l’autre, chacune sur la grille de sa langue", async () => {
    const vs: Record<number, ReturnType<typeof video>> = { 1: video({ id: 1 }), 2: video({ id: 2, lang: "en" }) };
    db.getAmeubloTestVideo.mockImplementation(async (id: number) => vs[id]);
    db.findAmeubloTwin.mockResolvedValue(vs[2]);
    db.addToQueue.mockResolvedValueOnce(55).mockResolvedValueOnce(56);
    const r = await approveAmeubloVideo(1);
    expect(r).toMatchObject({ success: true, queueId: 55, twin: { success: true, id: 2, queueId: 56 } });
    expect(db.addToQueue).toHaveBeenCalledTimes(2);
    expect(JSON.parse(db.addToQueue.mock.calls[0][0].payload).brand).toBe("ameublo");
    expect(JSON.parse(db.addToQueue.mock.calls[1][0].payload).brand).toBe("furnish");
    expect(db.setAmeubloQueueId).toHaveBeenCalledWith(2, 56);
  });

  it("un jumeau refusé ne bloque pas la vidéo demandée et la raison est rapportée", async () => {
    const vs: Record<number, ReturnType<typeof video>> = { 1: video({ id: 1 }), 2: video({ id: 2, lang: "en", qa_verdict: "fail" }) };
    db.getAmeubloTestVideo.mockImplementation(async (id: number) => vs[id]);
    db.findAmeubloTwin.mockResolvedValue(vs[2]);
    const r = await approveAmeubloVideo(1);
    expect(r).toMatchObject({ success: true, id: 1, twin: { success: false, id: 2, status: 409 } });
    expect(db.addToQueue).toHaveBeenCalledTimes(1);
  });

  it("en lot, un jumeau déjà planifié par son partenaire n’est pas refusé une 2e fois", async () => {
    const vs: Record<number, ReturnType<typeof video>> = { 1: video({ id: 1 }), 2: video({ id: 2, lang: "en" }) };
    db.getAmeubloTestVideo.mockImplementation(async (id: number) => vs[id]);
    db.findAmeubloTwin.mockImplementation(async (v: { id: number }) => (v.id === 1 ? vs[2] : null));
    const out = await bulkApproveAmeubloVideos([1, 2]);
    expect(out.map((o) => o.success)).toEqual([true, true]);
    expect(db.addToQueue).toHaveBeenCalledTimes(2);
  });
});

describe("Réaction grid", () => {
  it("books a Réaction video on its own grid (11:00 FR / 19:00 EN Toronto) and reads only Réaction occupancy", async () => {
    db.getAmeubloTestVideo.mockResolvedValue(video({ style: "reaction" }));
    await approveAmeubloVideo(1);
    expect(db.getOccupiedAmeubloSlots).toHaveBeenCalledWith("fr", "reaction");
    expect(db.addToQueue.mock.calls[0][0].scheduledAt).toBe("2026-10-05 15:00:00");

    db.addToQueue.mockClear();
    db.getAmeubloTestVideo.mockResolvedValue(video({ style: "reaction", lang: "en" }));
    await approveAmeubloVideo(1);
    expect(db.addToQueue.mock.calls[0][0].scheduledAt).toBe("2026-10-05 23:00:00");
  });

  it("takes the next day when today's Réaction slot is taken (1 a day per page)", async () => {
    db.getOccupiedAmeubloSlots.mockResolvedValue(["2026-10-05 15:00:00"]);
    db.getAmeubloTestVideo.mockResolvedValue(video({ style: "reaction" }));
    await approveAmeubloVideo(1);
    expect(db.addToQueue.mock.calls[0][0].scheduledAt).toBe("2026-10-06 15:00:00");
  });

  it("leaves the other styles on the main grid and its own occupancy", async () => {
    db.getAmeubloTestVideo.mockResolvedValue(video({ style: "vitrine" }));
    await approveAmeubloVideo(1);
    expect(db.getOccupiedAmeubloSlots).toHaveBeenCalledWith("fr", "main");
    expect(["11:45:00", "16:15:00", "20:15:00", "00:15:00"]).toContain(db.addToQueue.mock.calls[0][0].scheduledAt.slice(11));
  });
});

describe("bulkApproveAmeubloVideos / cancel", () => {
  it("interleaves FR and EN", async () => {
    const vs: Record<number, ReturnType<typeof video>> = {
      1: video({ id: 1 }), 2: video({ id: 2 }), 3: video({ id: 3, lang: "en" }), 4: video({ id: 4, lang: "en" }),
    };
    db.getAmeubloTestVideo.mockImplementation(async (id: number) => vs[id]);
    const out = await bulkApproveAmeubloVideos([1, 2, 3, 4]);
    expect(out.map((o) => o.id)).toEqual([1, 3, 2, 4]);
  });

  it("cancels pending queue rows and unlinks, but never a published one", async () => {
    db.getAmeubloTestVideo.mockResolvedValue(video({ queue_id: 5, queue_status: "pending" }));
    expect((await cancelAmeubloVideo(1)).success).toBe(true);
    expect(db.cancelPendingQueueItems).toHaveBeenCalledWith("sequential_ad", "ameublo:1");
    expect(db.setAmeubloQueueId).toHaveBeenCalledWith(1, null);
    db.getAmeubloTestVideo.mockResolvedValue(video({ queue_id: 5, queue_status: "published" }));
    expect((await cancelAmeubloVideo(1)).success).toBe(false);
  });
});

describe("approveAmeubloVideoAt", () => {
  it("books the video on the exact slot it is given, with the same payload and guards", async () => {
    const { approveAmeubloVideoAt } = await import("@/lib/ameublo-approval");
    db.getAmeubloTestVideo.mockResolvedValue(video({ lang: "en" }));
    const r = await approveAmeubloVideoAt(1, "2026-10-07 11:50:00");
    expect(r).toMatchObject({ success: true, queueId: 55, scheduledAt: "2026-10-07 11:50:00" });
    const arg = db.addToQueue.mock.calls[0][0];
    expect(arg).toMatchObject({ contentType: "sequential_ad", contentId: "ameublo:1", platform: "both", status: "pending", scheduledAt: "2026-10-07 11:50:00" });
    expect(JSON.parse(arg.payload).brand).toBe("furnish");
    expect(db.setAmeubloQueueId).toHaveBeenCalledWith(1, 55);
    expect(db.findAmeubloTwin).not.toHaveBeenCalled(); // no twin on this path
  });

  it("reports a taken slot instead of shifting to another one", async () => {
    const { approveAmeubloVideoAt } = await import("@/lib/ameublo-approval");
    db.getAmeubloTestVideo.mockResolvedValue(video());
    db.addToQueue.mockRejectedValueOnce(new SlotTaken());
    const r = await approveAmeubloVideoAt(1, "2026-10-07 11:45:00");
    expect(r).toMatchObject({ success: false, status: 409 });
    expect(db.addToQueue).toHaveBeenCalledTimes(1);
    expect(db.setAmeubloQueueId).not.toHaveBeenCalled();
  });

  it("refuses what the normal path refuses (rejected video, already scheduled)", async () => {
    const { approveAmeubloVideoAt } = await import("@/lib/ameublo-approval");
    db.getAmeubloTestVideo.mockResolvedValue(video({ verdict: "bad" }));
    expect(await approveAmeubloVideoAt(1, "2026-10-07 11:45:00")).toMatchObject({ success: false, status: 409 });
    db.getAmeubloTestVideo.mockResolvedValue(video({ queue_id: 9, queue_status: "pending" }));
    expect(await approveAmeubloVideoAt(1, "2026-10-07 11:45:00")).toMatchObject({ success: false, status: 409 });
    expect(db.addToQueue).not.toHaveBeenCalled();
  });
});
