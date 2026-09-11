"use client";

/**
 * pos-1 image review — side-by-side approval screen.
 *
 * One card per product: the current featured image (flagged as carrying a marketing or
 * measurement overlay) next to the clean replacement the audit proposes. The decision is
 * deliberately visual — two thumbnails and the model's one-line rationale are enough to
 * judge, and nothing reaches Shopify until "Approuver" is clicked.
 */
import { useCallback, useEffect, useState } from "react";
import type { ImageReviewRow } from "@/lib/database";

const STATUS_LABELS: Record<string, string> = {
  pending: "En attente",
  approved: "Approuvé",
  rejected: "Rejeté",
  applied: "Appliqué",
  failed: "Échec",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
  rejected: "bg-gray-100 text-gray-700",
  applied: "bg-emerald-100 text-emerald-800",
  failed: "bg-red-100 text-red-800",
};

/** Ask the Shopify CDN for a thumbnail so a 300-row queue stays light. */
function thumb(url: string, px = 400): string {
  if (!url.includes("/s/files/")) return url;
  const [path, query] = url.split("?");
  if (!/\.[a-zA-Z]+$/.test(path)) return url;
  const resized = path.replace(/(\.[a-zA-Z]+)$/, `_${px}x${px}$1`);
  return query ? `${resized}?${query}` : resized;
}

export default function ImagesClient() {
  const [rows, setRows] = useState<ImageReviewRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [status, setStatus] = useState("pending");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/images/review?status=${status}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setRows(json.rows ?? []);
      setCounts(json.counts ?? {});
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(id: number, action: "approve" | "reject") {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/images/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setRows((prev) => prev.filter((r) => r.id !== id));
      setCounts((prev) => ({
        ...prev,
        pending: Math.max(0, (prev.pending ?? 1) - 1),
        [json.status]: (prev[json.status] ?? 0) + 1,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const pending = counts.pending ?? 0;

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      <div className="bg-white border-b px-6 py-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Images principales — à approuver</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {pending} produit{pending === 1 ? "" : "s"} dont l&apos;image principale porte un texte ou des mesures
            incrustés, avec une alternative propre trouvée dans le même jeu d&apos;images.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="text-sm border border-gray-300 rounded-md px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="pending">En attente ({counts.pending ?? 0})</option>
            <option value="applied">Appliqués ({counts.applied ?? 0})</option>
            <option value="rejected">Rejetés ({counts.rejected ?? 0})</option>
            <option value="failed">Échecs ({counts.failed ?? 0})</option>
            <option value="all">Tous</option>
          </select>
          <button onClick={() => void load()} className="text-sm text-gray-500 hover:text-gray-700">
            Rafraîchir
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border-b border-red-200 px-6 py-2 text-sm text-red-700 flex items-center">
          {error}
          <button className="ml-2 underline" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {loading && <p className="text-sm text-gray-500">Chargement…</p>}
        {!loading && rows.length === 0 && (
          <p className="text-sm text-gray-500">Aucun produit dans cette vue.</p>
        )}

        {rows.map((r) => (
          <div key={r.id} className="bg-white border rounded-lg p-4">
            <div className="flex items-start justify-between gap-4 mb-3 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <code className="text-sm font-medium text-gray-900">{r.sku}</code>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[r.status] ?? "bg-gray-100"}`}>
                    {STATUS_LABELS[r.status] ?? r.status}
                  </span>
                  {r.source === "feed" && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">
                      flux Aosom — téléversement requis
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-600 mt-0.5 truncate max-w-xl">{r.name}</p>
                <a
                  href={`https://admin.shopify.com/store/27u5y2-kp/products/${r.shopifyProductId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-blue-600 hover:underline"
                >
                  Ouvrir dans Shopify ↗
                </a>
              </div>
              {r.status === "pending" && (
                <div className="flex gap-2">
                  <button
                    disabled={busy === r.id}
                    onClick={() => void decide(r.id, "approve")}
                    className="text-sm px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {busy === r.id ? "…" : "Approuver le remplacement"}
                  </button>
                  <button
                    disabled={busy === r.id}
                    onClick={() => void decide(r.id, "reject")}
                    className="text-sm px-3 py-1.5 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    Garder l&apos;actuelle
                  </button>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <figure className="m-0">
                <figcaption className="text-xs font-medium text-red-700 mb-1">Actuelle (non conforme)</figcaption>
                <a href={r.currentUrl} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={thumb(r.currentUrl)}
                    alt=""
                    loading="lazy"
                    className="w-full max-w-[260px] aspect-square object-contain bg-gray-50 rounded border-2 border-red-300"
                  />
                </a>
                <p className="text-xs text-gray-500 mt-1 max-w-[260px]">{r.currentReason}</p>
              </figure>

              <figure className="m-0">
                <figcaption className="text-xs font-medium text-emerald-700 mb-1">
                  Proposée{r.proposedPosition ? ` — position ${r.proposedPosition}` : ""}
                </figcaption>
                <a href={r.proposedUrl} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={thumb(r.proposedUrl)}
                    alt=""
                    loading="lazy"
                    className="w-full max-w-[260px] aspect-square object-contain bg-gray-50 rounded border-2 border-emerald-300"
                  />
                </a>
                <p className="text-xs text-gray-500 mt-1 max-w-[260px]">{r.proposedReason}</p>
              </figure>
            </div>

            {r.error && <p className="text-xs text-red-600 mt-2">{r.error}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
