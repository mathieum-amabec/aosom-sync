import { describe, it, expect, vi, beforeEach } from "vitest";

const store = vi.hoisted(() => ({ settings: {} as Record<string, string>, rows: {} as Record<string, Array<Record<string, unknown>>> }));

vi.mock("@/lib/database", () => ({
  getSetting: vi.fn(async (k: string) => store.settings[k] ?? null),
  setSetting: vi.fn(async (k: string, v: string) => { store.settings[k] = v; }),
  getDailyLlmTokensUsed: vi.fn(async () => 123_456),
  ensureSchema: vi.fn(async () => ({
    // Route each query to canned rows by a distinctive fragment of its SQL.
    execute: async (sql: string | { sql: string }) => {
      const s = typeof sql === "string" ? sql : sql.sql;
      const pick = (frag: string) => ({ rows: store.rows[frag] ?? [] });
      for (const frag of Object.keys(store.rows)) if (s.includes(frag)) return pick(frag);
      return { rows: [] };
    },
  })),
}));
vi.mock("@/lib/llm-budget", () => ({ poolBudget: vi.fn(() => 3_000_000) }));

import { nextImportMode, setAutomation, isPublisherPaused, getAutomationStatus, PUBLISHER_PAUSED_KEY, IMPORT_MODE_KEY, IMPORT_RESUME_KEY, SEMAINE_KEY, LAST_CHANGE_KEY } from "@/lib/automation-controls";

beforeEach(() => {
  store.settings = {};
  store.rows = {};
});

describe("nextImportMode", () => {
  it("stopping remembers the running mode, so resuming restores it", () => {
    expect(nextImportMode("live", false, null)).toEqual({ mode: "off", resume: "live" });
    expect(nextImportMode("off", true, "live")).toEqual({ mode: "live", resume: "live" });
  });
  it("stopping an already-off import keeps the remembered mode", () => {
    expect(nextImportMode("off", false, "pilot")).toEqual({ mode: "off", resume: "pilot" });
  });
  it("resuming with nothing remembered is the safe simulation mode", () => {
    expect(nextImportMode("off", true, null)).toEqual({ mode: "dry", resume: null });
    expect(nextImportMode("off", true, "garbage")).toEqual({ mode: "dry", resume: null });
  });
  it("an explicit mode wins and becomes the remembered one", () => {
    expect(nextImportMode("live", true, null, "pilot")).toEqual({ mode: "pilot", resume: "pilot" });
  });
});

describe("setAutomation", () => {
  it("pauses and resumes the publisher through its setting", async () => {
    await setAutomation("publisher", false, "mat");
    expect(store.settings[PUBLISHER_PAUSED_KEY]).toBe("1");
    expect(await isPublisherPaused()).toBe(true);
    await setAutomation("publisher", true, "mat");
    expect(await isPublisherPaused()).toBe(false);
  });

  it("switches the import off and back to its previous mode", async () => {
    store.settings[IMPORT_MODE_KEY] = "live";
    await setAutomation("auto_import", false, "mat");
    expect(store.settings[IMPORT_MODE_KEY]).toBe("off");
    expect(store.settings[IMPORT_RESUME_KEY]).toBe("live");
    await setAutomation("auto_import", true, "mat");
    expect(store.settings[IMPORT_MODE_KEY]).toBe("live");
  });

  it("switches the import to an explicit mode from the selector", async () => {
    await setAutomation("auto_import", true, "mat", "pilot");
    expect(store.settings[IMPORT_MODE_KEY]).toBe("pilot");
  });

  it("flips the existing La semaine kill switch and records who changed what", async () => {
    await setAutomation("semaine", false, "mat");
    expect(store.settings[SEMAINE_KEY]).toBe("0");
    await setAutomation("semaine", true, "mat");
    expect(store.settings[SEMAINE_KEY]).toBe("1");
    expect(JSON.parse(store.settings[LAST_CHANGE_KEY])).toMatchObject({ key: "semaine", enabled: true, by: "mat" });
  });
});

describe("getAutomationStatus", () => {
  it("assembles the state of the three automations from settings, cron runs, queue and jobs", async () => {
    store.settings = {
      [IMPORT_MODE_KEY]: "live",
      auto_import_daily_cap: "100",
      auto_import_state: JSON.stringify({ day: "2026-10-08", total: 12, toys: 7, needsReview: 2, failed: 1 }),
      [PUBLISHER_PAUSED_KEY]: "1",
      [SEMAINE_KEY]: "1",
    };
    store.rows["FROM cron_runs"] = [
      { name: "auto-import", status: "success", detail: "live: 3 traités", ran_at: 1_791_000_000 },
      { name: "publisher", status: "success", detail: "EN PAUSE", ran_at: 1_791_000_100 },
    ];
    store.rows["count(*) n, sum(scheduled_at <= datetime('now')) overdue"] = [{ n: 9, overdue: 4 }];
    store.rows["status = 'failed' AND scheduled_at"] = [{ n: 2 }];
    store.rows["min(scheduled_at) t"] = [{ t: "2026-10-08 14:00:00" }];
    store.rows["max(published_at) t"] = [{ t: "2026-10-08 10:00:12" }];
    store.rows["content_id LIKE 'semaine:%'"] = [{ n: 3 }];
    store.rows["GROUP BY status"] = [{ status: "done", n: 31 }, { status: "needs_review", n: 4 }];
    store.rows["status IN ('needs_review','error')"] = [{ group_key: "g1", status: "needs_review", error: "auto_judge_failed:judge:title_not_sensible", updated_at: "2026-10-08 12:00:00" }];

    const s = await getAutomationStatus();
    expect(s.autoImport).toMatchObject({ mode: "live", on: true, dailyCap: 100, llm: { used: 123_456, budget: 3_000_000 } });
    expect(s.autoImport.today).toMatchObject({ imported: 12, toys: 7, needsReview: 2, failed: 1 });
    expect(s.autoImport.last24h).toEqual({ done: 31, needsReview: 4, error: 0 });
    expect(s.autoImport.recentProblems[0]).toMatchObject({ groupKey: "g1", status: "needs_review" });
    expect(s.autoImport.lastRun?.detail).toBe("live: 3 traités");
    expect(s.publisher).toMatchObject({ paused: true, pending: 9, overdue: 4, failed3d: 2, next: "2026-10-08 14:00:00" });
    expect(s.semaine).toMatchObject({ on: true, pending: 3 });
  });

  it("defaults to off / running / semaine off when nothing is configured", async () => {
    const s = await getAutomationStatus();
    expect(s.autoImport).toMatchObject({ mode: "off", on: false, dailyCap: 100, today: null });
    expect(s.publisher.paused).toBe(false);
    expect(s.semaine.on).toBe(false);
  });
});
