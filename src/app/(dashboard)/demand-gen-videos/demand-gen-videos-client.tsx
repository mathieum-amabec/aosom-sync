"use client";

import { useEffect, useMemo, useState } from "react";

// Mirrors the DTO from /api/demand-gen-videos.
interface DemandGenAssetDTO {
  id: number;
  sku: string;
  titleFr: string | null;
  ratio: string;
  durationSec: number;
  bytes: number | null;
  blobUrl: string;
  metaUploaded: boolean;
  youtubeUploaded: boolean;
}

interface DemandGenCounts {
  total: number;
  meta: number;
  youtube: number;
}

const RATIO_ALL = "all";

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "—";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

function UploadBadge({ uploaded }: { uploaded: boolean }) {
  return uploaded ? (
    <span className="inline-flex items-center rounded-full border border-green-800/50 bg-green-900/40 px-2 py-0.5 text-xs text-green-400">
      ✓ Uploadé
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full border border-gray-700 bg-gray-800 px-2 py-0.5 text-xs text-gray-400">
      Non
    </span>
  );
}

export default function DemandGenVideosClient() {
  const [assets, setAssets] = useState<DemandGenAssetDTO[]>([]);
  const [counts, setCounts] = useState<DemandGenCounts>({ total: 0, meta: 0, youtube: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [ratio, setRatio] = useState<string>(RATIO_ALL);
  const [skuQuery, setSkuQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/demand-gen-videos");
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok || !json.success) {
          setError(json.error || "Échec du chargement");
        } else {
          setAssets(json.data as DemandGenAssetDTO[]);
          setCounts(json.counts as DemandGenCounts);
        }
      } catch {
        if (!cancelled) setError("Échec du chargement");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Ratios present in the data, for the filter dropdown (stable order).
  const ratios = useMemo(() => {
    return Array.from(new Set(assets.map((a) => a.ratio))).sort();
  }, [assets]);

  const filtered = useMemo(() => {
    const q = skuQuery.trim().toLowerCase();
    return assets.filter((a) => {
      if (ratio !== RATIO_ALL && a.ratio !== ratio) return false;
      if (q && !a.sku.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [assets, ratio, skuQuery]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-xl font-semibold text-gray-100">Vidéos Demand Gen</h1>
      <p className="text-sm text-gray-500 mt-1">
        Assets vidéo rendus + uploadés ({"video_demand_gen"}). Une ligne par SKU / ratio / durée.
      </p>

      {/* Counters */}
      <div className="mt-4 flex flex-wrap gap-3">
        <div className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-3">
          <div className="text-2xl font-semibold text-gray-100">{counts.total}</div>
          <div className="text-xs text-gray-500">Assets au total</div>
        </div>
        <div className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-3">
          <div className="text-2xl font-semibold text-blue-400">
            {counts.meta}/{counts.total}
          </div>
          <div className="text-xs text-gray-500">Uploadés Meta</div>
        </div>
        <div className="rounded-xl border border-gray-800 bg-gray-900 px-4 py-3">
          <div className="text-2xl font-semibold text-red-400">
            {counts.youtube}/{counts.total}
          </div>
          <div className="text-xs text-gray-500">Uploadés YouTube</div>
        </div>
      </div>

      {/* Filters */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <select
          value={ratio}
          onChange={(e) => setRatio(e.target.value)}
          className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200"
          aria-label="Filtrer par ratio"
        >
          <option value={RATIO_ALL}>Tous les ratios</option>
          {ratios.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <input
          type="search"
          value={skuQuery}
          onChange={(e) => setSkuQuery(e.target.value)}
          placeholder="Rechercher un SKU…"
          className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200 placeholder-gray-600"
          aria-label="Rechercher par SKU"
        />
        <span className="text-xs text-gray-500">
          {filtered.length} / {assets.length} affichés
        </span>
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto rounded-xl border border-gray-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wide text-gray-500">
              <th className="px-3 py-2 font-medium">SKU</th>
              <th className="px-3 py-2 font-medium">Titre FR</th>
              <th className="px-3 py-2 font-medium">Ratio</th>
              <th className="px-3 py-2 font-medium">Durée</th>
              <th className="px-3 py-2 font-medium">Taille</th>
              <th className="px-3 py-2 font-medium">Meta</th>
              <th className="px-3 py-2 font-medium">YouTube</th>
              <th className="px-3 py-2 font-medium">Vidéo</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-gray-500">
                  Chargement…
                </td>
              </tr>
            ) : error ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-red-400">
                  {error}
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-gray-500">
                  Aucun asset.
                </td>
              </tr>
            ) : (
              filtered.map((a) => (
                <tr key={a.id} className="border-b border-gray-800/60 text-gray-300">
                  <td className="px-3 py-2 font-mono text-xs text-gray-200">{a.sku}</td>
                  <td className="px-3 py-2 max-w-xs truncate" title={a.titleFr ?? ""}>
                    {a.titleFr ?? "—"}
                  </td>
                  <td className="px-3 py-2">{a.ratio}</td>
                  <td className="px-3 py-2">{a.durationSec}s</td>
                  <td className="px-3 py-2 text-gray-400">{formatBytes(a.bytes)}</td>
                  <td className="px-3 py-2">
                    <UploadBadge uploaded={a.metaUploaded} />
                  </td>
                  <td className="px-3 py-2">
                    <UploadBadge uploaded={a.youtubeUploaded} />
                  </td>
                  <td className="px-3 py-2">
                    {a.blobUrl ? (
                      <a
                        href={a.blobUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300"
                        aria-label={`Lire la vidéo ${a.sku} ${a.ratio} ${a.durationSec}s`}
                      >
                        ▶
                      </a>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
