"use client";

import { useState, useEffect } from "react";

interface CollectionMapping {
  aosomCategory: string;
  shopifyCollectionId: string;
  shopifyCollectionTitle: string;
}

interface ShopifyCollection {
  id: string;
  title: string;
  handle: string;
}

interface CategoryCount {
  type: string;
  count: number;
}

export default function CollectionsPage() {
  const [mappings, setMappings] = useState<CollectionMapping[]>([]);
  const [collections, setCollections] = useState<ShopifyCollection[]>([]);
  const [categories, setCategories] = useState<CategoryCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<Record<string, unknown> | null>(null);
  const [filter, setFilter] = useState<"all" | "mapped" | "unmapped">("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    Promise.all([
      fetch("/api/collections/mappings").then(r => r.json()),
      fetch("/api/collections/shopify").then(r => r.json()),
      fetch("/api/catalog?limit=1").then(r => r.json()),
    ]).then(([mapData, colData, catData]) => {
      setMappings(mapData.data || []);
      setCollections(colData.data || []);
      // Get top-level categories from productTypes
      const types: CategoryCount[] = (catData.data?.productTypes || [])
        .filter((t: CategoryCount) => !t.type.includes(">"))
        .sort((a: CategoryCount, b: CategoryCount) => b.count - a.count);
      setCategories(types);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const mappingMap = new Map(mappings.map(m => [m.aosomCategory, m]));

  function updateMapping(category: string, collectionId: string) {
    const col = collections.find(c => c.id === collectionId);
    if (!col) return;
    setMappings(prev => {
      const existing = prev.find(m => m.aosomCategory === category);
      if (existing) {
        return prev.map(m => m.aosomCategory === category
          ? { ...m, shopifyCollectionId: collectionId, shopifyCollectionTitle: col.title }
          : m
        );
      }
      return [...prev, { aosomCategory: category, shopifyCollectionId: collectionId, shopifyCollectionTitle: col.title }];
    });
  }

  function removeMapping(category: string) {
    setMappings(prev => prev.filter(m => m.aosomCategory !== category));
  }

  async function saveMappings() {
    setSaving(true);
    try {
      const res = await fetch("/api/collections/mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mappings }),
      });
      const data = await res.json();
      if (data.success) alert(`${data.saved} mappings saved`);
    } catch {
      alert("Failed to save");
    }
    setSaving(false);
  }

  async function syncCollections() {
    if (!confirm("This will add existing Shopify products to their mapped collections. Continue?")) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/collections/sync", { method: "POST" });
      const data = await res.json();
      setSyncResult(data.data);
    } catch {
      alert("Sync failed");
    }
    setSyncing(false);
  }

  const filtered = categories.filter(c => {
    if (search && !c.type.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === "mapped") return mappingMap.has(c.type);
    if (filter === "unmapped") return !mappingMap.has(c.type);
    return true;
  });

  const mappedCount = categories.filter(c => mappingMap.has(c.type)).length;

  return (
    <div className="p-8 max-w-5xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Collection Mapping</h2>
          <p className="text-gray-400 text-sm mt-0.5">
            Map Aosom categories to Shopify collections ({mappedCount}/{categories.length} mapped)
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={syncCollections}
            disabled={syncing}
            className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {syncing ? "Syncing..." : "Sync Collections"}
          </button>
          <button
            onClick={saveMappings}
            disabled={saving}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {saving ? "Saving..." : "Save Mapping"}
          </button>
        </div>
      </div>

      {/* Sync result */}
      {syncResult && (
        <div className="mb-4 p-4 bg-gray-900 border border-gray-800 rounded-xl text-sm">
          <p className="text-white font-medium mb-2">Sync Complete</p>
          <div className="grid grid-cols-5 gap-2 text-center">
            <div><p className="text-gray-500">Total</p><p className="text-white font-bold">{syncResult.total as number}</p></div>
            <div><p className="text-gray-500">Added</p><p className="text-green-400 font-bold">{syncResult.added as number}</p></div>
            <div><p className="text-gray-500">Already in</p><p className="text-gray-400 font-bold">{syncResult.skipped as number}</p></div>
            <div><p className="text-gray-500">No mapping</p><p className="text-yellow-400 font-bold">{syncResult.noMapping as number}</p></div>
            <div><p className="text-gray-500">Errors</p><p className="text-red-400 font-bold">{syncResult.errors as number}</p></div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-3 mb-4">
        <input
          type="text"
          placeholder="Search categories..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <select
          value={filter}
          onChange={e => setFilter(e.target.value as "all" | "mapped" | "unmapped")}
          className="px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          <option value="all">All ({categories.length})</option>
          <option value="mapped">Mapped ({mappedCount})</option>
          <option value="unmapped">Unmapped ({categories.length - mappedCount})</option>
        </select>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-400">
                <th className="px-4 py-3 text-left font-medium">Aosom Category</th>
                <th className="px-4 py-3 text-right font-medium w-20">Products</th>
                <th className="px-4 py-3 text-left font-medium w-72">Shopify Collection</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(cat => {
                const mapping = mappingMap.get(cat.type);
                return (
                  <tr
                    key={cat.type}
                    className={`border-b border-gray-800/50 ${!mapping ? "bg-yellow-950/10" : ""}`}
                  >
                    <td className="px-4 py-2.5 text-white text-sm">{cat.type}</td>
                    <td className="px-4 py-2.5 text-right text-gray-400">{cat.count.toLocaleString()}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex gap-2">
                        <select
                          value={mapping?.shopifyCollectionId || ""}
                          onChange={e => {
                            if (e.target.value === "") removeMapping(cat.type);
                            else updateMapping(cat.type, e.target.value);
                          }}
                          className={`flex-1 px-2 py-1.5 bg-gray-800 border rounded text-sm text-white focus:outline-none focus:ring-1 focus:ring-blue-500 ${
                            mapping ? "border-green-800/50" : "border-yellow-800/50"
                          }`}
                        >
                          <option value="">-- No collection --</option>
                          {collections.map(c => (
                            <option key={c.id} value={c.id}>{c.title}</option>
                          ))}
                        </select>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
