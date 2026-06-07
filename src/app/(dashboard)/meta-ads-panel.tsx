"use client";

import { useState, useEffect } from "react";

// Mirrors AdsMetrics from src/lib/ads-insights.ts (kept local to avoid importing
// server code into a client bundle).
interface AdsMetrics {
  spend: number;
  reach: number;
  impressions: number;
  clicks: number;
  roas: number;
  cpm: number;
  ctr: number;
}
interface InsightsResponse {
  configured?: boolean;
  error?: string;
  setupDoc?: string;
  currency?: string;
  days?: number;
  metrics?: AdsMetrics;
}

const SETUP_DOC_URL =
  "https://github.com/mathieum-amabec/aosom-sync/blob/main/docs/META-ADS-SETUP.md";

type State =
  | { kind: "loading" }
  | { kind: "not_configured" }
  | { kind: "error"; message: string }
  | { kind: "ready"; currency: string; days: number; metrics: AdsMetrics };

export function MetaAdsPanel() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/ads/insights?days=30")
      .then(async (r) => {
        // Tolerate non-JSON error bodies (gateway/WAF HTML pages) — don't throw.
        const json = (await r.json().catch(() => ({}))) as InsightsResponse;
        return { status: r.status, ok: r.ok, json };
      })
      .then(({ status, ok, json }) => {
        if (cancelled) return;
        if (json.configured === false) {
          setState({ kind: "not_configured" });
        } else if (ok && json.metrics) {
          setState({
            kind: "ready",
            currency: json.currency || "CAD",
            days: json.days || 30,
            metrics: json.metrics,
          });
        } else {
          const fallback = status === 401 ? "Session expirée — reconnectez-vous." : "Échec du chargement des métriques";
          setState({ kind: "error", message: json.error || fallback });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error", message: "Échec du chargement des métriques" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="mb-8">
      <h3 className="text-lg font-semibold text-white mb-3">
        Publicités Meta
        {state.kind === "ready" && (
          <span className="text-gray-500 text-sm font-normal"> · 30 derniers jours</span>
        )}
      </h3>

      {state.kind === "loading" && (
        <div className="p-6 bg-gray-900 border border-gray-800 rounded-xl flex items-center gap-3">
          <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-gray-400">Chargement des métriques Meta Ads…</span>
        </div>
      )}

      {state.kind === "not_configured" && (
        <div className="p-6 bg-gray-900 border border-gray-800 rounded-xl text-center">
          <p className="text-gray-300 text-sm font-medium">Connectez votre compte Meta Ads</p>
          <p className="text-gray-500 text-xs mt-1">
            Ajoutez <code className="text-gray-400">META_ACCESS_TOKEN</code> pour afficher dépenses, portée et ROAS.
          </p>
          <a
            href={SETUP_DOC_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block mt-3 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Guide de configuration →
          </a>
        </div>
      )}

      {state.kind === "error" && (
        <div className="p-4 bg-red-950/30 border border-red-800/50 rounded-xl text-sm text-red-300">
          {state.message}
        </div>
      )}

      {state.kind === "ready" && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <Metric label="Dépenses" value={formatMoney(state.metrics.spend, state.currency)} />
          <Metric label="Portée" value={formatInt(state.metrics.reach)} />
          <Metric label="Clics" value={formatInt(state.metrics.clicks)} />
          <Metric
            label="ROAS"
            value={state.metrics.roas > 0 ? `${state.metrics.roas.toFixed(2)}×` : "—"}
            hint="Retour sur dépense pub"
          />
          <Metric label="CPM" value={formatMoney(state.metrics.cpm, state.currency)} hint="Coût / 1000 impressions" />
          <Metric label="CTR" value={`${state.metrics.ctr.toFixed(2)}%`} hint="Taux de clic" />
        </div>
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

function formatInt(n: number): string {
  return n.toLocaleString("en-CA");
}
function formatMoney(n: number, currency: string): string {
  return `$${n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}
