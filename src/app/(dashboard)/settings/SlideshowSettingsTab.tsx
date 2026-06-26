"use client";

import { useEffect, useState, useCallback } from "react";
import type {
  SlideshowSettings,
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

/** Extra params surfaced in the manual panel, by template. */
type GenForm = {
  template: SlideshowTemplateKey;
  brand: Brand;
  ratio: VideoRatio;
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
  limit: "",
  sku: "",
  category: "",
  sort: "velocity",
  minPct: "",
  threshold: "",
  strategy: "margin",
  theme: "",
};

/** Build the opts object for /api/slideshow/* from the manual form (only the fields the template uses). */
function formToOpts(f: GenForm): Record<string, unknown> {
  const opts: Record<string, unknown> = { brand: f.brand, ratio: f.ratio };
  if (f.limit.trim()) opts.limit = Number(f.limit);
  switch (f.template) {
    case "SHOWCASE":
      if (f.sku.trim()) opts.sku = f.sku.trim();
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

export default function SlideshowSettingsTab() {
  const [settings, setSettings] = useState<SlideshowSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [form, setForm] = useState<GenForm>(DEFAULT_FORM);
  const [running, setRunning] = useState<null | "preview" | "generate">(null);
  const [result, setResult] = useState<string | null>(null);
  const [resultOk, setResultOk] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/settings/schedule");
      const d = await res.json();
      if (d.success) setSettings(d.data.slideshow_settings);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!settings) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings/schedule", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slideshow_settings: settings }),
      });
      const d = await res.json();
      if (d.success) {
        setSettings(d.data.slideshow_settings);
        setMsg({ ok: true, text: "Préférences enregistrées." });
      } else {
        setMsg({ ok: false, text: d.error || "Erreur" });
      }
    } catch (err) {
      setMsg({ ok: false, text: String(err) });
    } finally {
      setSaving(false);
    }
  }

  async function runPreview() {
    setRunning("preview");
    setResult(null);
    try {
      const opts = formToOpts(form);
      const params = new URLSearchParams({ template: form.template });
      for (const [k, v] of Object.entries(opts)) params.set(k, String(v));
      const res = await fetch(`/api/slideshow/preview?${params.toString()}`);
      const d = await res.json();
      setResultOk(res.ok);
      setResult(JSON.stringify(d.manifest ?? d, null, 2));
    } catch (err) {
      setResultOk(false);
      setResult(String(err));
    } finally {
      setRunning(null);
    }
  }

  async function runGenerate() {
    setRunning("generate");
    setResult(null);
    try {
      const res = await fetch("/api/slideshow/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template: form.template, opts: formToOpts(form), dryRun: false, enqueue: true }),
      });
      const d = await res.json();
      setResultOk(res.ok);
      setResult(JSON.stringify(d, null, 2));
    } catch (err) {
      setResultOk(false);
      setResult(String(err));
    } finally {
      setRunning(null);
    }
  }

  if (loading || !settings) {
    return <div className="p-2 text-gray-500">Chargement des préférences vidéo…</div>;
  }

  return (
    <div className="space-y-6">
      {/* ── Activation par template ── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 md:p-5">
        <h3 className="text-white font-semibold mb-1">Templates de slideshow</h3>
        <p className="text-xs text-gray-500 mb-4">
          Active les montages produits utilisés par la génération automatique. Le panneau manuel
          plus bas peut toujours générer n’importe quel template.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {SLIDESHOW_TEMPLATE_KEYS.map((key: SlideshowTemplateKey) => {
            const on = settings.enabled_templates[key];
            return (
              <button
                key={key}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setSettings({
                    ...settings,
                    enabled_templates: { ...settings.enabled_templates, [key]: !on },
                  })
                }
                className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm border transition-colors text-left ${
                  on
                    ? "bg-blue-600/20 border-blue-500 text-white"
                    : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600"
                }`}
              >
                <span>{SLIDESHOW_TEMPLATE_LABELS[key]}</span>
                <span className={`ml-2 text-xs ${on ? "text-blue-300" : "text-gray-500"}`}>
                  {on ? "Activé" : "Désactivé"}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Défauts: ratio + plateforme ── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 md:p-5">
        <h3 className="text-white font-semibold mb-4">Défauts</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-2">Ratio par défaut</label>
            <div className="flex flex-wrap gap-2">
              {VIDEO_RATIOS.map((r) => {
                const active = settings.default_ratio === r;
                return (
                  <button
                    key={r}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSettings({ ...settings, default_ratio: r })}
                    className={`px-3 py-1.5 rounded-lg text-sm border transition-colors font-mono ${
                      active
                        ? "bg-blue-600 border-blue-500 text-white"
                        : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600"
                    }`}
                  >
                    {RATIO_LABELS[r]}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-2">Plateforme</label>
            <div className="flex flex-wrap gap-2">
              {VIDEO_PLATFORMS.map((p) => {
                const active = settings.platform === p;
                return (
                  <button
                    key={p}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setSettings({ ...settings, platform: p })}
                    className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                      active
                        ? "bg-blue-600 border-blue-500 text-white"
                        : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600"
                    }`}
                  >
                    {PLATFORM_LABELS[p]}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 mt-5">
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-500 disabled:opacity-50"
          >
            {saving ? "Enregistrement…" : "Enregistrer les préférences"}
          </button>
          {msg && <span className={`text-sm ${msg.ok ? "text-green-400" : "text-red-400"}`}>{msg.text}</span>}
        </div>
      </div>

      {/* ── Génération manuelle ── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 md:p-5">
        <h3 className="text-white font-semibold mb-1">Génération manuelle</h3>
        <p className="text-xs text-gray-500 mb-4">
          Aperçu (dry-run) sans rendu, ou génère le MP4 et met-le en file de publication.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Template">
            <select
              value={form.template}
              onChange={(e) => setForm({ ...form, template: e.target.value as SlideshowTemplateKey })}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
            >
              {SLIDESHOW_TEMPLATE_KEYS.map((k) => (
                <option key={k} value={k}>
                  {SLIDESHOW_TEMPLATE_LABELS[k]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Marque">
            <select
              value={form.brand}
              onChange={(e) => setForm({ ...form, brand: e.target.value as Brand })}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
            >
              <option value="ameublo">Ameublo (FR)</option>
              <option value="furnish">Furnish Direct (EN)</option>
            </select>
          </Field>

          <Field label="Ratio">
            <select
              value={form.ratio}
              onChange={(e) => setForm({ ...form, ratio: e.target.value as VideoRatio })}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 font-mono"
            >
              {VIDEO_RATIOS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Nombre de produits (limit)">
            <input
              type="number"
              min={1}
              max={20}
              value={form.limit}
              placeholder="auto"
              onChange={(e) => setForm({ ...form, limit: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
            />
          </Field>

          {/* Template-specific knobs */}
          {form.template === "SHOWCASE" && (
            <Field label="SKU (optionnel — défaut: top vendeur)">
              <input
                value={form.sku}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
                placeholder="824-051V80BK"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 font-mono"
              />
            </Field>
          )}
          {form.template === "PRICE_DROP" && (
            <Field label="Rabais minimum (%)">
              <input
                type="number"
                value={form.minPct}
                placeholder="10"
                onChange={(e) => setForm({ ...form, minPct: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
              />
            </Field>
          )}
          {form.template === "URGENCY" && (
            <Field label="Seuil de stock">
              <input
                type="number"
                value={form.threshold}
                placeholder="5"
                onChange={(e) => setForm({ ...form, threshold: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
              />
            </Field>
          )}
          {form.template === "LOOKBOOK" && (
            <>
              <Field label="Catégorie (product_type)">
                <input
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  placeholder="Office Furniture"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
                />
              </Field>
              <Field label="Tri">
                <select
                  value={form.sort}
                  onChange={(e) => setForm({ ...form, sort: e.target.value })}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
                >
                  <option value="velocity">Ventes</option>
                  <option value="price_asc">Prix ↑</option>
                  <option value="price_desc">Prix ↓</option>
                  <option value="discount">Rabais</option>
                </select>
              </Field>
            </>
          )}
          {form.template === "DISCOVERY" && (
            <Field label="Stratégie">
              <select
                value={form.strategy}
                onChange={(e) => setForm({ ...form, strategy: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
              >
                <option value="margin">Marge / rabais</option>
                <option value="new">Nouveautés</option>
                <option value="random">Aléatoire</option>
              </select>
            </Field>
          )}
          {form.template === "COUNTDOWN" && (
            <Field label="Thème saisonnier">
              <input
                value={form.theme}
                onChange={(e) => setForm({ ...form, theme: e.target.value })}
                placeholder="bbq, ete, rentree, hiver…"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
              />
            </Field>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 mt-5">
          <button
            onClick={runPreview}
            disabled={running !== null}
            className="px-4 py-2 bg-gray-700 text-white text-sm rounded-lg hover:bg-gray-600 disabled:opacity-50"
          >
            {running === "preview" ? "Aperçu…" : "Aperçu (dry-run)"}
          </button>
          <button
            onClick={runGenerate}
            disabled={running !== null}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-500 disabled:opacity-50"
          >
            {running === "generate" ? "Génération…" : "Générer & mettre en file"}
          </button>
        </div>

        {result && (
          <pre
            className={`mt-4 max-h-96 overflow-auto rounded-lg border p-3 text-xs font-mono whitespace-pre-wrap ${
              resultOk ? "border-gray-700 bg-gray-950 text-gray-300" : "border-red-800 bg-red-950/40 text-red-300"
            }`}
          >
            {result}
          </pre>
        )}
      </div>
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
