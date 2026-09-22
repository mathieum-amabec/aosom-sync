"use client";

import { useState, useEffect } from "react";

interface PriceFloorIncident {
  id: number;
  sku: string;
  oldPrice: number;
  newPrice: number;
  source: string;
  detectedAt: number; // epoch seconds
}

interface IncidentsResponse {
  incidents: PriceFloorIncident[];
  total: number;
  last30Days: number;
}

const SOURCE_LABELS: Record<string, string> = {
  import: "Import",
  price_audit: "Audit quotidien",
  price_reconcile: "Réconciliation horaire",
  sync_push: "Sync quotidien",
  force_push_script: "Script manuel",
};

/**
 * TASK 3. The durable history of every below-floor price correction, so "combien de
 * fois ça arrive, depuis quand" has a real answer instead of a manual reconstruction
 * across price_history and sync_logs. Sits right under AlertsPanel: that panel shows
 * TODAY's live status, this one shows the trail behind it.
 */
export function PriceFloorIncidentsPanel() {
  const [data, setData] = useState<IncidentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/price-floor-incidents")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d && !d.error) setData(d as IncidentsResponse); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading || !data) return null; // fails soft — this is a history log, not a critical alert
  if (data.total === 0) return null; // nothing to show yet

  const shown = expanded ? data.incidents : data.incidents.slice(0, 5);

  return (
    <section className="mb-8">
      <h3 className="text-lg font-semibold text-white mb-3">Historique — prix sous le plancher</h3>
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 text-sm text-gray-400 border-b border-gray-800/60">
          {data.total} incident{data.total > 1 ? "s" : ""} au total
          <span className="text-gray-500"> · {data.last30Days} au cours des 30 derniers jours</span>
        </div>
        <ul className="divide-y divide-gray-800/50">
          {shown.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
              <span className="flex items-center gap-2 min-w-0">
                <span className="w-2 h-2 rounded-full shrink-0 bg-amber-400" />
                <span className="text-gray-300 truncate">{i.sku}</span>
                <span className="text-gray-600 shrink-0">{SOURCE_LABELS[i.source] ?? i.source}</span>
              </span>
              <span className="text-gray-500 shrink-0">
                {i.oldPrice.toFixed(2)}$<span className="text-amber-400"> → {i.newPrice.toFixed(2)}$</span>
                <span className="text-gray-600"> · {timeAgoEpoch(i.detectedAt)}</span>
              </span>
            </li>
          ))}
        </ul>
        {data.incidents.length > 5 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="w-full px-4 py-2 text-xs text-gray-500 hover:text-gray-300 border-t border-gray-800/60"
          >
            {expanded ? "Réduire" : `Voir les ${data.incidents.length - 5} autres`}
          </button>
        )}
      </div>
    </section>
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
