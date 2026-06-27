"use client";

// Slideshow generation hub — moved here from settings/SlideshowSettingsTab.tsx.
// Lives under the /videos "Générer" tab (engine = "Slideshow"). Settings keeps
// only the passive config (template toggles, default ratio/platform).
//
// 5 selection modes → drive the product-preview grid and set the matching
// template (the single source of truth). Full video params, a product dry-run, a
// manifest dry-run, and a Generate button gated on the dry-run.

import { useEffect, useState, useCallback } from "react";
import type {
  SlideshowTemplateKey,
  VideoRatio,
  VideoPlatform,
} from "@/lib/config";
import {
  SLIDESHOW_TEMPLATE_KEYS,
  SLIDESHOW_TEMPLATE_LABELS,
  VIDEO_RATIOS,
  VIDEO_PLATFORMS,
} from "@/lib/config";
import type { ProductItem } from "@/lib/selectors/types";

const RATIO_LABELS: Record<VideoRatio, string> = {
  "9:16": "📱 9:16",
  "1:1": "⬛ 1:1",
  "16:9": "🖥️ 16:9",
};
const PLATFORM_LABELS: Record<VideoPlatform, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  both: "Les deux",
};

type Brand = "ameublo" | "furnish";

/** Product-selection mode (drives the product preview grid + sets the template). */
type SelectMode = "manual" | "best_sellers" | "by_category" | "price_drops" | "seasonal";

const MODE_TABS: { key: SelectMode; label: string; template: SlideshowTemplateKey }[] = [
  { key: "manual", label: "📦 SKU manuel", template: "SHOWCASE" },
  { key: "best_sellers", label: "🏆 Best sellers", template: "BEST_SELLERS" },
  { key: "by_category", label: "📂 Par catégorie", template: "LOOKBOOK" },
  { key: "price_drops", label: "📉 Price drops", template: "PRICE_DROP" },
  { key: "seasonal", label: "🌿 Saisonnalité", template: "COUNTDOWN" },
];

/** Template → product-preview mode (null = no grid preview for this template). */
const TEMPLATE_PREVIEW_MODE: Record<SlideshowTemplateKey, SelectMode | "low_stock" | null> = {
  SHOWCASE: "manual",
  BEST_SELLERS: "best_sellers",
  LOOKBOOK: "by_category",
  PRICE_DROP: "price_drops",
  COUNTDOWN: "seasonal",
  URGENCY: "low_stock",
  DISCOVERY: null,
  REMIX: null,
};

const THEME_BUTTONS: { key: string; label: string }[] = [
  { key: "ete", label: "☀️ Été" },
  { key: "rentree", label: "🎒 Rentrée" },
  { key: "fete-peres", label: "👨 Fête des pères" },
  { key: "hiver", label: "❄️ Hiver" },
  { key: "maison", label: "🏠 Maison" },
];

const LIMIT_CHOICES = ["5", "10", "20"];
const MINPCT_CHOICES = ["10", "15", "20", "25"];
const DURATION_CHOICES = ["6", "15", "30"];

/** Full manual-generation form. `template` is the single source of truth; the
 * mode tabs and the contextual inputs are derived from TEMPLATE_PREVIEW_MODE. */
type GenForm = {
  template: SlideshowTemplateKey;
  brand: Brand;
  ratio: VideoRatio;
  durationSec: string; // "" = auto pacing
  platform: VideoPlatform;
  limit: string;
  sku: string;
  category: string;
  sort: string;
  minPct: string;
  threshold: string;
  strategy: string;
  theme: string;
};

const DEFAULT_FORM: GenForm = {
  template: "BEST_SELLERS",
  brand: "ameublo",
  ratio: "9:16",
  durationSec: "",
  platform: "both",
  limit: "10",
  sku: "",
  category: "",
  sort: "velocity",
  minPct: "10",
  threshold: "5",
  strategy: "margin",
  theme: "ete",
};

/** Build the opts object for /api/slideshow/* from the form (only the fields the template uses). */
function formToOpts(f: GenForm): Record<string, unknown> {
  const opts: Record<string, unknown> = { brand: f.brand, ratio: f.ratio };
  if (f.limit.trim()) opts.limit = Number(f.limit);
  if (f.durationSec.trim()) opts.durationSec = Number(f.durationSec);
  switch (f.template) {
    case "SHOWCASE":
      if (f.sku.trim()) opts.sku = f.sku.split(",")[0].trim();
      break;
    case "PRICE_DROP":
      if (f.minPct.trim()) opts.minPct = Number(f.minPct);
      break;
    case "URGENCY":
      if (f.threshold.trim()) opts.threshold = Number(f.threshold);
      break;
    case "LOOKBOOK":
      if (f.category.trim()) opts.category = f.category.trim();
      opts.sort = f.sort;
      break;
    case "DISCOVERY":
      opts.strategy = f.strategy;
      break;
    case "COUNTDOWN":
      if (f.theme.trim()) opts.theme = f.theme.trim();
      break;
  }
  return opts;
}

/** Query string for /api/slideshow/products-preview from the current form. */
function productsPreviewQuery(f: GenForm): string | null {
  const mode = TEMPLATE_PREVIEW_MODE[f.template];
  if (!mode) return null;
  const p = new URLSearchParams({ mode, language: f.brand === "furnish" ? "en" : "fr" });
  if (f.limit.trim()) p.set("limit", f.limit);
  if (mode === "by_category") {
    if (!f.category.trim()) return null;
    p.set("category", f.category.trim());
  }
  if (mode === "seasonal") p.set("theme", f.theme.trim());
  if (mode === "manual") {
    if (!f.sku.trim()) return null;
    p.set("skus", f.sku.trim());
  }
  return p.toString();
}

export default function SlideshowGenerator() {
  const [form, setForm] = useState<GenForm>(DEFAULT_FORM);
  const [running, setRunning] = useState<null | "products" | "preview" | "generate">(null);
  const [products, setProducts] = useState<ProductItem[] | null>(null);
  const [manifest, setManifest] = useState<SlideshowManifest | null>(null);
  const [previewDone, setPreviewDone] = useState(false);
  const [genResult, setGenResult] = useState<{ ok: boolean; text: string; scheduledAt?: string; blobUrl?: string } | null>(null);
  const [categories, setCategories] = useState<string[]>([]);

  /** Any param change invalidates the dry-run gate + stale outputs. */
  const patch = useCallback((p: Partial<GenForm>) => {
    setForm((prev) => ({ ...prev, ...p }));
    setPreviewDone(false);
    setManifest(null);
    setGenResult(null);
  }, []);

  /** Pick a selection mode → sets the matching template (the source of truth). */
  const pickTemplate = useCallback(
    (template: SlideshowTemplateKey) => {
      patch({ template });
      setProducts(null);
    },
    [patch],
  );

  // Seed ratio/platform defaults from the saved slideshow settings.
  useEffect(() => {
    fetch("/api/settings/schedule")
      .then((r) => r.json())
      .then((d) => {
        const s = d?.data?.slideshow_settings;
        if (s) setForm((prev) => ({ ...prev, ratio: s.default_ratio ?? prev.ratio, platform: s.platform ?? prev.platform }));
      })
      .catch(() => {/* keep defaults */});
  }, []);

  // Load categories once (for the by_category dropdown).
  useEffect(() => {
    fetch("/api/products/categories")
      .then((r) => r.json())
      .then((d) => {
        if (d.success && Array.isArray(d.categories)) setCategories(d.categories);
      })
      .catch(() => {/* dropdown falls back to a free-text field */});
  }, []);

  async function runProductsPreview() {
    const query = productsPreviewQuery(form);
    if (!query) {
      setProducts(null);
      setGenResult({ ok: false, text: "Aperçu produits indisponible pour ce mode (paramètre manquant ou template sans sélection)." });
      return;
    }
    setRunning("products");
    setProducts(null);
    try {
      const res = await fetch(`/api/slideshow/products-preview?${query}`);
      const d = await res.json();
      if (res.ok) setProducts(d.products ?? []);
      else setGenResult({ ok: false, text: d.error || "Erreur de l’aperçu produits." });
    } catch (err) {
      setGenResult({ ok: false, text: String(err) });
    } finally {
      setRunning(null);
    }
  }

  async function runManifestPreview() {
    setRunning("preview");
    setManifest(null);
    try {
      const opts = formToOpts(form);
      const params = new URLSearchParams({ template: form.template });
      for (const [k, v] of Object.entries(opts)) params.set(k, String(v));
      const res = await fetch(`/api/slideshow/preview?${params.toString()}`);
      const d = await res.json();
      if (res.ok && d.manifest) {
        setManifest(d.manifest as SlideshowManifest);
        setPreviewDone(true);
        setGenResult(null);
      } else {
        setPreviewDone(false);
        setGenResult({ ok: false, text: d.error || "Erreur de l’aperçu vidéo." });
      }
    } catch (err) {
      setPreviewDone(false);
      setGenResult({ ok: false, text: String(err) });
    } finally {
      setRunning(null);
    }
  }

  async function runGenerate() {
    setRunning("generate");
    setGenResult(null);
    try {
      const res = await fetch("/api/slideshow/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template: form.template,
          opts: formToOpts(form),
          platform: form.platform,
          dryRun: false,
          enqueue: true,
        }),
      });
      const d = await res.json();
      if (res.ok && d.success) {
        setGenResult({
          ok: true,
          text: d.scheduledAt ? `✅ Vidéo planifiée le ${d.scheduledAt}` : "✅ Vidéo générée.",
          scheduledAt: d.scheduledAt,
          blobUrl: d.blobUrl,
        });
      } else {
        setGenResult({ ok: false, text: d.error || "Erreur de génération.", blobUrl: d.blobUrl });
      }
    } catch (err) {
      setGenResult({ ok: false, text: String(err) });
    } finally {
      setRunning(null);
    }
  }

  const previewMode = TEMPLATE_PREVIEW_MODE[form.template];
  const busy = running !== null;

  return (
    <div className="max-w-3xl">
      <p className="text-xs text-gray-500 mb-4">
        Choisis un mode de sélection, prévisualise les produits et la vidéo (dry-run), puis génère
        le MP4 et mets-le en file de publication (Reel).
      </p>

      {/* A. Mode de sélection de produits */}
      <label className="block text-sm text-gray-400 mb-2">Mode de sélection</label>
      <div className="flex flex-wrap gap-2 mb-4">
        {MODE_TABS.map((t) => {
          const active = previewMode === t.key;
          return (
            <button
              key={t.key}
              type="button"
              aria-pressed={active}
              onClick={() => pickTemplate(t.template)}
              className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                active
                  ? "bg-blue-600 border-blue-500 text-white"
                  : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* B. Paramètres contextuels (dérivés du template = source de vérité) */}
      <div className="mb-4">
        {previewMode === "manual" && (
          <Field label="SKU(s) — séparés par des virgules (la vidéo Showcase utilise le 1er)">
            <input
              value={form.sku}
              onChange={(e) => patch({ sku: e.target.value })}
              placeholder="824-051V80BK, 84G-720V00GY"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 font-mono"
            />
          </Field>
        )}
        {previewMode === "by_category" && (
          <Field label="Catégorie">
            {categories.length > 0 ? (
              <select
                value={form.category}
                onChange={(e) => patch({ category: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
              >
                <option value="">— Choisir une catégorie —</option>
                {categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            ) : (
              <input
                value={form.category}
                onChange={(e) => patch({ category: e.target.value })}
                placeholder="Office Furniture"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
              />
            )}
          </Field>
        )}
        {previewMode === "price_drops" && (
          <Field label="Rabais minimum">
            <Segmented
              choices={MINPCT_CHOICES.map((v) => ({ value: v, label: `${v}%` }))}
              value={form.minPct}
              onSelect={(v) => patch({ minPct: v })}
            />
          </Field>
        )}
        {previewMode === "low_stock" && (
          <Field label="Seuil de stock (urgence)">
            <input
              type="number"
              min={1}
              value={form.threshold}
              placeholder="5"
              onChange={(e) => patch({ threshold: e.target.value })}
              className="w-full sm:w-40 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
            />
          </Field>
        )}
        {previewMode === "seasonal" && (
          <Field label="Thème saisonnier">
            <div className="flex flex-wrap gap-2">
              {THEME_BUTTONS.map((t) => {
                const active = form.theme === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => patch({ theme: t.key })}
                    className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                      active ? "bg-blue-600 border-blue-500 text-white" : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600"
                    }`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>
          </Field>
        )}
        {previewMode !== "manual" && (
          <div className="mt-3">
            <Field label="Nombre de produits">
              <Segmented
                choices={LIMIT_CHOICES.map((v) => ({ value: v, label: v }))}
                value={form.limit}
                onSelect={(v) => patch({ limit: v })}
              />
            </Field>
          </div>
        )}
      </div>

      {/* C. Paramètres vidéo (toujours visibles) */}
      <div className="border-t border-gray-800 pt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Template (style vidéo)">
          <select
            value={form.template}
            onChange={(e) => patch({ template: e.target.value as SlideshowTemplateKey })}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
          >
            {SLIDESHOW_TEMPLATE_KEYS.filter((k) => k !== "REMIX").map((k) => (
              <option key={k} value={k}>{SLIDESHOW_TEMPLATE_LABELS[k]}</option>
            ))}
          </select>
        </Field>
        <Field label="Ratio">
          <Segmented
            choices={VIDEO_RATIOS.map((r) => ({ value: r, label: RATIO_LABELS[r] }))}
            value={form.ratio}
            onSelect={(v) => patch({ ratio: v as VideoRatio })}
          />
        </Field>
        <Field label="Durée">
          <Segmented
            choices={[{ value: "", label: "Auto" }, ...DURATION_CHOICES.map((v) => ({ value: v, label: `${v}s` }))]}
            value={form.durationSec}
            onSelect={(v) => patch({ durationSec: v })}
          />
        </Field>
        <Field label="Plateforme">
          <Segmented
            choices={VIDEO_PLATFORMS.map((p) => ({ value: p, label: PLATFORM_LABELS[p] }))}
            value={form.platform}
            onSelect={(v) => patch({ platform: v as VideoPlatform })}
          />
        </Field>
        <Field label="Langue (suit la marque)">
          <Segmented
            choices={[{ value: "ameublo", label: "FR" }, { value: "furnish", label: "EN" }]}
            value={form.brand}
            onSelect={(v) => patch({ brand: v as Brand })}
          />
        </Field>
        {form.template === "DISCOVERY" && (
          <Field label="Stratégie (Découverte)">
            <select
              value={form.strategy}
              onChange={(e) => patch({ strategy: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
            >
              <option value="margin">Marge / rabais</option>
              <option value="new">Nouveautés</option>
              <option value="random">Aléatoire</option>
            </select>
          </Field>
        )}
        {form.template === "LOOKBOOK" && (
          <Field label="Tri (Lookbook)">
            <select
              value={form.sort}
              onChange={(e) => patch({ sort: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
            >
              <option value="velocity">Ventes</option>
              <option value="price_asc">Prix ↑</option>
              <option value="price_desc">Prix ↓</option>
              <option value="discount">Rabais</option>
            </select>
          </Field>
        )}
      </div>

      {/* D/E. Boutons d'aperçu + génération */}
      <div className="flex flex-wrap items-center gap-3 mt-5">
        <button
          onClick={runProductsPreview}
          disabled={busy || previewMode === null}
          title={previewMode === null ? "Aperçu produits indisponible pour ce template" : undefined}
          className="px-4 py-2 bg-gray-700 text-white text-sm rounded-lg hover:bg-gray-600 disabled:opacity-50"
        >
          {running === "products" ? "Chargement…" : "Voir les produits sélectionnés"}
        </button>
        <button
          onClick={runManifestPreview}
          disabled={busy}
          className="px-4 py-2 bg-gray-700 text-white text-sm rounded-lg hover:bg-gray-600 disabled:opacity-50"
        >
          {running === "preview" ? "Aperçu…" : "Aperçu vidéo (dry-run)"}
        </button>
        <button
          onClick={runGenerate}
          disabled={busy || !previewDone}
          title={!previewDone ? "Fais d’abord l’aperçu vidéo (dry-run)" : undefined}
          className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-500 disabled:opacity-50"
        >
          {running === "generate" ? "Génération en cours…" : "🎬 Générer & mettre en file"}
        </button>
        {!previewDone && <span className="text-xs text-gray-500">Aperçu dry-run requis avant génération</span>}
      </div>

      {/* D. Grille produits sélectionnés */}
      {products && (
        <div className="mt-5">
          <p className="text-sm text-gray-400 mb-2">{products.length} produit{products.length > 1 ? "s" : ""} sélectionné{products.length > 1 ? "s" : ""}</p>
          {products.length === 0 ? (
            <p className="text-xs text-gray-500">Aucun produit ne correspond à ce mode.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {products.slice(0, 20).map((p) => (
                <ProductCard key={p.sku} p={p} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* E. Manifest dry-run formaté */}
      {manifest && (
        <div className="mt-5 rounded-lg border border-gray-700 bg-gray-950 p-4">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-gray-300">
            <span><span className="text-gray-500">Slides:</span> {manifest.items.length}</span>
            <span><span className="text-gray-500">Durée estimée:</span> {manifest.estimatedDurationSec}s</span>
            <span><span className="text-gray-500">Ratio:</span> <span className="font-mono">{manifest.ratio}</span></span>
            <span><span className="text-gray-500">Template:</span> {manifest.template}</span>
          </div>
          <ol className="mt-3 space-y-1 text-xs text-gray-400 list-decimal list-inside">
            {manifest.items.map((it, i) => (
              <li key={i}>
                {it.overlay_text}
                {it.showsBadge && it.discountPct ? <span className="text-amber-400"> · -{it.discountPct}%</span> : null}
              </li>
            ))}
          </ol>
          <p className="mt-3 text-xs text-gray-600 break-all">
            <span className="text-gray-500">Upload prévu:</span> <span className="font-mono">{manifest.wouldUploadTo}</span>
          </p>
          <p className="mt-1 text-xs text-amber-400/80">Aucune vidéo générée — aperçu seulement.</p>
        </div>
      )}

      {/* F. Résultat de génération */}
      {genResult && (
        <div
          className={`mt-4 rounded-lg border p-3 text-sm ${
            genResult.ok ? "border-green-800 bg-green-950/30 text-green-300" : "border-red-800 bg-red-950/40 text-red-300"
          }`}
        >
          <p>{genResult.text}</p>
          {genResult.blobUrl?.startsWith("https://") && (
            <a href={genResult.blobUrl} target="_blank" rel="noopener noreferrer" className="underline text-xs break-all">
              Voir la vidéo
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm text-gray-400 mb-1">{label}</label>
      {children}
    </div>
  );
}

/** Segmented button group. */
function Segmented({
  choices,
  value,
  onSelect,
}: {
  choices: { value: string; label: string }[];
  value: string;
  onSelect: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {choices.map((c) => {
        const active = value === c.value;
        return (
          <button
            key={c.value || "auto"}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(c.value)}
            className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
              active ? "bg-blue-600 border-blue-500 text-white" : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600"
            }`}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

/** A single product card in the selection grid. */
function ProductCard({ p }: { p: ProductItem }) {
  const img = p.images[0];
  const showBadge = typeof p.discount_pct === "number" && p.discount_pct >= 10;
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-950 overflow-hidden">
      <div className="relative aspect-square bg-gray-900">
        {img ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={img} alt={p.title_fr} loading="lazy" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-700 text-xs">pas d’image</div>
        )}
        {showBadge && (
          <span className="absolute top-1 right-1 px-1.5 py-0.5 rounded bg-amber-500 text-gray-900 text-[10px] font-bold">
            -{p.discount_pct}%
          </span>
        )}
      </div>
      <div className="p-2">
        <p className="text-xs text-gray-300 line-clamp-2" title={p.title_fr}>{p.title_fr}</p>
        <p className="mt-1 text-xs">
          <span className="text-gray-100 font-semibold">{p.price.toFixed(2)} $</span>
          {showBadge && p.compare_at_price ? (
            <span className="ml-1 text-gray-500 line-through">{p.compare_at_price.toFixed(2)} $</span>
          ) : null}
        </p>
      </div>
    </div>
  );
}

/** Minimal manifest shape the panel renders (subset of SlideshowManifest). */
interface SlideshowManifest {
  items: { overlay_text: string; showsBadge: boolean; discountPct?: number }[];
  template: string;
  ratio: string;
  estimatedDurationSec: number;
  wouldUploadTo: string;
}
