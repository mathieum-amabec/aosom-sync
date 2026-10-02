"use client";

import { useState, useEffect, useCallback, useMemo } from "react";

/**
 * "Ciblage précis" — generate highlights for hand-picked Aosom sub-categories, and save
 * such a selection as a reusable theme (e.g. "Extérieur automne" = fire pits + car
 * shelters + sheds + heaters). One theme can be the daily cron's preference instead of
 * the seasonal default.
 *
 * Only decides WHICH products drafts are generated for. Drafts still land in the list
 * below for review; nothing here approves or schedules.
 */

interface TargetNode {
  path: string;
  name: string;
  depth: number;
  fiches: number;
  verified: number | null;
  postable: number | null;
}

interface Theme {
  id: string;
  label: string;
  productTypes: string[];
}

interface TargetsData {
  nodes: TargetNode[];
  verifiedKnown: boolean;
  cooldownDays: number;
  themes: Theme[];
  autoThemeId: string;
}

export type TargetSelection = { themeId: string } | { productTypes: string[] };

interface Props {
  generating: boolean;
  onGenerate: (selection: TargetSelection) => void;
  onError: (text: string) => void;
  onOk: (text: string) => void;
}

/** True when `path` is `ancestor` or sits under it. */
function isUnder(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor} > `);
}

/** Drop selected paths already covered by a selected ancestor (their counts would double). */
function topmost(paths: string[]): string[] {
  return paths.filter((p) => !paths.some((q) => q !== p && isUnder(p, q)));
}

export function TargetingPanel({ generating, onGenerate, onError, onOk }: Props) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<TargetsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [themeName, setThemeName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Load once per page visit; a failed load is retried by reopening, never in a loop.
  const [attempted, setAttempted] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/social/targets");
      const json = await res.json();
      if (json.success) setData(json.data);
      else onError(json.error || "Chargement des sous-catégories impossible");
    } catch {
      onError("Chargement des sous-catégories impossible (réseau)");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    if (open && !attempted) {
      setAttempted(true);
      load();
    }
  }, [open, attempted, load]);

  const byPath = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.path, n])), [data]);

  /** Postable fiches for a set of branches (siblings are disjoint; nested ones deduped). */
  const postableFor = useCallback(
    (paths: string[]): number | null => {
      if (!data?.verifiedKnown) return null;
      return topmost(paths).reduce((sum, p) => sum + (byPath.get(p)?.postable ?? 0), 0);
    },
    [data, byPath],
  );

  const visible = useMemo(() => {
    const nodes = data?.nodes ?? [];
    const q = search.trim().toLowerCase();
    if (q) return nodes.filter((n) => n.path.toLowerCase().includes(q));
    // Tree mode: a node shows when every ancestor is expanded.
    return nodes.filter((n) => {
      const segs = n.path.split(" > ");
      for (let i = 1; i < segs.length; i++) {
        if (!expanded.has(segs.slice(0, i).join(" > "))) return false;
      }
      return true;
    });
  }, [data, search, expanded]);

  function toggleSelect(path: string) {
    const next = new Set(selected);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setSelected(next);
  }

  function toggleExpand(path: string) {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setExpanded(next);
  }

  async function post(body: Record<string, unknown>): Promise<boolean> {
    setSaving(true);
    try {
      const res = await fetch("/api/social/targets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!json.success) {
        onError(json.error || "Enregistrement impossible");
        return false;
      }
      await load();
      return true;
    } catch {
      onError("Enregistrement impossible (réseau)");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveTheme() {
    const productTypes = topmost([...selected]);
    const ok = await post({ action: "save", id: editingId ?? undefined, label: themeName, productTypes });
    if (ok) {
      onOk(editingId ? `Thème « ${themeName.trim()} » mis à jour.` : `Thème « ${themeName.trim()} » enregistré.`);
      setEditingId(null);
      setThemeName("");
    }
  }

  function editTheme(t: Theme) {
    setEditingId(t.id);
    setThemeName(t.label);
    setSelected(new Set(t.productTypes));
    setSearch("");
    // Reveal every selected branch in the tree.
    const exp = new Set(expanded);
    for (const p of t.productTypes) {
      const segs = p.split(" > ");
      for (let i = 1; i < segs.length; i++) exp.add(segs.slice(0, i).join(" > "));
    }
    setExpanded(exp);
  }

  async function deleteTheme(t: Theme) {
    if (!window.confirm(`Supprimer le thème « ${t.label} » ?`)) return;
    if (await post({ action: "delete", id: t.id })) {
      if (editingId === t.id) {
        setEditingId(null);
        setThemeName("");
      }
    }
  }

  async function setAuto(id: string) {
    if (await post({ action: "set-auto", id })) {
      const t = data?.themes.find((x) => x.id === id);
      onOk(
        t
          ? `Génération quotidienne : priorité au thème « ${t.label} » (repli sur tout le catalogue s'il est épuisé).`
          : "Génération quotidienne : retour à la saison automatique.",
      );
    }
  }

  const selectedList = topmost([...selected]);
  const selectedPostable = postableFor(selectedList);
  const fmt = (n: number | null) => (n === null ? "?" : String(n));

  return (
    <div className="mb-6 bg-gray-900 border border-gray-800 rounded-lg">
      <button
        onClick={() => {
          if (open && !data) setAttempted(false);
          setOpen(!open);
        }}
        className="w-full flex items-center justify-between px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="text-white text-sm font-semibold">🎯 Ciblage précis — sous-catégories et thèmes</span>
        <span className="text-gray-500 text-xs">{open ? "Masquer" : "Afficher"}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4">
          {loading && !data && <p className="text-gray-400 text-sm">Chargement…</p>}

          {data && (
            <>
              <p className="text-gray-400 text-xs">
                « Publiables » = fiches en stock avec une photo lifestyle validée et sans post depuis{" "}
                {data.cooldownDays} jours. Une fiche sans photo validée n&apos;est jamais publiée.
                {!data.verifiedKnown && " Shopify ne répond pas : les compteurs de photos sont indisponibles."}
              </p>

              {/* Saved themes */}
              <div>
                <h3 className="text-gray-300 text-xs font-semibold uppercase tracking-wide mb-2">Mes thèmes</h3>
                {data.themes.length === 0 ? (
                  <p className="text-gray-500 text-sm">
                    Aucun thème. Cochez des sous-catégories ci-dessous puis « Enregistrer comme thème ».
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {data.themes.map((t) => {
                      const n = postableFor(t.productTypes);
                      const isAuto = data.autoThemeId === t.id;
                      return (
                        <li
                          key={t.id}
                          className="flex flex-col sm:flex-row sm:items-center gap-2 bg-gray-950 border border-gray-800 rounded-lg px-3 py-2"
                        >
                          <div className="flex-1 min-w-0">
                            <span className="text-white text-sm">{t.label}</span>
                            <span className={`ml-2 text-xs ${n === 0 ? "text-red-400" : "text-gray-400"}`}>
                              {fmt(n)} publiable(s) · {t.productTypes.length} sous-catégorie(s)
                            </span>
                            {isAuto && (
                              <span className="ml-2 text-xs text-blue-300 bg-blue-900/40 border border-blue-800/50 rounded px-1.5 py-0.5">
                                quotidien
                              </span>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <button
                              onClick={() => onGenerate({ themeId: t.id })}
                              disabled={generating || n === 0}
                              className="px-3 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-500 disabled:opacity-50"
                            >
                              Générer 3 brouillons
                            </button>
                            <button
                              onClick={() => setAuto(isAuto ? "" : t.id)}
                              disabled={saving}
                              className="px-3 py-1 bg-gray-800 text-gray-200 text-xs rounded hover:bg-gray-700 disabled:opacity-50"
                              title="La génération automatique quotidienne privilégie ce thème au lieu de la saison"
                            >
                              {isAuto ? "Retirer du quotidien" : "Utiliser au quotidien"}
                            </button>
                            <button
                              onClick={() => editTheme(t)}
                              className="px-3 py-1 bg-gray-800 text-gray-200 text-xs rounded hover:bg-gray-700"
                            >
                              Modifier
                            </button>
                            <button
                              onClick={() => deleteTheme(t)}
                              disabled={saving}
                              className="px-3 py-1 bg-gray-800 text-red-300 text-xs rounded hover:bg-gray-700 disabled:opacity-50"
                            >
                              Supprimer
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {/* Sub-category picker */}
              <div>
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-2">
                  <h3 className="text-gray-300 text-xs font-semibold uppercase tracking-wide flex-1">
                    Sous-catégories {editingId && <span className="text-blue-300 normal-case">— modification de « {themeName} »</span>}
                  </h3>
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Rechercher (ex. Fire, Shed, Heater)…"
                    className="w-full sm:w-64 px-3 py-1.5 bg-gray-950 border border-gray-800 text-white text-sm rounded"
                  />
                </div>
                <div className="max-h-80 overflow-y-auto bg-gray-950 border border-gray-800 rounded p-2">
                  {visible.length === 0 && <p className="text-gray-500 text-sm px-1">Aucune sous-catégorie.</p>}
                  {visible.map((n) => {
                    const hasChildren = (data.nodes ?? []).some((m) => m.depth === n.depth + 1 && isUnder(m.path, n.path));
                    const coveredByAncestor = [...selected].some((s) => s !== n.path && isUnder(n.path, s));
                    return (
                      <div
                        key={n.path}
                        className="flex items-center gap-2 py-0.5"
                        style={{ paddingLeft: search ? 0 : n.depth * 16 }}
                      >
                        {!search && (
                          <button
                            onClick={() => hasChildren && toggleExpand(n.path)}
                            className={`w-4 text-gray-500 text-xs ${hasChildren ? "" : "invisible"}`}
                            aria-label={expanded.has(n.path) ? "Replier" : "Déplier"}
                          >
                            {expanded.has(n.path) ? "▾" : "▸"}
                          </button>
                        )}
                        <label className="flex items-center gap-2 cursor-pointer min-w-0">
                          <input
                            type="checkbox"
                            checked={selected.has(n.path) || coveredByAncestor}
                            disabled={coveredByAncestor}
                            onChange={() => toggleSelect(n.path)}
                          />
                          <span className="text-gray-200 text-sm truncate">{search ? n.path : n.name}</span>
                          <span className={`text-xs whitespace-nowrap ${n.postable === 0 ? "text-red-400" : "text-gray-500"}`}>
                            {fmt(n.postable)} publiable(s) / {n.fiches} fiche(s)
                          </span>
                        </label>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Selection actions */}
              <div className="flex flex-col gap-2">
                <p className="text-gray-400 text-sm">
                  {selectedList.length === 0
                    ? "Aucune sous-catégorie cochée."
                    : `${selectedList.length} sous-catégorie(s) cochée(s) — ${fmt(selectedPostable)} fiche(s) publiable(s).`}
                </p>
                <div className="flex flex-col sm:flex-row gap-2">
                  <button
                    onClick={() => onGenerate({ productTypes: selectedList })}
                    disabled={generating || selectedList.length === 0 || selectedPostable === 0}
                    className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-500 disabled:opacity-50"
                  >
                    {generating ? "Génération…" : "Générer 3 brouillons avec cette sélection"}
                  </button>
                  <input
                    value={themeName}
                    onChange={(e) => setThemeName(e.target.value)}
                    placeholder="Nom du thème (ex. Extérieur automne)"
                    maxLength={60}
                    className="flex-1 px-3 py-2 bg-gray-950 border border-gray-800 text-white text-sm rounded-lg"
                  />
                  <button
                    onClick={saveTheme}
                    disabled={saving || selectedList.length === 0 || !themeName.trim()}
                    className="px-4 py-2 bg-gray-800 text-white text-sm rounded-lg hover:bg-gray-700 disabled:opacity-50"
                  >
                    {editingId ? "Mettre à jour le thème" : "Enregistrer comme thème"}
                  </button>
                  {(editingId || selected.size > 0) && (
                    <button
                      onClick={() => {
                        setEditingId(null);
                        setThemeName("");
                        setSelected(new Set());
                      }}
                      className="px-4 py-2 text-gray-400 text-sm rounded-lg hover:text-white"
                    >
                      Effacer
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
