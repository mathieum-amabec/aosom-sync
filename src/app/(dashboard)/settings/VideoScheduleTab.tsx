"use client";

import { useState, useEffect, useCallback } from "react";
import type { WeekdayKey } from "@/lib/config";

// ⚠ STATIC UI ONLY — not wired to any endpoint yet.
// T1 owns the shared `VideoSchedule` type + the `/api/settings/video-schedule`
// endpoint. Until that lands, this tab holds its state locally (in-memory) and
// the Save button is a disabled placeholder. Once T1 ships the type, replace the
// local `VideoSchedule` shape below with `import type { VideoSchedule } from "@/lib/config"`
// and wire load()/save() to the endpoint (mirror PublicationScheduleTab).

// Monday-first display order (mirrors PublicationScheduleTab).
const DAYS: { key: WeekdayKey; label: string }[] = [
  { key: "mon", label: "Lun" },
  { key: "tue", label: "Mar" },
  { key: "wed", label: "Mer" },
  { key: "thu", label: "Jeu" },
  { key: "fri", label: "Ven" },
  { key: "sat", label: "Sam" },
  { key: "sun", label: "Dim" },
];

const BASE_TIMES = ["09:00", "10:00", "12:00", "15:00", "18:00", "20:00"];

const TIMEZONES = [
  "America/Toronto",
  "America/Vancouver",
  "America/Halifax",
  "America/New_York",
  "America/Chicago",
  "UTC",
];

type VideoRatio = "9:16" | "1:1" | "16:9";
type VideoPlatform = "facebook" | "instagram" | "both";

const RATIOS: { key: VideoRatio; label: string; hint: string }[] = [
  { key: "9:16", label: "9:16", hint: "Vertical — Reels / Shorts" },
  { key: "1:1", label: "1:1", hint: "Carré — fil" },
  { key: "16:9", label: "16:9", hint: "Horizontal — YouTube" },
];

const PLATFORMS: { key: VideoPlatform; label: string }[] = [
  { key: "facebook", label: "Facebook" },
  { key: "instagram", label: "Instagram" },
  { key: "both", label: "Les deux" },
];

// TODO(T1): replace with `import type { VideoSchedule } from "@/lib/config"` once defined.
interface VideoSchedule {
  enabled: boolean;
  ratio: VideoRatio;
  platform: VideoPlatform;
  slots: { day: WeekdayKey; times: string[] }[];
  max_per_day: number;
  timezone: string;
}

// Local placeholder state until the endpoint exists. Not persisted.
const DEFAULT_VIDEO_SCHEDULE: VideoSchedule = {
  enabled: false,
  ratio: "9:16",
  platform: "both",
  slots: [
    { day: "tue", times: ["12:00"] },
    { day: "thu", times: ["18:00"] },
  ],
  max_per_day: 1,
  timezone: "America/Toronto",
};

function timesOf(schedule: VideoSchedule, day: WeekdayKey): Set<string> {
  const slot = schedule.slots.find((s) => s.day === day);
  return new Set(slot?.times ?? []);
}

function columnsFor(schedule: VideoSchedule): string[] {
  const set = new Set(BASE_TIMES);
  for (const slot of schedule.slots) for (const t of slot.times) set.add(t);
  return Array.from(set).sort();
}

export default function VideoScheduleTab() {
  const [vid, setVid] = useState<VideoSchedule>(DEFAULT_VIDEO_SCHEDULE);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Flips to true once the endpoint answers with a valid schedule. While false,
  // the ⚠ banner stays up. Auto-clears as soon as T1's endpoint is live.
  const [endpointReady, setEndpointReady] = useState(false);

  // STUB — mirrors PublicationScheduleTab.load(), but tolerant of a missing endpoint.
  // GET /api/settings/video-schedule → { success, data: { video_schedule } }.
  // Until T1 ships it (404 / network error / bad shape), we keep DEFAULT_VIDEO_SCHEDULE
  // and leave endpointReady=false so the banner shows.
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/video-schedule");
      if (!res.ok) return; // endpoint not live yet
      const d = await res.json();
      if (d?.success && d.data?.video_schedule) {
        setVid(d.data.video_schedule as VideoSchedule);
        setEndpointReady(true);
      }
    } catch {
      /* endpoint not ready — keep defaults + banner */
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // STUB — mirrors PublicationScheduleTab.save().
  // PATCH /api/settings/video-schedule body { video_schedule } → { success, data }.
  async function save() {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings/video-schedule", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video_schedule: vid }),
      });
      const d = await res.json().catch(() => null);
      if (res.ok && d?.success) {
        if (d.data?.video_schedule) setVid(d.data.video_schedule as VideoSchedule);
        setEndpointReady(true);
        setMsg({ ok: true, text: "Horaire vidéo enregistré." });
      } else {
        setMsg({ ok: false, text: d?.error || "Endpoint indisponible — en attente de T1." });
      }
    } catch {
      setMsg({ ok: false, text: "Endpoint /api/settings/video-schedule introuvable — en attente de T1." });
    } finally {
      setSaving(false);
    }
  }

  function toggleSlot(day: WeekdayKey, time: string) {
    setVid((prev) => {
      const slots = prev.slots.map((s) => ({ day: s.day, times: [...s.times] }));
      let slot = slots.find((s) => s.day === day);
      if (!slot) {
        slot = { day, times: [] };
        slots.push(slot);
      }
      if (slot.times.includes(time)) {
        slot.times = slot.times.filter((t) => t !== time);
      } else {
        slot.times = [...slot.times, time].sort();
      }
      const cleaned = slots.filter((s) => s.times.length > 0);
      cleaned.sort((a, b) => DAYS.findIndex((d) => d.key === a.day) - DAYS.findIndex((d) => d.key === b.day));
      return { ...prev, slots: cleaned };
    });
  }

  const columns = columnsFor(vid);

  return (
    <div className="space-y-6">
      {/* ── Publication vidéo ── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 md:p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-semibold">Publication vidéo</h3>
          <Toggle on={vid.enabled} onClick={() => setVid({ ...vid, enabled: !vid.enabled })} />
        </div>

        <div className={vid.enabled ? "" : "opacity-50 pointer-events-none"}>
          {/* Ratio + plateforme */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
            <div>
              <label className="block text-sm text-gray-400 mb-2">Format (ratio)</label>
              <div className="flex flex-wrap gap-2">
                {RATIOS.map((r) => {
                  const active = vid.ratio === r.key;
                  return (
                    <button
                      key={r.key}
                      type="button"
                      aria-pressed={active}
                      title={r.hint}
                      onClick={() => setVid({ ...vid, ratio: r.key })}
                      className={`px-3 py-1.5 rounded-lg text-sm border transition-colors font-mono ${
                        active
                          ? "bg-blue-600 border-blue-500 text-white"
                          : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600"
                      }`}
                    >
                      {r.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-gray-600 mt-1">
                {RATIOS.find((r) => r.key === vid.ratio)?.hint}
              </p>
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-2">Plateforme</label>
              <div className="flex flex-wrap gap-2">
                {PLATFORMS.map((p) => {
                  const active = vid.platform === p.key;
                  return (
                    <button
                      key={p.key}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setVid({ ...vid, platform: p.key })}
                      className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                        active
                          ? "bg-blue-600 border-blue-500 text-white"
                          : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600"
                      }`}
                    >
                      {p.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Créneaux jours × heures */}
          <label className="block text-sm text-gray-400 mb-2">Créneaux (jours × heures)</label>
          <div className="overflow-x-auto">
            <table className="text-sm border-separate border-spacing-1">
              <thead>
                <tr>
                  <th className="text-left text-gray-500 font-normal px-2"></th>
                  {columns.map((t) => (
                    <th key={t} className="text-gray-400 font-mono font-normal px-2 whitespace-nowrap">
                      {t}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DAYS.map((d) => {
                  const active = timesOf(vid, d.key);
                  return (
                    <tr key={d.key}>
                      <td className="text-gray-300 px-2 whitespace-nowrap">{d.label}</td>
                      {columns.map((t) => {
                        const checked = active.has(t);
                        return (
                          <td key={t} className="text-center">
                            <button
                              type="button"
                              aria-label={`${d.key} ${t}`}
                              aria-pressed={checked}
                              onClick={() => toggleSlot(d.key, t)}
                              className={`w-7 h-7 rounded-md border transition-colors ${
                                checked
                                  ? "bg-blue-600 border-blue-500"
                                  : "bg-gray-800 border-gray-700 hover:border-gray-600"
                              }`}
                            >
                              {checked ? "✓" : ""}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-5">
            <div>
              <label className="block text-sm text-gray-400 mb-1">
                Max vidéos par jour : <span className="text-gray-200 font-medium">{vid.max_per_day}</span>
              </label>
              <input
                type="range"
                min={1}
                max={5}
                value={vid.max_per_day}
                onChange={(e) => setVid({ ...vid, max_per_day: Number(e.target.value) })}
                className="w-full accent-blue-600"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Fuseau horaire</label>
              <select
                value={vid.timezone}
                onChange={(e) => setVid({ ...vid, timezone: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
              >
                {(TIMEZONES.includes(vid.timezone) ? TIMEZONES : [vid.timezone, ...TIMEZONES]).map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* ── Save ── */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-500 disabled:opacity-50"
        >
          {saving ? "Enregistrement…" : "Enregistrer l’horaire"}
        </button>
        {msg && (
          <span className={`text-sm ${msg.ok ? "text-green-400" : "text-red-400"}`}>{msg.text}</span>
        )}
      </div>

      {/* Stays up until T1's endpoint answers (endpointReady flips on a successful load/save). */}
      {!endpointReady && (
        <p className="text-xs text-amber-400">
          ⚠ Endpoint <code className="font-mono">/api/settings/video-schedule</code> pas encore disponible —
          l’enregistrement échouera tant que T1 n’a pas livré le type <code className="font-mono">VideoSchedule</code> + la route.
        </p>
      )}
    </div>
  );
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`relative w-11 h-6 rounded-full transition-colors ${on ? "bg-blue-600" : "bg-gray-700"}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
          on ? "translate-x-5" : ""
        }`}
      />
    </button>
  );
}
