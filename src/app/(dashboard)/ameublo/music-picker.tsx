"use client";

import { useState, useEffect, useRef } from "react";

// Mirrors MusicCandidate in src/lib/ameublo-music-catalog.ts.
interface Candidate {
  num: number;
  title: string;
  artist: string;
  group: string;
  mood: string;
  source: "pixabay" | "mixkit";
  page: string;
  audio: string;
  claudePick: boolean;
  warning?: string;
}

/**
 * "Choisis tes musiques": every candidate plays inline, ❤️ saves the pick at once.
 * Only one track plays at a time.
 */
export default function MusicPicker() {
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [groups, setGroups] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const playing = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    fetch("/api/ameublo/music")
      .then((r) => r.json())
      .then((j) => {
        if (!j.success) throw new Error(j.error || "Erreur");
        setCandidates(j.data.candidates);
        setGroups(j.data.groups);
        setPicked(new Set(j.data.picks.nums));
        setComment(j.data.picks.comment);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const toggle = async (num: number) => {
    const liked = !picked.has(num);
    const next = new Set(picked);
    if (liked) next.add(num);
    else next.delete(num);
    setPicked(next);
    const res = await fetch("/api/ameublo/music", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ num, liked }),
    });
    if (!res.ok) {
      setPicked(picked);
      setError(`Échec de l'enregistrement (HTTP ${res.status})`);
    }
  };

  const saveComment = async (text: string) => {
    const res = await fetch("/api/ameublo/music", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ comment: text }),
    });
    if (!res.ok) setError(`Échec de l'enregistrement du commentaire (HTTP ${res.status})`);
  };

  // One track at a time.
  const onPlay = (e: React.SyntheticEvent<HTMLAudioElement>) => {
    if (playing.current && playing.current !== e.currentTarget) playing.current.pause();
    playing.current = e.currentTarget;
  };

  const claude = candidates.filter((c) => c.claudePick).map((c) => c.num);

  return (
    <section className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-4">
      <button onClick={() => setOpen(!open)} className="w-full flex items-baseline justify-between gap-3 text-left">
        <h2 className="text-lg font-semibold text-white">🎵 Choisis tes musiques</h2>
        <span className="text-sm text-gray-300">
          ❤️ {picked.size} choisie{picked.size > 1 ? "s" : ""} {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <>
          <p className="text-sm text-gray-400">
            Écoute et clique ❤️ sur celles que tu aimes (vise une dizaine). C&apos;est enregistré tout de suite, et je
            le vois de mon côté. ⭐ = mes coups de cœur ({claude.join(", ")}). Toutes sont libres de droits pour la pub,
            sans mention d&apos;auteur.
          </p>
          {error && <div className="rounded border border-red-800 bg-red-950/40 p-2 text-sm text-red-300">{error}</div>}
          {Object.entries(groups).map(([key, label]) => (
            <div key={key} className="space-y-2">
              <h3 className="text-sm font-semibold text-amber-300">{label}</h3>
              <div className="grid gap-2 grid-cols-1 lg:grid-cols-2">
                {candidates
                  .filter((c) => c.group === key)
                  .map((c) => {
                    const liked = picked.has(c.num);
                    return (
                      <div
                        key={c.num}
                        className={`rounded border p-2 space-y-1 ${liked ? "border-pink-700 bg-pink-950/20" : "border-gray-800 bg-gray-950"}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-gray-500 w-6 text-right">{c.num}</span>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-gray-100 truncate">
                              {c.claudePick && <span title="Coup de cœur de Claude">⭐ </span>}
                              {c.title} <span className="text-gray-500">— {c.artist}</span>
                            </div>
                            <div className="text-xs text-gray-400">
                              {c.mood}
                              {c.warning && <span className="text-amber-400"> · ⚠ {c.warning}</span>}
                            </div>
                          </div>
                          <button
                            onClick={() => toggle(c.num)}
                            className={`rounded px-2 py-1 text-sm border shrink-0 ${
                              liked ? "bg-pink-900/50 border-pink-700 text-pink-100" : "border-gray-700 text-gray-300 hover:bg-gray-800"
                            }`}
                          >
                            {liked ? "❤️ J'aime" : "🤍 J'aime"}
                          </button>
                        </div>
                        <audio src={c.audio} controls preload="none" onPlay={onPlay} className="w-full h-8" />
                        <a href={c.page} target="_blank" rel="noreferrer" className="text-xs text-gray-500 hover:text-gray-300">
                          {c.source === "pixabay" ? "Pixabay" : "Mixkit"} ↗
                        </a>
                      </div>
                    );
                  })}
              </div>
            </div>
          ))}
          <div className="space-y-1">
            <label className="text-sm text-gray-300">Un commentaire sur les musiques ? (optionnel)</label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onBlur={(e) => saveComment(e.target.value)}
              rows={2}
              placeholder="Ex. : plus jazzy pour la Vitrine, la 19 pour Devine le prix…"
              className="w-full rounded border border-gray-700 bg-gray-950 p-2 text-sm text-gray-200"
            />
          </div>
        </>
      )}
    </section>
  );
}
