"use client";

import { useState, useEffect } from "react";

interface ErroredImportJob { id: string; groupKey: string; sku: string | null; error: string | null; updatedAt: string; }
interface FeedSync { feedType: string; lastSuccessAt: number | null; itemCount: number | null; lastStatus: string | null; }
interface MetaToken { configured: boolean; state?: string; daysLeft?: number | null; expiresAt?: number; }
interface PriceFloorItem { sku: string; shopify_price: number; aosom_price: number; gap: number; }
interface PriceFloor { belowFloorCount: number; total: number; auditedAt: number | null; topItems: PriceFloorItem[]; }
interface Alerts {
  erroredImportJobs: ErroredImportJob[];
  staleDraftCount: number;
  feeds: FeedSync[];
  metaToken: MetaToken;
  priceFloor: PriceFloor | null;
}

const FEED_LABELS: Record<string, string> = {
  google: "Google", meta: "Meta (JSON)", meta_xml: "Meta (XML)", pinterest: "Pinterest", pinterest_en: "Pinterest (EN)",
};

export function AlertsPanel() {
  const [data, setData] = useState<Alerts | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dashboard/alerts")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d && !d.error) setData(d as Alerts); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <section className="mb-8">
        <h3 className="text-lg font-semibold text-white mb-3">Alertes</h3>
        <div className="p-6 bg-gray-900 border border-gray-800 rounded-xl flex items-center gap-3">
          <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-gray-400">Chargement…</span>
        </div>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="mb-8">
        <h3 className="text-lg font-semibold text-white mb-3">Alertes</h3>
        <div className="p-4 bg-red-950/30 border border-red-800/50 rounded-xl text-sm text-red-300">Impossible de charger les alertes.</div>
      </section>
    );
  }

  const token = data.metaToken;
  const tokenAlert =
    token.configured && (token.state === "expired" || token.state === "expiring_soon" || token.state === "unknown");
  const belowFloor = data.priceFloor?.belowFloorCount ?? 0;
  const hasAlerts = data.erroredImportJobs.length > 0 || data.staleDraftCount > 0 || tokenAlert ||
    belowFloor > 0 || data.feeds.some((f) => f.lastStatus === "error");

  return (
    <section className="mb-8">
      <h3 className="text-lg font-semibold text-white mb-3">Alertes</h3>
      <div className="space-y-3">
        {!hasAlerts && (
          <Row tone="ok" title="Tout va bien" detail="Aucune alerte critique détectée." />
        )}

        {/* Import jobs in error */}
        {data.erroredImportJobs.length > 0 && (
          <div className="bg-red-950/20 border border-red-800/40 rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 text-sm font-medium text-red-300">
              {data.erroredImportJobs.length} job{data.erroredImportJobs.length > 1 ? "s" : ""} d'import en erreur
            </div>
            <ul className="divide-y divide-red-900/30">
              {data.erroredImportJobs.slice(0, 8).map((j) => (
                <li key={j.id} className="px-4 py-2 text-xs text-gray-400">
                  <span className="text-gray-300">{j.sku || j.groupKey}</span>
                  {j.error ? <span className="text-red-400/80"> — {j.error}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Price floor — Shopify selling below the Aosom feed price */}
        {belowFloor > 0 && data.priceFloor && (
          <div className="bg-red-950/20 border border-red-800/40 rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 text-sm font-medium text-red-300">
              {belowFloor} produit{belowFloor > 1 ? "s" : ""} vendu{belowFloor > 1 ? "s" : ""} sous le prix plancher Aosom
              <span className="text-red-400/70 font-normal"> · sur {data.priceFloor.total} comparés{data.priceFloor.auditedAt ? ` · ${timeAgoEpoch(data.priceFloor.auditedAt)}` : ""}</span>
            </div>
            <ul className="divide-y divide-red-900/30">
              {data.priceFloor.topItems.slice(0, 8).map((it) => (
                <li key={it.sku} className="flex items-center justify-between gap-3 px-4 py-2 text-xs">
                  <span className="text-gray-300">{it.sku}</span>
                  <span className="text-gray-500 shrink-0">
                    Shopify {it.shopify_price.toFixed(2)}$ · Aosom {it.aosom_price.toFixed(2)}$
                    <span className="text-red-400"> · {it.gap.toFixed(2)}$</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Stale drafts */}
        {data.staleDraftCount > 0 && (
          <Row
            tone="warn"
            title={`${data.staleDraftCount} draft${data.staleDraftCount > 1 ? "s" : ""} social${data.staleDraftCount > 1 ? "aux" : ""} en attente depuis > 7 jours`}
            detail="À publier ou supprimer dans la section Drafts."
          />
        )}

        {/* Meta token */}
        {token.configured && token.state === "expired" && (
          <Row tone="error" title="Token Meta expiré" detail="Régénérez le token Meta (ads_read/ads_management) et resynchronisez-le." />
        )}
        {token.configured && token.state === "expiring_soon" && (
          <Row tone="warn" title={`Token Meta expire bientôt${token.daysLeft != null ? ` (dans ${token.daysLeft} j)` : ""}`} detail="Régénérez-le avant l'expiration pour ne pas couper les pubs/feeds." />
        )}
        {token.configured && token.state === "unknown" && (
          <Row tone="warn" title="Token Meta : statut inconnu" detail="La vérification debug_token a échoué (réseau ou token révoqué)." />
        )}

        {/* Feeds last fetch */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="px-4 py-2 text-xs font-medium text-gray-400 border-b border-gray-800/60">Feeds — dernier fetch réussi</div>
          <ul className="divide-y divide-gray-800/50">
            {Object.keys(FEED_LABELS).map((type) => {
              const f = data.feeds.find((x) => x.feedType === type);
              const dot = !f || !f.lastStatus ? "bg-gray-600" : f.lastStatus === "success" ? "bg-green-400" : "bg-red-400";
              const failedRecently = f?.lastStatus === "error";
              return (
                <li key={type} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                  <span className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
                    <span className="text-gray-300">{FEED_LABELS[type]}</span>
                  </span>
                  <span className="text-gray-500 shrink-0">
                    {failedRecently && <span className="text-red-400">échec récent · </span>}
                    {!f || f.lastSuccessAt == null
                      ? "jamais réussi"
                      : `${f.itemCount != null ? `${f.itemCount} items · ` : ""}${timeAgoEpoch(f.lastSuccessAt)}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Row({ tone, title, detail }: { tone: "ok" | "warn" | "error"; title: string; detail?: string }) {
  const cls =
    tone === "ok" ? "bg-green-950/20 border-green-800/40 text-green-300"
    : tone === "warn" ? "bg-amber-950/20 border-amber-800/40 text-amber-300"
    : "bg-red-950/20 border-red-800/40 text-red-300";
  return (
    <div className={`p-4 rounded-xl border text-sm ${cls}`}>
      <p className="font-medium">{title}</p>
      {detail && <p className="text-xs opacity-80 mt-0.5">{detail}</p>}
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
