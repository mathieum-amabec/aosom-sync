"use client";

import { useEffect, useState, useCallback } from "react";
import type { PublicationSchedule, BlogSchedule, WeekdayKey } from "@/lib/config";

// Monday-first display order.
const DAYS: { key: WeekdayKey; label: string }[] = [
  { key: "mon", label: "Lun" },
  { key: "tue", label: "Mar" },
  { key: "wed", label: "Mer" },
  { key: "thu", label: "Jeu" },
  { key: "fri", label: "Ven" },
  { key: "sat", label: "Sam" },
  { key: "sun", label: "Dim" },
];

// Candidate columns for the day × time grid. Any custom time already in the
// schedule is merged in so it stays visible/editable.
const BASE_TIMES = ["09:00", "10:00", "12:00", "15:00", "18:00", "20:00"];

const TIMEZONES = [
  "America/Toronto",
  "America/Vancouver",
  "America/Halifax",
  "America/New_York",
  "America/Chicago",
  "UTC",
];

function timesOf(schedule: PublicationSchedule, day: WeekdayKey): Set<string> {
  const slot = schedule.slots.find((s) => s.day === day);
  return new Set(slot?.times ?? []);
}

function columnsFor(schedule: PublicationSchedule): string[] {
  const set = new Set(BASE_TIMES);
  for (const slot of schedule.slots) for (const t of slot.times) set.add(t);
  return Array.from(set).sort();
}

export default function PublicationScheduleTab() {
  const [pub, setPub] = useState<PublicationSchedule | null>(null);
  const [blog, setBlog] = useState<BlogSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings/schedule");
      const d = await res.json();
      if (d.success) {
        setPub(d.data.publication_schedule);
        setBlog(d.data.blog_schedule);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function toggleSlot(day: WeekdayKey, time: string) {
    setPub((prev) => {
      if (!prev) return prev;
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
      // drop emptied days
      const cleaned = slots.filter((s) => s.times.length > 0);
      // keep weekday display order
      cleaned.sort((a, b) => DAYS.findIndex((d) => d.key === a.day) - DAYS.findIndex((d) => d.key === b.day));
      return { ...prev, slots: cleaned };
    });
  }

  function toggleBlogDay(day: WeekdayKey) {
    setBlog((prev) => {
      if (!prev) return prev;
      const has = prev.preferred_days.includes(day);
      const next = has
        ? prev.preferred_days.filter((d) => d !== day)
        : [...prev.preferred_days, day];
      next.sort((a, b) => DAYS.findIndex((d) => d.key === a) - DAYS.findIndex((d) => d.key === b));
      return { ...prev, preferred_days: next };
    });
  }

  async function save() {
    if (!pub || !blog) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings/schedule", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publication_schedule: pub, blog_schedule: blog }),
      });
      const d = await res.json();
      if (d.success) {
        setPub(d.data.publication_schedule);
        setBlog(d.data.blog_schedule);
        setMsg({ ok: true, text: "Horaire enregistré." });
      } else {
        setMsg({ ok: false, text: d.error || "Erreur" });
      }
    } catch (err) {
      setMsg({ ok: false, text: String(err) });
    } finally {
      setSaving(false);
    }
  }

  if (loading || !pub || !blog) {
    return <div className="p-2 text-gray-500">Chargement de l’horaire…</div>;
  }

  const columns = columnsFor(pub);

  return (
    <div className="space-y-6">
      {/* ── Publication sociale ── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 md:p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-semibold">Publication sociale</h3>
          <Toggle
            on={pub.enabled}
            onClick={() => setPub({ ...pub, enabled: !pub.enabled })}
          />
        </div>

        <div className={pub.enabled ? "" : "opacity-50 pointer-events-none"}>
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
                  const active = timesOf(pub, d.key);
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
                Max posts par jour : <span className="text-gray-200 font-medium">{pub.max_per_day}</span>
              </label>
              <input
                type="range"
                min={1}
                max={5}
                value={pub.max_per_day}
                onChange={(e) => setPub({ ...pub, max_per_day: Number(e.target.value) })}
                className="w-full accent-blue-600"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Fuseau horaire</label>
              <select
                value={pub.timezone}
                onChange={(e) => setPub({ ...pub, timezone: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
              >
                {(TIMEZONES.includes(pub.timezone) ? TIMEZONES : [pub.timezone, ...TIMEZONES]).map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* ── Blog ── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 md:p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-white font-semibold">Blog</h3>
          <Toggle on={blog.enabled} onClick={() => setBlog({ ...blog, enabled: !blog.enabled })} />
        </div>

        <div className={blog.enabled ? "" : "opacity-50 pointer-events-none"}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">
                Articles par semaine : <span className="text-gray-200 font-medium">{blog.posts_per_week}</span>
              </label>
              <input
                type="range"
                min={1}
                max={3}
                value={blog.posts_per_week}
                onChange={(e) => setBlog({ ...blog, posts_per_week: Number(e.target.value) })}
                className="w-full accent-blue-600"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Heure préférée</label>
              <select
                value={blog.preferred_time}
                onChange={(e) => setBlog({ ...blog, preferred_time: e.target.value })}
                className="w-full sm:w-32 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
              >
                {(BASE_TIMES.includes(blog.preferred_time) ? BASE_TIMES : [blog.preferred_time, ...BASE_TIMES]).map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-4">
            <label className="block text-sm text-gray-400 mb-2">Jours préférés</label>
            <div className="flex flex-wrap gap-2">
              {DAYS.map((d) => {
                const checked = blog.preferred_days.includes(d.key);
                return (
                  <button
                    key={d.key}
                    type="button"
                    aria-pressed={checked}
                    onClick={() => toggleBlogDay(d.key)}
                    className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                      checked
                        ? "bg-blue-600 border-blue-500 text-white"
                        : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600"
                    }`}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ── Save ── */}
      <div className="flex items-center gap-3">
        <button
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
