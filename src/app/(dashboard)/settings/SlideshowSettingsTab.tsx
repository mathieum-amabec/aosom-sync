"use client";

// Passive slideshow config only: which templates are enabled for automated
// generation, the default ratio, and the default platform. The full manual
// generation hub (selection modes, video params, dry-runs, Generate) lives on
// the /videos "Générer" tab (engine = "Slideshow"). Publishing cadence is set on
// the Settings → Publication tab (video_schedule).

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

export default function SlideshowSettingsTab() {
  const [settings, setSettings] = useState<SlideshowSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    try {
      const res = await fetch("/api/settings/schedule");
      const d = await res.json();
      if (d.success) setSettings(d.data.slideshow_settings);
      else setMsg({ ok: false, text: d.error || "Échec du chargement des préférences." });
    } catch (err) {
      setMsg({ ok: false, text: String(err) });
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

  if (loading) {
    return <div className="p-2 text-gray-500">Chargement des préférences vidéo…</div>;
  }
  if (!settings) {
    return (
      <div className="p-2 space-y-3">
        <p className="text-sm text-red-400">{msg?.text || "Impossible de charger les préférences vidéo."}</p>
        <button onClick={load} className="px-3 py-1.5 bg-gray-700 text-white text-sm rounded-lg hover:bg-gray-600">
          Réessayer
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Activation par template ── */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 md:p-5">
        <h3 className="text-white font-semibold mb-1">Templates de slideshow</h3>
        <p className="text-xs text-gray-500 mb-4">
          Active les montages produits utilisés par la génération automatique. La génération
          manuelle se fait dans <span className="text-gray-400">Vidéos → Générer</span> (moteur
          « Slideshow ») et peut produire n’importe quel template.
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
        <h3 className="text-white font-semibold mb-1">Défauts</h3>
        <p className="text-xs text-gray-500 mb-4">
          Ratio et plateforme par défaut des slideshows. La cadence de publication se règle dans
          l’onglet <span className="text-gray-400">Publication</span>.
        </p>
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
            <label className="block text-sm text-gray-400 mb-2">Plateforme par défaut</label>
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
    </div>
  );
}
