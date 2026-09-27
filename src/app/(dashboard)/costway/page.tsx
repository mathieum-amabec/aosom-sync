"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Catalogue Costway — browse the second supplier's feed (table costway_products).
 * Read-only view: nothing here imports to Shopify yet. One row per product (Item No).
 */

interface CostwayProduct {
  item_no: string;
  title: string;
  category: string;
  top_category: string;
  image: string | null;
  product_url: string | null;
  variants: number;
  in_stock_variants: number;
  qty: number;
  min_price: number | null;
  max_price: number | null;
  price_drop: number | null;
  compare_at_price: number | null;
  colors: string | null;
  promo_tags: string | null;
}

interface Summary {
  products: number;
  inStockProducts: number;
  variants: number;
  inStockVariants: number;
  categories: { category: string; products: number }[];
  promoTags: { tag: string; variants: number }[];
}

interface SyncStats {
  at: number;
  durationMs: number;
  variants: number;
  products: number;
  inserted: number;
  contentUpdated: number;
  volatileUpdated: number;
  removed: number;
  malformedRows: number;
}

interface CostwayResponse {
  products: CostwayProduct[];
  pagination: { page: number; limit: number; total: number; pages: number };
  summary: Summary;
  lastSync: SyncStats | null;
}

const INPUT_CLASS =
  "w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500";

const money = (n: number | null) => (n === null ? "—" : `${n.toFixed(2)} $`);

function priceRange(p: CostwayProduct): string {
  if (p.min_price === null) return "—";
  return p.max_price !== null && p.max_price !== p.min_price
    ? `${money(p.min_price)} – ${money(p.max_price)}`
    : money(p.min_price);
}

function timeAgo(epochSec: number): string {
  const s = Math.floor(Date.now() / 1000) - epochSec;
  if (s < 60) return "à l'instant";
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

export default function CostwayPage() {
  const [data, setData] = useState<CostwayResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [category, setCategory] = useState("");
  const [promoTag, setPromoTag] = useState("");
  const [inStock, setInStock] = useState(true);
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [sort, setSort] = useState("");
  const [page, setPage] = useState(1);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  const fetchCatalog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (category) params.set("category", category);
      if (promoTag) params.set("promoTag", promoTag);
      if (inStock) params.set("inStock", "true");
      if (minPrice) params.set("minPrice", minPrice);
      if (maxPrice) params.set("maxPrice", maxPrice);
      if (sort) params.set("sort", sort);
      const res = await fetch(`/api/costway?${params}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Chargement impossible");
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    }
    setLoading(false);
  }, [page, debouncedSearch, category, promoTag, inStock, minPrice, maxPrice, sort]);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  async function runSync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/costway/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || `HTTP ${res.status}`);
      const s = json.data as SyncStats;
      setSyncMsg(
        `Sync OK : ${s.products.toLocaleString()} produits · ${s.inserted} nouveaux, ${s.contentUpdated} modifiés, ` +
          `${s.volatileUpdated} stock/prix, ${s.removed} retirés`,
      );
      fetchCatalog();
    } catch (err) {
      setSyncMsg(`Échec de la sync : ${err instanceof Error ? err.message : "erreur inconnue"}`);
    }
    setSyncing(false);
  }

  const resetPage = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    setPage(1);
  };

  const summary = data?.summary;
  const lastSync = data?.lastSync;

  return (
    <div className="p-4 md:p-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h2 className="text-2xl font-bold text-white">Catalogue Costway</h2>
          <p className="text-gray-400 text-sm mt-0.5">
            Deuxième fournisseur — catalogue séparé, pas encore importé dans Shopify
            {data && <span className="text-gray-500"> ({data.pagination.total.toLocaleString()} produits)</span>}
          </p>
        </div>
        <button
          onClick={runSync}
          disabled={syncing}
          aria-busy={syncing}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900 disabled:text-blue-300 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors inline-flex items-center gap-2 self-start"
        >
          {syncing && (
            <span aria-hidden="true" className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          )}
          {syncing ? "Synchronisation… (1-3 min)" : "Synchroniser maintenant"}
        </button>
      </div>

      {syncMsg && (
        <div
          className={`mb-4 p-3 rounded-xl text-sm border ${
            syncMsg.startsWith("Échec")
              ? "bg-red-950/30 border-red-900/50 text-red-300"
              : "bg-green-950/30 border-green-900/50 text-green-300"
          }`}
        >
          {syncMsg}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard label="Produits" value={summary ? summary.products.toLocaleString() : "…"} sub={summary ? `${summary.variants.toLocaleString()} variantes` : undefined} />
        <StatCard
          label="En stock"
          value={summary ? summary.inStockProducts.toLocaleString() : "…"}
          sub={summary ? `${summary.inStockVariants.toLocaleString()} variantes` : undefined}
        />
        <StatCard label="Catégories" value={summary ? String(summary.categories.length) : "…"} />
        <StatCard
          label="Dernière sync"
          value={data ? (lastSync ? timeAgo(lastSync.at) : "jamais") : "…"}
          sub={lastSync ? `${Math.round(lastSync.durationMs / 1000)} s · ${lastSync.removed} retirés` : "Cliquer « Synchroniser maintenant »"}
          tone={data && !lastSync ? "warn" : "default"}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3 mb-3">
        <input
          type="search"
          placeholder="Titre, Item No ou SKU…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className={`${INPUT_CLASS} lg:col-span-2`}
        />
        <select value={category} onChange={(e) => resetPage(setCategory)(e.target.value)} className={INPUT_CLASS}>
          <option value="">Toutes les catégories</option>
          {summary?.categories.map((c) => (
            <option key={c.category} value={c.category}>
              {c.category} ({c.products.toLocaleString()})
            </option>
          ))}
        </select>
        <select value={promoTag} onChange={(e) => resetPage(setPromoTag)(e.target.value)} className={INPUT_CLASS}>
          <option value="">Tous les tags Costway</option>
          {summary?.promoTags.map((t) => (
            <option key={t.tag} value={t.tag}>
              {t.tag} ({t.variants.toLocaleString()})
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => resetPage(setSort)(e.target.value)} className={INPUT_CLASS}>
          <option value="">Tri : en stock d&apos;abord</option>
          <option value="price_asc">Prix croissant</option>
          <option value="price_desc">Prix décroissant</option>
          <option value="title">Titre A→Z</option>
          <option value="newest">Nouveaux dans le flux</option>
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <label className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm border cursor-pointer select-none bg-gray-900 border-gray-800 text-gray-300">
          <input
            type="checkbox"
            checked={inStock}
            onChange={(e) => resetPage(setInStock)(e.target.checked)}
            className="rounded bg-gray-800 border-gray-700 text-blue-500 focus:ring-blue-500"
          />
          En stock seulement
        </label>
        <div className="flex gap-2 w-full sm:w-64">
          <input type="number" placeholder="Min $" value={minPrice} onChange={(e) => resetPage(setMinPrice)(e.target.value)} className={INPUT_CLASS} />
          <input type="number" placeholder="Max $" value={maxPrice} onChange={(e) => resetPage(setMaxPrice)(e.target.value)} className={INPUT_CLASS} />
        </div>
      </div>

      {error && <div className="mb-4 p-3 rounded-xl text-sm bg-red-950/30 border border-red-900/50 text-red-300">{error}</div>}

      {!loading && data && data.products.length === 0 && (
        <div className="p-8 text-center text-gray-500 bg-gray-900 border border-gray-800 rounded-xl">
          {lastSync ? "Aucun produit ne correspond aux filtres." : "Le catalogue Costway est vide — lance une première synchronisation."}
        </div>
      )}

      {data && data.products.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-400">
                  <th className="px-4 py-3 text-left font-medium">Produit</th>
                  <th className="px-4 py-3 text-left font-medium hidden md:table-cell">Catégorie</th>
                  <th className="px-4 py-3 text-left font-medium">Stock</th>
                  <th className="px-4 py-3 text-right font-medium">Prix Costway</th>
                  <th className="px-4 py-3 text-right font-medium hidden lg:table-cell" title="Prix annoncé minimum permis par Costway">
                    Plancher
                  </th>
                </tr>
              </thead>
              <tbody className={loading ? "opacity-50" : ""}>
                {data.products.map((p) => (
                  <tr key={p.item_no} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-start gap-3 min-w-[16rem]">
                        {p.image ? (
                          <img src={p.image} alt="" className="w-14 h-14 object-cover rounded bg-gray-800 shrink-0" loading="lazy" />
                        ) : (
                          <div className="w-14 h-14 rounded bg-gray-800 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="text-white font-medium line-clamp-2">
                            {p.product_url ? (
                              <a href={p.product_url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                                {p.title}
                              </a>
                            ) : (
                              p.title
                            )}
                          </div>
                          <div className="text-gray-500 font-mono text-[11px] mt-1">
                            {p.item_no} · {p.variants} variante{p.variants > 1 ? "s" : ""}
                            {p.colors ? ` · ${p.colors.split(",").join(", ")}` : ""}
                          </div>
                          {p.promo_tags && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {p.promo_tags.split(",").map((t) => (
                                <span key={t} className="px-1.5 py-0.5 bg-gray-800 text-gray-400 border border-gray-700 rounded text-[10px]">
                                  {t}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-400 hidden md:table-cell">
                      <div className="line-clamp-2 max-w-xs" title={p.category}>
                        {p.category.split(">").slice(1).join(" › ").trim() || p.top_category}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {p.in_stock_variants > 0 ? (
                        <span className="text-green-400">
                          {p.in_stock_variants}/{p.variants} · {p.qty.toLocaleString()} u.
                        </span>
                      ) : (
                        <span className="text-gray-500">Rupture</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="text-white font-semibold">{priceRange(p)}</div>
                      {p.compare_at_price !== null && p.min_price !== null && p.compare_at_price > p.min_price && (
                        <div className="text-gray-600 text-[11px] line-through">{money(p.compare_at_price)}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-amber-400/80 whitespace-nowrap hidden lg:table-cell">
                      {p.price_drop !== null ? money(p.price_drop) : <span className="text-gray-600">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data && data.pagination.pages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-6 text-sm">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
            className="px-3 py-1.5 rounded-lg border border-gray-800 bg-gray-900 text-gray-300 disabled:opacity-40"
          >
            ← Précédent
          </button>
          <span className="text-gray-500">
            Page {data.pagination.page} / {data.pagination.pages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(data.pagination.pages, p + 1))}
            disabled={page >= data.pagination.pages || loading}
            className="px-3 py-1.5 rounded-lg border border-gray-800 bg-gray-900 text-gray-300 disabled:opacity-40"
          >
            Suivant →
          </button>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, sub, tone = "default" }: { label: string; value: string; sub?: string; tone?: "default" | "warn" }) {
  return (
    <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${tone === "warn" ? "text-amber-400" : "text-white"}`}>{value}</div>
      {sub && <div className="text-[11px] text-gray-600 mt-0.5 truncate">{sub}</div>}
    </div>
  );
}
