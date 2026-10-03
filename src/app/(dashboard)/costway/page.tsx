"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Catalogue Costway — browse the second supplier's feed (table costway_products) and follow the
 * lot imported to Shopify. One row per product (Item No). Fulfilment is manual: the "Recherche de
 * commande" box turns the opaque SKU of a Shopify order into what to order at costway.ca.
 * Internal admin page — the supplier SKUs shown here never ship to Shopify.
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
  imported: boolean;
  shopify_product_id: string | null;
  shopify_handle: string | null;
  import_batch: string | null;
  import_status: string | null;
  sell_price: number | null;
  margin_pct: number | null;
  margin_dollars: number | null;
  imported_at: number | null;
}

interface ImportSummary {
  importedProducts: number;
  importedVariants: number;
  byStatus: { status: string; products: number; variants: number }[];
  byBatch: { batch: string; products: number; variants: number; importedAt: number | null }[];
  estimatedMarginPerSale: number;
}

interface LookupHit {
  internal_sku: string | null;
  supplier_sku: string;
  item_no: string;
  title: string;
  color: string;
  product_url: string;
  feed_price: number | null;
  cost: number | null;
  sell_price: number | null;
  margin_dollars: number | null;
  margin_pct: number | null;
  in_stock: boolean;
  qty: number;
  ca_qty: number | null;
  us_qty: number | null;
  removed: boolean;
  imported: boolean;
  shopify_handle: string | null;
  import_status: string | null;
  import_batch: string | null;
}

type ImportedFilter = "all" | "only" | "exclude";

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
  importSummary: ImportSummary;
}

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  draft: { label: "Brouillon", cls: "bg-amber-950/40 text-amber-300 border-amber-900/60" },
  active: { label: "En ligne", cls: "bg-green-950/40 text-green-300 border-green-900/60" },
  archived: { label: "Archivé", cls: "bg-gray-800 text-gray-400 border-gray-700" },
};

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
  const [imported, setImported] = useState<ImportedFilter>("all");
  const [batch, setBatch] = useState("");
  const [page, setPage] = useState(1);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [lookupQ, setLookupQ] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupHits, setLookupHits] = useState<LookupHit[] | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

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
      if (imported !== "all") params.set("imported", imported);
      if (batch) params.set("batch", batch);
      const res = await fetch(`/api/costway?${params}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Chargement impossible");
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur inconnue");
    }
    setLoading(false);
  }, [page, debouncedSearch, category, promoTag, inStock, minPrice, maxPrice, sort, imported, batch]);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  async function runLookup(e?: { preventDefault: () => void }) {
    e?.preventDefault();
    const q = lookupQ.trim();
    if (!q) return;
    setLookupLoading(true);
    setLookupError(null);
    setLookupHits(null);
    try {
      const res = await fetch(`/api/costway/lookup?q=${encodeURIComponent(q)}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error || "Recherche impossible");
      setLookupHits(json.data as LookupHit[]);
    } catch (err) {
      setLookupError(err instanceof Error ? err.message : "Erreur inconnue");
    }
    setLookupLoading(false);
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied((c) => (c === text ? null : c)), 1500);
    } catch {
      setCopied(null);
    }
  }

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
            Deuxième fournisseur — catalogue séparé · import et commandes faits à la main
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

      <section aria-labelledby="lookup-title" className="mb-6 p-4 bg-gray-900 border border-blue-900/50 rounded-xl">
        <h3 id="lookup-title" className="text-sm font-semibold text-white">
          Recherche de commande
        </h3>
        <p className="text-xs text-gray-500 mt-0.5 mb-3">
          Colle le SKU d&apos;une commande Shopify (ex. M7ZGG3GC) pour voir quoi commander sur costway.ca.
        </p>
        <form onSubmit={runLookup} className="flex flex-col sm:flex-row gap-2">
          <input
            type="search"
            value={lookupQ}
            onChange={(e) => setLookupQ(e.target.value)}
            placeholder="SKU de la commande, SKU Costway ou Item No…"
            aria-label="SKU de la commande"
            className={`${INPUT_CLASS} font-mono sm:flex-1`}
          />
          <button
            type="submit"
            disabled={lookupLoading || !lookupQ.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900 disabled:text-blue-300 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
          >
            {lookupLoading ? "Recherche…" : "Chercher"}
          </button>
        </form>
        {lookupError && <div className="mt-3 p-3 rounded-lg text-sm bg-red-950/30 border border-red-900/50 text-red-300">{lookupError}</div>}
        {lookupHits && lookupHits.length === 0 && (
          <div className="mt-3 p-3 rounded-lg text-sm bg-gray-950 border border-gray-800 text-gray-400">
            Aucun article Costway ne correspond à « {lookupQ.trim()} ». Vérifie le SKU (un SKU d&apos;Aosom ne se trouve pas ici).
          </div>
        )}
        {lookupHits && lookupHits.length > 0 && (
          <div className="mt-3 space-y-3">
            {lookupHits.map((h) => (
              <LookupCard key={h.supplier_sku} hit={h} copied={copied} onCopy={copyText} />
            ))}
          </div>
        )}
      </section>

      {data?.importSummary && data.importSummary.importedProducts > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
          <StatCard
            label="Importés dans Shopify"
            value={data.importSummary.importedProducts.toLocaleString()}
            sub={`${data.importSummary.importedVariants.toLocaleString()} variantes`}
          />
          {data.importSummary.byStatus.map((s) => (
            <StatCard
              key={s.status}
              label={STATUS_LABEL[s.status]?.label ?? s.status}
              value={s.products.toLocaleString()}
              sub={`${s.variants.toLocaleString()} variantes`}
            />
          ))}
          <StatCard
            label="Marge si chacun se vend 1×"
            value={money(data.importSummary.estimatedMarginPerSale)}
            sub="avant frais de paiement et retours"
          />
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
        <div role="group" aria-label="Filtre d'import" className="inline-flex rounded-lg border border-gray-800 overflow-hidden text-sm">
          {(
            [
              ["all", "Tous"],
              ["only", "Importés"],
              ["exclude", "Non importés"],
            ] as [ImportedFilter, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={imported === value}
              onClick={() => resetPage(setImported)(value)}
              className={`px-3 py-2 transition-colors ${
                imported === value ? "bg-blue-600 text-white" : "bg-gray-900 text-gray-300 hover:bg-gray-800"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {data && data.importSummary.byBatch.length > 0 && (
          <select
            value={batch}
            onChange={(e) => resetPage(setBatch)(e.target.value)}
            aria-label="Lot d'import"
            className={`${INPUT_CLASS} sm:w-56`}
          >
            <option value="">Tous les lots</option>
            {data.importSummary.byBatch.map((b) => (
              <option key={b.batch} value={b.batch}>
                {b.batch} ({b.products})
              </option>
            ))}
          </select>
        )}
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
                  <th className="px-4 py-3 text-left font-medium" title="Statut dans Shopify, lot, notre prix et notre marge brute">
                    Shopify
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
                    <td className="px-4 py-3 whitespace-nowrap">
                      {p.imported ? (
                        <div>
                          <span
                            className={`px-1.5 py-0.5 border rounded text-[11px] ${
                              STATUS_LABEL[p.import_status ?? ""]?.cls ?? "bg-gray-800 text-gray-400 border-gray-700"
                            }`}
                          >
                            {STATUS_LABEL[p.import_status ?? ""]?.label ?? p.import_status ?? "Importé"}
                          </span>
                          {p.import_batch && <span className="ml-1.5 text-[11px] text-gray-500">{p.import_batch}</span>}
                          <div className="text-white text-xs mt-1">{money(p.sell_price)}</div>
                          {p.margin_pct !== null && (
                            <div className="text-green-400/80 text-[11px]">
                              marge {p.margin_pct.toFixed(1)} % · {money(p.margin_dollars)}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-600 text-xs">—</span>
                      )}
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

function LookupCard({ hit, copied, onCopy }: { hit: LookupHit; copied: string | null; onCopy: (text: string) => void }) {
  const caStock = hit.ca_qty ?? 0;
  const stockTone = !hit.in_stock || hit.removed ? "text-red-400" : caStock > 0 ? "text-green-400" : "text-amber-400";
  return (
    <div className="p-4 bg-gray-950 border border-gray-800 rounded-lg">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
        <div className="min-w-0">
          <div className="text-white font-medium">{hit.title}</div>
          <div className="text-xs text-gray-500 mt-0.5">
            {hit.color ? `${hit.color} · ` : ""}Item No {hit.item_no}
            {hit.internal_sku ? ` · notre SKU ${hit.internal_sku}` : " · pas encore de SKU interne"}
          </div>
        </div>
        {hit.import_status && (
          <span
            className={`self-start px-1.5 py-0.5 border rounded text-[11px] ${
              STATUS_LABEL[hit.import_status]?.cls ?? "bg-gray-800 text-gray-400 border-gray-700"
            }`}
          >
            {STATUS_LABEL[hit.import_status]?.label ?? hit.import_status}
            {hit.import_batch ? ` · ${hit.import_batch}` : ""}
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-xs text-gray-500">SKU à commander :</span>
        <code className="px-2 py-1 bg-gray-900 border border-gray-800 rounded text-sm text-white font-mono">{hit.supplier_sku}</code>
        <button
          type="button"
          onClick={() => onCopy(hit.supplier_sku)}
          className="px-2.5 py-1 text-xs rounded border border-gray-700 bg-gray-900 text-gray-300 hover:bg-gray-800"
        >
          {copied === hit.supplier_sku ? "Copié ✓" : "Copier"}
        </button>
        {hit.product_url && (
          <a
            href={hit.product_url}
            target="_blank"
            rel="noopener noreferrer"
            className="px-2.5 py-1 text-xs rounded bg-blue-600 hover:bg-blue-500 text-white"
          >
            Ouvrir sur costway.ca ↗
          </a>
        )}
      </div>

      <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div>
          <dt className="text-[11px] text-gray-500">Notre coût</dt>
          <dd className="text-white font-semibold">{money(hit.cost)}</dd>
          <dd className="text-[11px] text-gray-600">prix Costway {money(hit.feed_price)}</dd>
        </div>
        <div>
          <dt className="text-[11px] text-gray-500">Prix Shopify</dt>
          <dd className="text-white font-semibold">{money(hit.sell_price)}</dd>
          {hit.margin_pct !== null && (
            <dd className="text-[11px] text-green-400/80">
              marge {hit.margin_pct.toFixed(1)} % · {money(hit.margin_dollars)}
            </dd>
          )}
        </div>
        <div>
          <dt className="text-[11px] text-gray-500">Stock Costway</dt>
          <dd className={`font-semibold ${stockTone}`}>
            {hit.removed ? "Retiré du flux" : hit.in_stock ? `${hit.qty.toLocaleString()} u.` : "Rupture"}
          </dd>
          <dd className="text-[11px] text-gray-600">
            Canada {hit.ca_qty ?? "—"} · É.-U. {hit.us_qty ?? "—"}
          </dd>
        </div>
        <div>
          <dt className="text-[11px] text-gray-500">Livraison</dt>
          <dd className={`font-semibold ${caStock > 0 ? "text-green-400" : "text-amber-400"}`}>
            {caStock > 0 ? "Entrepôt canadien" : "Depuis les É.-U."}
          </dd>
          <dd className="text-[11px] text-gray-600">{caStock > 0 ? "délai plus court" : "délai plus long"}</dd>
        </div>
      </dl>
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
