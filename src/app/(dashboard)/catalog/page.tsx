"use client";

import { useState, useEffect, useCallback } from "react";
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
  [key: string]: unknown;
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

export default function CatalogPage() {
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState("");
  const [productType, setProductType] = useState("");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [inStock, setInStock] = useState(false);
  const [sort, setSort] = useState("");
  const [page, setPage] = useState(1);

  // Selection for import
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const fetchCatalog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (search) params.set("search", search);
      if (productType) params.set("productType", productType);
      if (minPrice) params.set("minPrice", minPrice);
      if (maxPrice) params.set("maxPrice", maxPrice);
      if (inStock) params.set("inStock", "true");
      if (sort) params.set("sort", sort);

      const res = await fetch(`/api/catalog?${params}`);
      if (!res.ok) throw new Error("Failed to fetch catalog");
      const json = await res.json();
      setData(json.data || json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
    setLoading(false);
  }, [search, productType, minPrice, maxPrice, inStock, sort, page]);

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  // Debounced search
  const [searchInput, setSearchInput] = useState("");
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

  function selectAll() {
    if (!data) return;
    const allSkus = data.products.map((p) => p.sku);
    const allSelected = allSkus.every((s) => selected.has(s));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const sku of allSkus) {
        if (allSelected) next.delete(sku);
        else next.add(sku);
      }
      return next;
    });
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
        window.location.href = "/import";
      }
    } catch {
      alert("Failed to queue products");
    }
  }

  return (
    <div className="p-4 md:p-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
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
        {selected.size > 0 && (
          <button
            onClick={sendToImport}
            className="w-full sm:w-auto px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Import {selected.size} selected
          </button>
        )}
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 md:grid-cols-6 gap-3 mb-6">
        <div className="md:col-span-2">
          <input
            type="text"
            placeholder="Search products..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div>
          <select
            value={productType}
            onChange={(e) => {
              setProductType(e.target.value);
              setPage(1);
            }}
            className="w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
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
            className="w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="">Sort by name</option>
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
            className="w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <input
            type="number"
            placeholder="Max $"
            value={maxPrice}
            onChange={(e) => {
              setMaxPrice(e.target.value);
              setPage(1);
            }}
            className="w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <div className="flex items-center">
          <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={inStock}
              onChange={(e) => {
                setInStock(e.target.checked);
                setPage(1);
              }}
              className="rounded bg-gray-800 border-gray-700 text-blue-500 focus:ring-blue-500"
            />
            In stock only
          </label>
        </div>
      </div>

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
                      {product.import_status ? (
                        <span className="px-1.5 py-0.5 bg-green-900/40 text-green-400 border border-green-800/50 rounded text-[10px] font-medium shrink-0">
                          {product.import_status as string}
                        </span>
                      ) : null}
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
                        onChange={selectAll}
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
                        {product.import_status ? (
                          <span className="px-2 py-0.5 bg-green-900/40 text-green-400 border border-green-800/50 rounded-md text-xs font-medium">
                            {product.import_status as string}
                          </span>
                        ) : null}
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
