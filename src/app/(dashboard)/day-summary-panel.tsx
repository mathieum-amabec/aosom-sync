"use client";

import { useState, useEffect } from "react";

interface CronRun {
  name: string;
  status: string; // "success" | "error"
  detail: string | null;
  ranAt: number; // epoch seconds, 0 = never
}
interface Summary {
  newProductsToday: number;
  draftsThisWeek: number;
  activePriceAlerts: number;
  crons: CronRun[];
}

export function DaySummaryPanel() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [revenue, setRevenue] = useState<number | null>(null);
  const [currency, setCurrency] = useState("CAD");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dashboard/summary")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d && !d.error) setSummary(d as Summary); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    // Estimated revenue = ROAS × spend, merged from the (already 1h-cached) ads endpoint.
    fetch("/api/ads/insights?days=30")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || !d || !d.metrics) return;
        setRevenue(Math.round((d.metrics.roas * d.metrics.spend + Number.EPSILON) * 100) / 100);
        setCurrency(d.currency || "CAD");
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return (
    <section className="mb-8">
      <h3 className="text-lg font-semibold text-white mb-3">Résumé du jour</h3>

      {loading ? (
        <div className="p-6 bg-gray-900 border border-gray-800 rounded-xl flex items-center gap-3">
          <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-gray-400">Chargement…</span>
        </div>
      ) : !summary ? (
        <div className="p-4 bg-red-950/30 border border-red-800/50 rounded-xl text-sm text-red-300">
          Impossible de charger le résumé.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Metric label="Nouveaux produits (aujourd'hui)" value={summary.newProductsToday.toLocaleString("en-CA")} />
            <Metric label="Drafts sociaux (7 derniers jours)" value={summary.draftsThisWeek.toLocaleString("en-CA")} />
            <Metric label="Alertes prix actives" value={summary.activePriceAlerts.toLocaleString("en-CA")} hint="confirmées (double opt-in)" />
            <Metric
              label="Revenu estimé (30 j)"
              value={revenue == null ? "—" : `$${revenue.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`}
              hint={revenue == null ? "Meta Ads non connecté" : "ROAS × dépenses"}
            />
          </div>

          {/* Cron status */}
          <div className="mt-3 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="px-4 py-2 text-xs font-medium text-gray-400 border-b border-gray-800/60">Statut des crons (dernier run)</div>
            {summary.crons.length === 0 ? (
              <p className="px-4 py-3 text-sm text-gray-500">Aucun run enregistré pour l'instant — les crons s'enregistrent à leur prochaine exécution.</p>
            ) : (
              <ul className="divide-y divide-gray-800/50">
                {summary.crons.map((c) => (
                  <li key={c.name} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                    <span className="flex items-center gap-2 min-w-0">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${c.status === "success" ? "bg-green-400" : "bg-red-400"}`} />
                      <span className="text-gray-300 truncate">{c.name}</span>
                    </span>
                    <span className="text-gray-500 shrink-0" title={c.detail ?? ""}>
                      {c.status === "error" ? <span className="text-red-400">échec · </span> : null}
                      {timeAgoEpoch(c.ranAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-xl font-semibold text-white mt-1 tabular-nums">{value}</p>
      {hint && <p className="text-[11px] text-gray-600 mt-0.5">{hint}</p>}
    </div>
  );
}

function timeAgoEpoch(epochSecs: number): string {
  if (!epochSecs) return "jamais";
  const secs = Math.floor(Date.now() / 1000) - epochSecs;
  if (secs < 60) return "à l'instant";
  const m = Math.floor(secs / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  return `il y a ${d} j`;
}
