"use client";

import { useState, useEffect } from "react";
import type { SyncRun } from "@/types/sync";

interface PriceChange {
  sku: string; name: string; image: string; oldPrice: number; newPrice: number; change: number; pct: number; recordedAt: string; inStore: boolean;
}
interface TopSeller {
  sku: string; name: string; image: string; color: string; productType: string; price: number;
  currentQty: number; soldPerDay: number; daysTracked: number; inStore: boolean;
}

export function DashboardClient({ recentRuns, latestRun }: { recentRuns: SyncRun[]; latestRun: SyncRun | null }) {
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [priceChanges, setPriceChanges] = useState<PriceChange[]>([]);
  const [topSellers, setTopSellers] = useState<TopSeller[]>([]);

  useEffect(() => {
    fetch("/api/insights")
      .then((r) => r.json())
      .then((d) => {
        const data = d.data || d;
        setPriceChanges(data.changes || []);
        setTopSellers(data.trending || data.sellers || []);
      })
      .catch(() => {});
  }, []);

  async function triggerSync(dryRun: boolean) {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/sync/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun }),
      });
      const data = await res.json();
      if (data.success && data.data) {
        const d = data.data;
        setSyncResult(
          dryRun
            ? `Dry run complete: ${d.newProducts} new, ${d.priceUpdates} price updates, ${d.stockChanges} stock changes, ${d.archived} to archive`
            : `Sync complete: ${d.priceUpdates} prices updated, ${d.stockChanges} stock changes, ${d.newProducts} new detected, ${d.archived} archived, ${d.errors} errors`
        );
      } else {
        setSyncResult(`Error: ${data.error}`);
      }
    } catch (err) {
      setSyncResult(`Error: ${err}`);
    }
    setSyncing(false);
  }

  return (
    <div className="p-8 max-w-5xl">
      <h2 className="text-2xl font-bold text-white mb-1">Dashboard</h2>
      <p className="text-gray-400 text-sm mb-8">
        Aosom catalogue sync overview
      </p>

      {/* Last Sync Banner */}
      {latestRun && (
        <div
          className={`mb-6 p-4 rounded-xl border text-sm flex items-center justify-between ${
            latestRun.status === "completed"
              ? "bg-green-950/20 border-green-800/40 text-green-300"
              : latestRun.status === "failed"
                ? "bg-red-950/20 border-red-800/40 text-red-300"
                : "bg-blue-950/20 border-blue-800/40 text-blue-300"
          }`}
        >
          <div>
            Last sync: {timeAgo(latestRun.startedAt)} | {latestRun.totalProducts.toLocaleString("en-US")} products scanned
            {(latestRun.updated > 0 || latestRun.archived > 0) && (
              <span>
                {" "}| {latestRun.updated} updated, {latestRun.archived} archived
              </span>
            )}
            {latestRun.errors > 0 && (
              <span className="text-red-400"> | {latestRun.errors} errors</span>
            )}
          </div>
          <StatusBadge status={latestRun.status} />
        </div>
      )}

      {/* Quick Actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        <button
          onClick={() => triggerSync(true)}
          disabled={syncing}
          className="flex flex-col items-start p-5 bg-gray-900 border border-gray-800 rounded-xl hover:border-gray-700 transition-colors text-left"
        >
          <span className="text-sm font-medium text-gray-300">
            Dry Run Sync
          </span>
          <span className="text-xs text-gray-500 mt-1">
            Preview changes without applying
          </span>
        </button>
        <button
          onClick={() => triggerSync(false)}
          disabled={syncing}
          className="flex flex-col items-start p-5 bg-gray-900 border border-blue-800/50 rounded-xl hover:border-blue-700/50 transition-colors text-left"
        >
          <span className="text-sm font-medium text-blue-400">
            Run Full Sync
          </span>
          <span className="text-xs text-gray-500 mt-1">
            Fetch CSV, diff, and update Shopify
          </span>
        </button>
      </div>

      {syncing && (
        <div className="mb-6 p-4 bg-gray-900 border border-gray-800 rounded-xl">
          <div className="flex items-center gap-3">
            <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-gray-300">
              Sync in progress...
            </span>
          </div>
        </div>
      )}

      {syncResult && (
        <div
          className={`mb-6 p-4 rounded-xl border text-sm ${
            syncResult.startsWith("Error")
              ? "bg-red-950/30 border-red-800/50 text-red-300"
              : "bg-green-950/30 border-green-800/50 text-green-300"
          }`}
        >
          {syncResult}
        </div>
      )}

      {/* Insights: Price Drops + Top Sellers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Price Drops */}
        <div>
          <h3 className="text-lg font-semibold text-white mb-3">Price Drops</h3>
          {priceChanges.filter((c) => c.change < 0).length === 0 ? (
            <div className="p-6 bg-gray-900 border border-gray-800 rounded-xl text-center">
              <p className="text-gray-500 text-sm">No price changes detected yet</p>
              <p className="text-gray-600 text-xs mt-1">Run syncs on different days to track price movement</p>
            </div>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              {priceChanges.filter((c) => c.change < 0).slice(0, 10).map((c) => (
                <div key={c.sku} className="flex items-center gap-3 px-4 py-3 border-b border-gray-800/50 last:border-0">
                  {c.image && <img src={c.image} alt="" className="w-8 h-8 rounded bg-gray-800 object-cover shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-white truncate">{c.name}</p>
                      <StoreBadge inStore={c.inStore} />
                    </div>
                    <p className="text-xs text-gray-500">{c.sku}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm text-green-400 font-medium">-${Math.abs(c.change).toFixed(2)}</p>
                    <p className="text-xs text-green-400/70">{c.pct.toFixed(1)}% off</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Top Sellers (by stock velocity) */}
        <div>
          <h3 className="text-lg font-semibold text-white mb-3">Trending Products</h3>
          {topSellers.length === 0 ? (
            <div className="p-6 bg-gray-900 border border-gray-800 rounded-xl text-center">
              <p className="text-gray-500 text-sm">Not enough data yet</p>
              <p className="text-gray-600 text-xs mt-1">Need 2+ syncs on different days to calculate stock velocity</p>
            </div>
          ) : (
            <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              {topSellers.slice(0, 10).map((s) => (
                <div key={s.sku} className="flex items-center gap-3 px-4 py-3 border-b border-gray-800/50 last:border-0">
                  {s.image && <img src={s.image} alt="" className="w-8 h-8 rounded bg-gray-800 object-cover shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-white truncate">{s.name}</p>
                      <StoreBadge inStore={s.inStore} />
                    </div>
                    <p className="text-xs text-gray-500">${s.price.toFixed(2)} | {s.currentQty} left</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm text-orange-400 font-medium">{s.soldPerDay}/day</p>
                    <p className="text-xs text-gray-500">{s.daysTracked}d tracked</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Recent Sync Runs */}
      <h3 className="text-lg font-semibold text-white mb-4">
        Recent Sync Runs
      </h3>
      {recentRuns.length === 0 ? (
        <div className="p-8 bg-gray-900 border border-gray-800 rounded-xl text-center">
          <p className="text-gray-500 text-sm">No sync runs yet</p>
          <p className="text-gray-600 text-xs mt-1">
            Run your first sync to see results here
          </p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-400">
                <th className="text-left px-4 py-3 font-medium">Date</th>
                <th className="text-left px-4 py-3 font-medium">Status</th>
                <th className="text-right px-4 py-3 font-medium">Created</th>
                <th className="text-right px-4 py-3 font-medium">Updated</th>
                <th className="text-right px-4 py-3 font-medium">Archived</th>
                <th className="text-right px-4 py-3 font-medium">Errors</th>
              </tr>
            </thead>
            <tbody>
              {recentRuns.map((run) => (
                <tr
                  key={run.id}
                  className="border-b border-gray-800/50 hover:bg-gray-800/30"
                >
                  <td className="px-4 py-3 text-gray-300">
                    {new Date(run.startedAt).toLocaleString("en-US")}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="px-4 py-3 text-right text-green-400">
                    {run.created || 0}
                  </td>
                  <td className="px-4 py-3 text-right text-blue-400">
                    {run.updated || 0}
                  </td>
                  <td className="px-4 py-3 text-right text-yellow-400">
                    {run.archived || 0}
                  </td>
                  <td className="px-4 py-3 text-right text-red-400">
                    {run.errors || 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function StoreBadge({ inStore }: { inStore: boolean }) {
  return (
    <span
      className={`inline-flex shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${
        inStore
          ? "bg-blue-900/40 text-blue-400 border border-blue-800/50"
          : "bg-gray-800/60 text-gray-500 border border-gray-700/50"
      }`}
      title={inStore ? "Product is in your Shopify store" : "Not imported to Shopify yet"}
    >
      {inStore ? "In store" : "Not imported"}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    completed: "bg-green-900/40 text-green-400 border-green-800/50",
    running: "bg-blue-900/40 text-blue-400 border-blue-800/50",
    failed: "bg-red-900/40 text-red-400 border-red-800/50",
  };

  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-md text-xs font-medium border ${
        styles[status] || styles.failed
      }`}
    >
      {status}
    </span>
  );
}
