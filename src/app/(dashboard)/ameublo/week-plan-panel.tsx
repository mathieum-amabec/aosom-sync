"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { styleLabelOf } from "@/lib/ameublo-style-label";

interface PlanEntry {
  id: number;
  lang: "fr" | "en";
  slot: "S0" | "S1" | "S2" | "S3";
  at: string;
  day: string;
  seasonal: boolean;
  style: string | null;
  label: string | null;
  series: string;
  video_url: string;
}
interface SlotDef { key: "S0" | "S1" | "S2" | "S3"; fr: string; en: string; label: string }
interface PlanData { entries: PlanEntry[]; slots: SlotDef[]; seasonalActive: boolean; stock: { fr: number; en: number }; unplaced: number }

const styleLabel = (s: string | null) => styleLabelOf(s, "fr");
const dayLabel = (day: string) =>
  new Intl.DateTimeFormat("fr-CA", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));

/** "Plan de la semaine": the proposed week, remove what you don't want, approve the rest in one click. */
export default function WeekPlanPanel({ onApproved }: { onApproved: () => void }) {
  const [data, setData] = useState<PlanData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [excluded, setExcluded] = useState<number[]>([]);

  const load = useCallback(async (exclude: number[]) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ameublo/week-plan?days=7${exclude.length ? `&exclude=${exclude.join(",")}` : ""}`);
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j.data as PlanData);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load([]);
  }, [load]);

  const byDay = useMemo(() => {
    const m = new Map<string, PlanEntry[]>();
    for (const e of data?.entries ?? []) m.set(e.day, [...(m.get(e.day) ?? []), e]);
    return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  }, [data]);

  const remove = (id: number) => {
    const next = [...excluded, id];
    setExcluded(next);
    setInfo(null);
    load(next);
  };

  const approveWeek = async () => {
    if (!data?.entries.length || busy) return;
    const first = data.entries[0].day, last = data.entries[data.entries.length - 1].day;
    if (!window.confirm(`Approuver et planifier ${data.entries.length} vidéos (${dayLabel(first)} → ${dayLabel(last)}) ?`)) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch("/api/ameublo/week-plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve_plan", entries: data.entries.map((e) => ({ id: e.id, at: e.at })) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`);
      const { approved, refused, results } = j.data as { approved: number; refused: number; results: { success: boolean; id: number; error?: string }[] };
      setInfo(`${approved} vidéos planifiées${refused ? `, ${refused} refusées : ${results.filter((r) => !r.success).map((r) => `#${r.id} ${r.error}`).join(" · ")}` : ""}.`);
      setExcluded([]);
      onApproved();
      await load([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cell = (e: PlanEntry | undefined) =>
    e ? (
      <div className={`rounded border p-2 text-xs ${e.seasonal ? "border-orange-800 bg-orange-950/40" : "border-gray-700 bg-gray-950"}`}>
        <div className="text-gray-200">
          {e.seasonal ? "🎃 " : ""}
          {styleLabel(e.style)}
        </div>
        <div className="text-gray-400 line-clamp-2">{e.label ?? e.series}</div>
        <div className="mt-1 flex gap-2">
          <a href={e.video_url} target="_blank" rel="noreferrer" className="text-blue-300 hover:underline">
            Voir
          </a>
          <button onClick={() => remove(e.id)} disabled={busy || loading} className="text-gray-400 hover:text-red-300 disabled:opacity-40">
            Retirer
          </button>
        </div>
      </div>
    ) : (
      <div className="rounded border border-dashed border-gray-800 p-2 text-xs text-gray-600">—</div>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-sm text-gray-300">
          {data ? (
            <>
              <strong>{data.entries.length}</strong> vidéos proposées sur 7 jours · stock prêt : FR {data.stock.fr} · EN {data.stock.en}
              {data.unplaced > 0 ? ` · ${data.unplaced} hors des 7 jours` : ""}
            </>
          ) : (
            "Chargement du plan…"
          )}
        </div>
        <button
          onClick={approveWeek}
          disabled={busy || loading || !data?.entries.length}
          className="ml-auto rounded bg-green-800 px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          {busy ? "Planification…" : `Approuver la semaine (${data?.entries.length ?? 0})`}
        </button>
      </div>

      <p className="text-xs text-gray-500">
        3 vidéos par page par jour (FR = Ameublo Direct, EN = Furnish Direct, 5 min plus tard)
        {data?.seasonalActive ? " + la plage de 6 h réservée au saisonnier" : ""}. Rien n’est approuvé avant que tu cliques sur « Approuver la semaine ».
        Retirer une vidéo la remplace par la suivante du stock.
      </p>

      {(error || info) && (
        <div className="space-y-2" role="status" aria-live="polite">
          {error && <div className="rounded border border-red-800 bg-red-950 p-3 text-sm text-red-300">{error}</div>}
          {info && <div className="rounded border border-green-800 bg-green-950 p-3 text-sm text-green-300">{info}</div>}
        </div>
      )}
      {data && data.stock.fr + data.stock.en === 0 && (
        <div className="rounded border border-amber-800 bg-amber-950/40 p-4 text-sm text-amber-200">Aucune vidéo prête à approuver : il faut en produire de nouvelles.</div>
      )}

      <div className="space-y-4">
        {byDay.map(([day, entries]) => (
          <div key={day} className="rounded-lg border border-gray-800 bg-gray-900 p-3">
            <div className="mb-2 text-sm font-medium capitalize text-gray-200">{dayLabel(day)}</div>
            <div className="overflow-x-auto">
              <div className="grid min-w-[560px] grid-cols-[110px_1fr_1fr] gap-2">
                <div />
                <div className="text-[11px] uppercase text-gray-500">FR · Ameublo</div>
                <div className="text-[11px] uppercase text-gray-500">EN · Furnish</div>
                {(data?.slots ?? []).map((s) => {
                  const fr = entries.find((e) => e.slot === s.key && e.lang === "fr");
                  const en = entries.find((e) => e.slot === s.key && e.lang === "en");
                  if (s.key === "S0" && !fr && !en) return null;
                  return (
                    <div key={s.key} className="contents">
                      <div className="text-xs text-gray-400">
                        {s.fr} / {s.en}
                        <div className="text-[11px] text-gray-600">{s.label}</div>
                      </div>
                      {cell(fr)}
                      {cell(en)}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
