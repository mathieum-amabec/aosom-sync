"use client";

import { Suspense, useState, useEffect, useCallback } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { storeLink } from "@/lib/insights";

interface CatalogProduct {
  sku: string;
  name: string;
  price: number;
  qty: number;
  color: string;
  product_type: string;
  image1: string;
  psin: string;
  import_status: string | null;
  /** Shopify product id when imported (drives the In store / Not imported badge). */
  shopify_product_id: string | null;
  shopify_handle?: string | null;
  /** old_price of the SKU's most recent price change; drives the ▼/▲ movement badge. */
  prev_price: number | null;
  [key: string]: unknown;
}

interface CatalogStats {
  total: number;
  imported: number;
  withDiscount: number;
  lastSync: { name: string; status: string; ranAt: number } | null;
}

/**
 * In-store status badge. "In store" links to the Shopify product (storefront when
 * the handle is known, else admin) — works on mobile and desktop. "Not imported"
 * is a muted badge. Driven by shopify_product_id (the catalog API field), not the
 * never-populated import_status.
 */
function StoreBadge({ product }: { product: CatalogProduct }) {
  const { inStore, shopifyUrl } = storeLink(product.shopify_product_id, product.shopify_handle);
  if (inStore && shopifyUrl) {
    return (
      <a
        href={shopifyUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-0.5 px-2 py-0.5 bg-green-900/40 text-green-400 border border-green-800/50 rounded-md text-xs font-medium hover:bg-green-900/60 transition-colors shrink-0"
      >
        In store ↗
      </a>
    );
  }
  return (
    <span className="inline-flex items-center px-2 py-0.5 bg-gray-800 text-gray-500 border border-gray-700 rounded-md text-xs font-medium shrink-0">
      Not imported
    </span>
  );
}

interface CatalogResponse {
  products: CatalogProduct[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
  productTypes: { type: string; count: number }[];
}

const INPUT_CLASS =
  "w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
const TOGGLE_BASE =
  "flex items-center gap-2 px-3 py-2 rounded-lg text-sm border cursor-pointer transition-colors select-none";

function timeAgo(epochSec: number): string {
  const s = Math.floor(Date.now() / 1000) - epochSec;
  if (s < 60) return "à l'instant";
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  return `il y a ${d} j`;
}

// useSearchParams() must be read under a Suspense boundary.
export default function CatalogPage() {
  return (
    <Suspense fallback={<div className="p-8 text-gray-500 text-sm">Chargement…</div>}>
      <CatalogBrowser />
    </Suspense>
  );
}

function CatalogBrowser() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const [data, setData] = useState<CatalogResponse | null>(null);
  const [stats, setStats] = useState<CatalogStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters — initialised from the URL so links/refreshes are sticky.
  const [search, setSearch] = useState(() => sp.get("search") ?? "");
  const [searchInput, setSearchInput] = useState(() => sp.get("search") ?? "");
  const [productType, setProductType] = useState(() => sp.get("productType") ?? "");
  const [minPrice, setMinPrice] = useState(() => sp.get("minPrice") ?? "");
  const [maxPrice, setMaxPrice] = useState(() => sp.get("maxPrice") ?? "");
  const [inStock, setInStock] = useState(() => sp.get("inStock") === "true");
  const [notImported, setNotImported] = useState(() => sp.get("notImported") === "true");
  const [withDiscount, setWithDiscount] = useState(() => sp.get("withDiscount") === "true");
  const [lowStock, setLowStock] = useState(() => sp.get("lowStock") === "true");
  const [sort, setSort] = useState(() => sp.get("sort") ?? "");
  const [page, setPage] = useState(() => Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1));

  // Selection + bulk-import confirmation.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingImport, setConfirmingImport] = useState(false);

  // Build the query params shared by the fetch and the URL (page=1 / falsy omitted).
  const buildParams = useCallback(() => {
    const p = new URLSearchParams();
    if (search) p.set("search", search);
    if (productType) p.set("productType", productType);
    if (minPrice) p.set("minPrice", minPrice);
    if (maxPrice) p.set("maxPrice", maxPrice);
    if (inStock) p.set("inStock", "true");
    if (notImported) p.set("notImported", "true");
    if (withDiscount) p.set("withDiscount", "true");
    if (lowStock) p.set("lowStock", "true");
    if (sort) p.set("sort", sort);
    if (page > 1) p.set("page", String(page));
    return p;
  }, [search, productType, minPrice, maxPrice, inStock, notImported, withDiscount, lowStock, sort, page]);

  const fetchCatalog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = buildParams();
      params.set("limit", "50");
      const res = await fetch(`/api/catalog?${params}`);
      if (!res.ok) throw new Error("Failed to fetch catalog");
      const json = await res.json();
      setData(json.data || json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
    setLoading(false);
  }, [buildParams]);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  // Keep the URL in sync with the active filters (shareable + survives refresh).
  useEffect(() => {
    const qs = buildParams().toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [buildParams, router, pathname]);

  // Header stats — fetched once on mount (independent of filters/pagination).
  const loadStats = useCallback(async () => {
    try {
      const res = await fetch("/api/catalog/stats");
      const json = await res.json();
      if (json.success) setStats(json.data);
    } catch {
      // non-fatal — the cards just stay blank
    }
  }, []);
  useEffect(() => {
    loadStats();
  }, [loadStats]);

  // Debounced search.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  function toggleSelect(sku: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }

  function selectAllOnPage() {
    if (!data) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of data.products) next.add(p.sku);
      return next;
    });
  }

  function deselectAll() {
    setSelected(new Set());
  }

  /** Header checkbox: toggles every product on the current page. */
  function toggleAllOnPage() {
    if (!data) return;
    const allSkus = data.products.map((p) => p.sku);
    const allSelected = allSkus.every((s) => selected.has(s));
    if (allSelected) deselectAll();
    else selectAllOnPage();
  }

  async function sendToImport() {
    const skus = Array.from(selected);
    try {
      const res = await fetch("/api/import/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skus }),
      });
      if (res.ok) {
        setSelected(new Set());
        setConfirmingImport(false);
        window.location.href = "/import";
      }
    } catch {
      alert("Failed to queue products");
    }
  }

  return (
    <div className="p-4 md:p-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h2 className="text-2xl font-bold text-white">Catalogue</h2>
          <p className="text-gray-400 text-sm mt-0.5">
            Browse Aosom products{" "}
            {data && (
              <span className="text-gray-500">
                ({data.pagination.total.toLocaleString()} products)
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Stats header */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard label="Total catalogue" value={stats ? stats.total.toLocaleString() : "…"} />
        <StatCard label="Importés Shopify" value={stats ? stats.imported.toLocaleString() : "…"} />
        <StatCard label="Avec rabais actif" value={stats ? stats.withDiscount.toLocaleString() : "…"} />
        <StatCard
          label="Dernière sync"
          value={stats ? (stats.lastSync ? timeAgo(stats.lastSync.ranAt) : "—") : "…"}
          sub={
            stats?.lastSync
              ? `${stats.lastSync.name} · ${stats.lastSync.status === "success" ? "OK" : "erreur"}`
              : undefined
          }
          tone={stats?.lastSync && stats.lastSync.status !== "success" ? "warn" : "default"}
        />
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 md:grid-cols-6 gap-3 mb-3">
        <div className="md:col-span-2">
          <input
            type="text"
            placeholder="Search products..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <select
            value={productType}
            onChange={(e) => {
              setProductType(e.target.value);
              setPage(1);
            }}
            className={INPUT_CLASS}
          >
            <option value="">All categories</option>
            {data?.productTypes
              .filter((t) => !t.type.includes(">"))
              .map((t) => (
                <option key={t.type} value={t.type}>
                  {t.type} ({t.count})
                </option>
              ))}
          </select>
        </div>
        <div>
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              setPage(1);
            }}
            className={INPUT_CLASS}
          >
            <option value="">Sort by name</option>
            <option value="best_sellers">Best sellers (14d)</option>
            <option value="price_drop">Price drop %</option>
            <option value="price_asc">Price: low to high</option>
            <option value="price_desc">Price: high to low</option>
            <option value="qty_asc">Stock: low first</option>
            <option value="qty_desc">Stock: high first</option>
            <option value="low_stock">Low stock (in stock)</option>
          </select>
        </div>
        <div className="flex gap-2">
          <input
            type="number"
            placeholder="Min $"
            value={minPrice}
            onChange={(e) => {
              setMinPrice(e.target.value);
              setPage(1);
            }}
            className={INPUT_CLASS}
          />
          <input
            type="number"
            placeholder="Max $"
            value={maxPrice}
            onChange={(e) => {
              setMaxPrice(e.target.value);
              setPage(1);
            }}
            className={INPUT_CLASS}
          />
        </div>
      </div>

      {/* Advanced toggle filters */}
      <div className="flex flex-wrap gap-2 mb-6">
        <FilterToggle
          label="En stock"
          active={inStock}
          onChange={(v) => {
            setInStock(v);
            setPage(1);
          }}
        />
        <FilterToggle
          label="Non importés"
          active={notImported}
          onChange={(v) => {
            setNotImported(v);
            setPage(1);
          }}
        />
        <FilterToggle
          label="Avec rabais"
          active={withDiscount}
          onChange={(v) => {
            setWithDiscount(v);
            setPage(1);
          }}
        />
        <FilterToggle
          label="Stock faible (< 5)"
          active={lowStock}
          onChange={(v) => {
            setLowStock(v);
            setPage(1);
          }}
        />
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4 p-3 bg-blue-950/20 border border-blue-900/40 rounded-xl">
          <div className="flex items-center gap-3 text-sm text-blue-200">
            <span className="font-medium">{selected.size} sélectionné{selected.size > 1 ? "s" : ""}</span>
            <button onClick={selectAllOnPage} className="text-blue-400 hover:text-blue-300 underline-offset-2 hover:underline">
              Sélectionner la page
            </button>
            <button onClick={deselectAll} className="text-gray-400 hover:text-white underline-offset-2 hover:underline">
              Désélectionner tout
            </button>
          </div>
          {confirmingImport ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-300">Importer {selected.size} produit{selected.size > 1 ? "s" : ""} ?</span>
              <button
                onClick={sendToImport}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Confirmer
              </button>
              <button
                onClick={() => setConfirmingImport(false)}
                className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded-lg transition-colors"
              >
                Annuler
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmingImport(true)}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Importer la sélection ({selected.size})
            </button>
          )}
        </div>
      )}

      {/* Loading indicator for filter/page changes */}
      {loading && data && (
        <div className="flex items-center gap-2 mb-3 text-sm text-gray-400">
          <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          Loading...
        </div>
      )}

      {/* Product Table */}
      {loading && !data ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : error ? (
        <div className="p-6 bg-red-950/30 border border-red-800/50 rounded-xl text-red-300 text-sm">
          {error}
        </div>
      ) : data ? (
        <>
          {/* Mobile: card list */}
          <div className="md:hidden space-y-3">
            {data.products.map((product) => {
              const isSelected = selected.has(product.sku);
              return (
                <div
                  key={product.sku}
                  className={`bg-gray-900 border rounded-xl p-3 flex gap-3 ${
                    isSelected ? "border-blue-600/50 bg-blue-950/20" : "border-gray-800"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(product.sku)}
                    className="mt-1 rounded bg-gray-800 border-gray-700 text-blue-500 shrink-0"
                  />
                  {product.image1 ? (
                    <img
                      src={product.image1 as string}
                      alt=""
                      className="w-16 h-16 object-cover rounded bg-gray-800 shrink-0"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-16 h-16 rounded bg-gray-800 shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-white text-sm font-medium line-clamp-2">
                      {product.name as string}
                    </div>
                    <div className="text-gray-500 font-mono text-[11px] mt-1 truncate">
                      {product.sku as string}
                    </div>
                    <div className="flex items-center justify-between mt-2 gap-2">
                      <span className="text-white font-semibold text-sm">
                        ${(product.price as number)?.toFixed(2)}
                      </span>
                      <span
                        className={`text-xs ${
                          (product.qty as number) > 0 ? "text-green-400" : "text-red-400"
                        }`}
                      >
                        {product.qty as number} in stock
                      </span>
                    </div>
                    <div className="flex items-center justify-between mt-1 gap-2">
                      <span className="text-gray-400 text-[11px] truncate">
                        {product.product_type as string}
                      </span>
                      <StoreBadge product={product} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Desktop: table */}
          <div className="hidden md:block bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800 text-gray-400">
                    <th className="px-4 py-3 text-left w-10">
                      <input
                        type="checkbox"
                        onChange={toggleAllOnPage}
                        checked={
                          data.products.length > 0 &&
                          data.products.every((p) => selected.has(p.sku))
                        }
                        className="rounded bg-gray-800 border-gray-700 text-blue-500"
                      />
                    </th>
                    <th className="px-4 py-3 text-left w-16"></th>
                    <th className="px-4 py-3 text-left font-medium">
                      Product
                    </th>
                    <th className="px-4 py-3 text-left font-medium">SKU</th>
                    <th className="px-4 py-3 text-left font-medium">
                      Category
                    </th>
                    <th className="px-4 py-3 text-right font-medium">
                      Price
                    </th>
                    <th className="px-4 py-3 text-right font-medium">Qty</th>
                    <th className="px-4 py-3 text-left font-medium">Color</th>
                    <th className="px-4 py-3 text-left font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.products.map((product) => (
                    <tr
                      key={product.sku}
                      className={`border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors ${
                        selected.has(product.sku) ? "bg-blue-950/20" : ""
                      }`}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(product.sku)}
                          onChange={() => toggleSelect(product.sku)}
                          className="rounded bg-gray-800 border-gray-700 text-blue-500"
                        />
                      </td>
                      <td className="px-4 py-2">
                        {product.image1 ? (
                          <img
                            src={product.image1 as string}
                            alt=""
                            className="w-10 h-10 object-cover rounded bg-gray-800"
                            loading="lazy"
                          />
                        ) : (
                          <div className="w-10 h-10 rounded bg-gray-800" />
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-white text-sm font-medium line-clamp-2 max-w-xs">
                          {product.name as string}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-400 font-mono text-xs">
                        {product.sku as string}
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs max-w-[200px] truncate">
                        {product.product_type as string}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="text-white font-medium">
                          ${(product.price as number)?.toFixed(2)}
                        </span>
                        {product.prev_price != null && product.prev_price !== product.price && (
                          <div className={`text-xs mt-0.5 ${(product.price as number) < (product.prev_price as number) ? "text-green-400" : "text-red-400"}`}>
                            {(product.price as number) < (product.prev_price as number) ? "▼" : "▲"}{" "}
                            ${Math.abs((product.price as number) - (product.prev_price as number)).toFixed(2)}
                            {" "}({Math.abs(((product.price as number) - (product.prev_price as number)) / (product.prev_price as number) * 100).toFixed(1)}%)
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span
                          className={
                            (product.qty as number) > 0
                              ? "text-green-400"
                              : "text-red-400"
                          }
                        >
                          {product.qty as number}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-400 text-xs">
                        {product.color as string}
                      </td>
                      <td className="px-4 py-3">
                        <StoreBadge product={product} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pagination */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-4">
            <p className="text-sm text-gray-500 text-center sm:text-left">
              Page {data.pagination.page} of {data.pagination.pages}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="flex-1 sm:flex-none px-3 py-1.5 bg-gray-900 border border-gray-800 rounded-lg text-sm text-gray-400 hover:text-white disabled:opacity-40 transition-colors"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= (data?.pagination.pages || 1)}
                className="flex-1 sm:flex-none px-3 py-1.5 bg-gray-900 border border-gray-800 rounded-lg text-sm text-gray-400 hover:text-white disabled:opacity-40 transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "warn";
}) {
  return (
    <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${tone === "warn" ? "text-amber-400" : "text-white"}`}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-gray-600 mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

function FilterToggle({
  label,
  active,
  onChange,
}: {
  label: string;
  active: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className={`${TOGGLE_BASE} ${
        active
          ? "bg-blue-600/15 border-blue-600/50 text-blue-300"
          : "bg-gray-900 border-gray-800 text-gray-400 hover:text-white"
      }`}
    >
      <input
        type="checkbox"
        checked={active}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded bg-gray-800 border-gray-700 text-blue-500 focus:ring-blue-500"
      />
      {label}
    </label>
  );
}
