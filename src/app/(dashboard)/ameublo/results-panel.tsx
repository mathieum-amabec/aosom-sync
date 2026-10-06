"use client";

import { useState, useEffect } from "react";
import { styleLabelOf } from "@/lib/ameublo-style-label";

interface GroupStat {
  key: string;
  n: number;
  totalPlays: number;
  avgPlays: number;
  medianPlays: number;
  avgWatchS: number | null;
  lowSample: boolean;
}
interface ResultRow {
  queueId: number;
  style: string;
  lang: "fr" | "en";
  label: string | null;
  studioVideoId: number | null;
  scheduledAt: string;
  plays: number | null;
  avgWatchMs: number | null;
}
interface Summary {
  measured: number;
  matureCount: number;
  totalPlays: number;
  byStyle: GroupStat[];
  byLang: GroupStat[];
  bySlot: GroupStat[];
  top: ResultRow[];
  bottom: ResultRow[];
  lastMeasuredOn: string | null;
}

const fmt = (n: number) => new Intl.NumberFormat("fr-CA", { maximumFractionDigits: 1 }).format(n);
const LANG: Record<string, string> = { fr: "Ameublo (FR)", en: "Furnish (EN)" };
const SLOT: Record<string, string> = { "06:00": "6 h — saisonnier", "07:45": "7 h 45 — éducatif", "12:15": "12 h 15 — produits", "19:45": "19 h 45 — soir" };

function Table({ title, rows, name }: { title: string; rows: GroupStat[]; name: (k: string) => string }) {
  if (!rows.length) return null;
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-3">
      <div className="mb-2 text-sm font-medium text-gray-200">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase text-gray-500">
              <th className="py-1 pr-2">Groupe</th>
              <th className="py-1 pr-2 text-right">Reels</th>
              <th className="py-1 pr-2 text-right">Lectures (moy.)</th>
              <th className="py-1 pr-2 text-right">Médiane</th>
              <th className="py-1 text-right">Temps regardé</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((g) => (
              <tr key={g.key} className={`border-t border-gray-800 ${g.lowSample ? "text-gray-500" : "text-gray-200"}`}>
                <td className="py-1 pr-2">
                  {name(g.key)}
                  {g.lowSample && <span className="ml-2 rounded border border-gray-700 px-1 text-[10px] text-gray-400">peu de données</span>}
                </td>
                <td className="py-1 pr-2 text-right">{g.n}</td>
                <td className="py-1 pr-2 text-right">{fmt(g.avgPlays)}</td>
                <td className="py-1 pr-2 text-right">{fmt(g.medianPlays)}</td>
                <td className="py-1 text-right">{g.avgWatchS != null ? `${fmt(g.avgWatchS)} s` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReelList({ title, rows }: { title: string; rows: ResultRow[] }) {
  if (!rows.length) return null;
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 p-3">
      <div className="mb-2 text-sm font-medium text-gray-200">{title}</div>
      <ul className="space-y-1 text-sm text-gray-300">
        {rows.map((r) => (
          <li key={r.queueId} className="flex gap-2">
            <span className="w-14 shrink-0 text-right text-gray-100">{fmt(r.plays ?? 0)}</span>
            <span className="text-gray-400">
              {styleLabelOf(r.style, "fr")} · {r.lang.toUpperCase()}
              {r.label ? ` — ${r.label}` : ""}
              {r.studioVideoId ? ` (#${r.studioVideoId})` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "Résultats": which kinds of Reels, languages and time slots perform — with the sample size next to every number. */
export default function ResultsPanel() {
  const [days, setDays] = useState(14);
  const [data, setData] = useState<{ summary: Summary } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/ameublo/insights?days=${days}`);
        const j = await res.json();
        if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`);
        if (!cancelled) {
          setData(j.data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days]);

  const s = data?.summary;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-sm text-gray-300">
          {s ? (
            <>
              <strong>{s.measured}</strong> Reels mesurés · <strong>{fmt(s.totalPlays)}</strong> lectures au total
              {s.lastMeasuredOn ? ` · dernière mesure : ${s.lastMeasuredOn}` : ""}
            </>
          ) : (
            "Chargement…"
          )}
        </div>
        <label className="ml-auto flex items-center gap-2 text-sm text-gray-400">
          Période
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded border border-gray-700 bg-gray-950 px-2 py-1 text-gray-200">
            {[7, 14, 30, 60].map((d) => (
              <option key={d} value={d}>
                {d} jours
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="text-xs text-gray-500">
        Facebook seulement. Mesure quotidienne (au plus 24 h de retard). Les tableaux ne comparent que les Reels de plus de 48 h
        {s ? ` (${s.matureCount} sur ${s.measured})` : ""} : un Reel de quelques heures n’a pas encore eu le temps de cumuler des lectures.
        Chaque groupe montre son nombre de Reels : sous 5, c’est une indication, pas une conclusion.
      </p>

      {error && <div className="rounded border border-red-800 bg-red-950 p-3 text-sm text-red-300">{error}</div>}
      {!loading && s && s.measured === 0 && (
        <div className="rounded border border-gray-800 bg-gray-900 p-4 text-sm text-gray-400">
          Aucun Reel mesuré pour l’instant. Les Reels publiés à partir de maintenant sont suivis automatiquement ; les plus anciens
          peuvent être rattachés avec le script de rattrapage.
        </div>
      )}

      {s && s.measured > 0 && (
        <div className="space-y-4">
          <Table title="Par type de vidéo" rows={s.byStyle} name={(k) => styleLabelOf(k, "fr")} />
          <div className="grid gap-4 md:grid-cols-2">
            <Table title="Par page" rows={s.byLang} name={(k) => LANG[k] ?? k} />
            <Table title="Par plage horaire (heure de Toronto)" rows={s.bySlot} name={(k) => SLOT[k] ?? k} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <ReelList title="Les 5 plus regardés" rows={s.top} />
            <ReelList title="Les 5 moins regardés" rows={s.bottom} />
          </div>
        </div>
      )}
    </div>
  );
}
