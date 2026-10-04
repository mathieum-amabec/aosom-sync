"use client";

import { useState, useEffect, useCallback } from "react";

interface McpKey { id: number; name: string; key_hint: string; created_at: number; last_used_at: number | null; revoked_at: number | null }

const fmt = (t: number | null) => (t ? new Date(t * 1000).toLocaleString("fr-CA") : "jamais");

/** Réglages → MCP: create / revoke the keys that unlock the hosted MCP endpoint (/api/mcp). */
export default function McpKeysTab() {
  const [keys, setKeys] = useState<McpKey[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/settings/mcp-keys");
      const j = await r.json();
      if (j.success) setKeys(j.data);
      else setError(j.error || "Impossible de charger les clés");
    } catch { setError("Erreur réseau"); }
  }, []);
  useEffect(() => {
    // Initial load inline (after an await) rather than through `load`, which sets state synchronously.
    fetch("/api/settings/mcp-keys")
      .then((r) => r.json())
      .then((j) => { if (j.success) setKeys(j.data); else setError(j.error || "Impossible de charger les clés"); })
      .catch(() => setError("Erreur réseau"));
  }, []);

  const create = async () => {
    setBusy(true); setError(null); setCopied(false); setCopiedUrl(false);
    try {
      const r = await fetch("/api/settings/mcp-keys", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      const j = await r.json();
      if (j.success) { setFresh({ name: j.data.name, key: j.data.key }); setName(""); await load(); }
      else setError(j.error || "Échec de la création");
    } catch { setError("Erreur réseau"); }
    setBusy(false);
  };

  const revoke = async (k: McpKey) => {
    if (!window.confirm(`Révoquer la clé « ${k.name} » ? Les clients qui l'utilisent seront refusés immédiatement.`)) return;
    const r = await fetch(`/api/settings/mcp-keys?id=${k.id}`, { method: "DELETE" });
    if (!r.ok) setError("Échec de la révocation");
    await load();
  };

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const snippet = fresh
    ? JSON.stringify({ mcpServers: { "aosom-sync": { command: "node", args: ["C:\\chemin\\vers\\mcp-remote.mjs"], env: { MCP_URL: `${origin}/api/mcp`, MCP_KEY: fresh.key } } } }, null, 2)
    : "";

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <h2 className="text-lg font-semibold mb-1">Clés MCP</h2>
        <p className="text-sm text-gray-400">
          Une clé permet à Claude Desktop (ou Claude Code) de consulter le catalogue en lecture seule : recherche de produits Aosom et Costway,
          file d&apos;import, budget LLM, état des tâches. La clé n&apos;est affichée qu&apos;une fois ; seule son empreinte est conservée.
        </p>
        <div className="flex flex-col sm:flex-row gap-2 mt-4">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Nom (ex. Claude Desktop — portable)"
            className="flex-1 px-3 py-2 bg-gray-950 border border-gray-700 rounded-lg text-sm" />
          <button onClick={create} disabled={busy || !name.trim()} className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-500 disabled:opacity-50">
            {busy ? "Création…" : "Créer une clé"}
          </button>
        </div>
        {error && <p className="text-sm text-red-400 mt-3">{error}</p>}
      </div>

      {fresh && (
        <div className="bg-amber-950/40 border border-amber-700 rounded-xl p-5 space-y-3">
          <p className="text-sm text-amber-200 font-medium">Clé « {fresh.name} » — copie-la maintenant, elle ne sera plus affichée.</p>
          <code className="block break-all bg-gray-950 border border-gray-700 rounded-lg p-3 text-sm">{fresh.key}</code>
          <button onClick={async () => { await navigator.clipboard.writeText(fresh.key); setCopied(true); }}
            className="px-3 py-1.5 bg-gray-800 text-sm rounded-lg hover:bg-gray-700">{copied ? "Copiée ✓" : "Copier la clé"}</button>
          <p className="text-xs text-gray-400">Pour <strong>claude.ai et l&apos;app mobile</strong> : Réglages → Connecteurs → Ajouter un connecteur personnalisé, puis colle cette adresse (elle contient la clé : traite-la comme un mot de passe, révoque-la si elle fuite).</p>
          <code className="block break-all bg-gray-950 border border-gray-700 rounded-lg p-3 text-xs">{`${origin}/api/mcp/${fresh.key}`}</code>
          <button onClick={async () => { await navigator.clipboard.writeText(`${origin}/api/mcp/${fresh.key}`); setCopiedUrl(true); }}
            className="px-3 py-1.5 bg-gray-800 text-sm rounded-lg hover:bg-gray-700">{copiedUrl ? "Adresse copiée ✓" : "Copier l'adresse"}</button>
          <p className="text-xs text-gray-400">Configuration Claude Desktop (fichier <code>claude_desktop_config.json</code>, section <code>mcpServers</code>) :</p>
          <pre className="bg-gray-950 border border-gray-700 rounded-lg p-3 text-xs overflow-x-auto">{snippet}</pre>
          <p className="text-xs text-gray-500">Le fichier <code>scripts/mcp-remote.mjs</code> du dépôt est le pont : copie-le où tu veux et mets son chemin dans <code>args</code>.</p>
          <button onClick={() => setFresh(null)} className="text-xs text-gray-400 hover:text-gray-200 underline">Fermer</button>
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-gray-400 border-b border-gray-800">
            <tr><th className="p-3">Nom</th><th className="p-3">Clé</th><th className="p-3">Créée</th><th className="p-3">Dernier usage</th><th className="p-3" /></tr>
          </thead>
          <tbody>
            {keys.length === 0 && <tr><td colSpan={5} className="p-4 text-gray-500">Aucune clé.</td></tr>}
            {keys.map((k) => (
              <tr key={k.id} className="border-b border-gray-800/60">
                <td className="p-3">{k.name}</td>
                <td className="p-3 font-mono text-gray-400">{k.key_hint}…</td>
                <td className="p-3 text-gray-400">{fmt(k.created_at)}</td>
                <td className="p-3 text-gray-400">{fmt(k.last_used_at)}</td>
                <td className="p-3 text-right">
                  {k.revoked_at ? <span className="text-gray-500">Révoquée</span>
                    : <button onClick={() => revoke(k)} className="text-red-400 hover:text-red-300">Révoquer</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
