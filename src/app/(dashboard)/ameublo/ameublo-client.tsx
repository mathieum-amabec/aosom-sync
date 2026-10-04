"use client";

import { useState, useEffect, useCallback } from "react";
import MusicPicker from "./music-picker";
import { SectionTabs, VIDEO_SECTION_TABS } from "@/components/section-tabs";

// Mirrors AmeubloTestVideo in src/lib/database.ts.
interface TestVideo {
  id: number;
  series: string;
  sku: string | null;
  campaign: string | null;
  label: string | null;
  video_url: string;
  source_queue_id: number | null;
  verdict: "ok" | "bad" | null;
  note: string | null;
  created_at: string;
}

/** Keep the series order of the API (newest first) and the video order inside each series. */
function groupBySeries(videos: TestVideo[]): [string, TestVideo[]][] {
  const map = new Map<string, TestVideo[]>();
  for (const v of videos) {
    const list = map.get(v.series) ?? [];
    list.push(v);
    map.set(v.series, list);
  }
  return [...map.entries()];
}

export default function AmeubloStudioClient() {
  const [videos, setVideos] = useState<TestVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/ameublo/videos");
      const j = await res.json();
      if (!res.ok || !j.success) throw new Error(j.error || `HTTP ${res.status}`);
      setVideos(j.data.videos);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (id: number, patch: { verdict?: "ok" | "bad" | null; note?: string }) => {
    const current = videos.find((v) => v.id === id);
    if (!current) return;
    const next = { ...current, ...patch };
    setVideos((vs) => vs.map((v) => (v.id === id ? next : v)));
    const res = await fetch("/api/ameublo/videos", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, verdict: next.verdict, note: patch.note }),
    });
    if (!res.ok) {
      setVideos((vs) => vs.map((v) => (v.id === id ? current : v)));
      const j = await res.json().catch(() => ({}));
      setError(j.error || `Échec de l'enregistrement (HTTP ${res.status})`);
    }
  };

  return (
    <div className="p-4 md:p-8 space-y-6">
      <SectionTabs tabs={VIDEO_SECTION_TABS} />

      <div>
        <h1 className="text-2xl font-bold text-white">Studio Ameublo</h1>
        <p className="text-sm text-gray-400 mt-1">
          Vidéos test de la mascotte, pour juger la constance du personnage. Elles ne sont{" "}
          <strong className="text-gray-200">jamais publiées</strong> : rien ici n&apos;entre dans la file de
          publication. Note chaque vidéo 👍 / 👎 et laisse un commentaire si quelque chose cloche.
        </p>
      </div>

      <MusicPicker />

      {error && <div className="rounded border border-red-800 bg-red-950/40 p-3 text-sm text-red-300">{error}</div>}
      {loading && <div className="text-gray-400 text-sm">Chargement…</div>}
      {!loading && videos.length === 0 && !error && (
        <div className="rounded border border-gray-800 bg-gray-900 p-6 text-gray-400 text-sm">
          Aucune vidéo test pour l&apos;instant.
        </div>
      )}

      {groupBySeries(videos).map(([series, list]) => {
        const ok = list.filter((v) => v.verdict === "ok").length;
        const bad = list.filter((v) => v.verdict === "bad").length;
        return (
          <section key={series} className="space-y-3">
            <div className="flex items-baseline gap-3 flex-wrap">
              <h2 className="text-lg font-semibold text-white">{series}</h2>
              <span className="text-xs text-gray-400">
                {list.length} vidéo{list.length > 1 ? "s" : ""} · 👍 {ok} · 👎 {bad} · à noter {list.length - ok - bad}
              </span>
            </div>
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {list.map((v) => (
                <div key={v.id} className="rounded-lg border border-gray-800 bg-gray-900 p-3 space-y-2">
                  <video
                    src={v.video_url}
                    controls
                    preload="metadata"
                    playsInline
                    className="w-full aspect-[9/16] rounded bg-black object-contain"
                  />
                  <div className="text-sm text-gray-200">{v.label || v.sku || `Vidéo ${v.id}`}</div>
                  <div className="text-xs text-gray-500">
                    {[v.sku, v.campaign].filter(Boolean).join(" · ")}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => save(v.id, { verdict: v.verdict === "ok" ? null : "ok" })}
                      className={`flex-1 rounded px-2 py-1 text-sm border ${
                        v.verdict === "ok"
                          ? "bg-green-900/50 border-green-700 text-green-200"
                          : "border-gray-700 text-gray-300 hover:bg-gray-800"
                      }`}
                    >
                      👍 Constant
                    </button>
                    <button
                      onClick={() => save(v.id, { verdict: v.verdict === "bad" ? null : "bad" })}
                      className={`flex-1 rounded px-2 py-1 text-sm border ${
                        v.verdict === "bad"
                          ? "bg-red-950/60 border-red-800 text-red-200"
                          : "border-gray-700 text-gray-300 hover:bg-gray-800"
                      }`}
                    >
                      👎 À revoir
                    </button>
                  </div>
                  <textarea
                    defaultValue={v.note ?? ""}
                    placeholder="Commentaire (optionnel)"
                    rows={2}
                    onBlur={(e) => {
                      if (e.target.value !== (v.note ?? "")) save(v.id, { note: e.target.value });
                    }}
                    className="w-full rounded border border-gray-700 bg-gray-950 p-2 text-xs text-gray-200"
                  />
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
