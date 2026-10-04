"use client";

import { useState, useEffect, useCallback } from "react";

interface McpKey { id: number; name: string; key_hint: string; scope: string; created_at: number; last_used_at: number | null; revoked_at: number | null }
interface McpGrant { id: number; client_name: string; scope: string; created_at: number; last_used_at: number | null }

const SCOPE_FR: Record<string, string> = { read: "Lecture", analytics: "Analytics", import: "Import", social: "Publications" };
const scopeLabel = (scope: string) => scope.split(" ").map((x) => SCOPE_FR[x] ?? x).join(" · ");
const fmt = (t: number | null) => (t ? new Date(t * 1000).toLocaleString("fr-CA") : "jamais");

/**
 * Réglages → MCP — "connect Claude to Aosom-sync" in three steps:
 *  1. create a key (its permissions decide what Claude may do),
 *  2. add the link as a custom connector in Claude (claude.ai / app / Desktop),
 *  3. Claude opens our page → paste the key → Autoriser.
 */
export default function McpKeysTab() {
  const [keys, setKeys] = useState<McpKey[]>([]);
  const [grants, setGrants] = useState<McpGrant[]>([]);
  const [name, setName] = useState("");
  const [withAnalytics, setWithAnalytics] = useState(true);
  const [withImport, setWithImport] = useState(false);
  const [withSocial, setWithSocial] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ name: string; key: string } | null>(null);
  const [copied, setCopied] = useState<"key" | "link" | null>(null);

  const load = useCallback(async () => {
    try {
      const [k, g] = await Promise.all([fetch("/api/settings/mcp-keys").then((r) => r.json()), fetch("/api/settings/mcp-grants").then((r) => r.json())]);
      if (k.success) setKeys(k.data); else setError(k.error || "Impossible de charger les clés");
      if (g.success) setGrants(g.data);
    } catch { setError("Erreur réseau"); }
  }, []);
  useEffect(() => {
    // Initial load inline (after an await) rather than through `load`, which sets state synchronously.
    Promise.all([fetch("/api/settings/mcp-keys").then((r) => r.json()), fetch("/api/settings/mcp-grants").then((r) => r.json())])
      .then(([k, g]) => {
        if (k.success) setKeys(k.data); else setError(k.error || "Impossible de charger les clés");
        if (g.success) setGrants(g.data);
      })
      .catch(() => setError("Erreur réseau"));
  }, []);

  const create = async () => {
    setBusy(true); setError(null); setCopied(null);
    try {
      const r = await fetch("/api/settings/mcp-keys", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, scopes: ["read", ...(withAnalytics ? ["analytics"] : []), ...(withImport ? ["import"] : []), ...(withSocial ? ["social"] : [])] }),
      });
      const j = await r.json();
      if (j.success) { setFresh({ name: j.data.name, key: j.data.key }); setName(""); await load(); }
      else setError(j.error || "Échec de la création");
    } catch { setError("Erreur réseau"); }
    setBusy(false);
  };

  const copy = async (what: "key" | "link", text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); } catch { setError("Copie impossible : sélectionne le texte à la main."); }
  };

  const revokeKey = async (k: McpKey) => {
    if (!window.confirm(`Révoquer la clé « ${k.name} » ? Les connexions faites avec cette clé seront coupées tout de suite.`)) return;
    const r = await fetch(`/api/settings/mcp-keys?id=${k.id}`, { method: "DELETE" });
    if (!r.ok) setError("Échec de la révocation");
    await load();
  };

  const revokeGrant = async (g: McpGrant) => {
    if (!window.confirm(`Couper la connexion « ${g.client_name} » ?`)) return;
    const r = await fetch(`/api/settings/mcp-grants?id=${g.id}`, { method: "DELETE" });
    if (!r.ok) setError("Échec de la révocation");
    await load();
  };

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const link = `${origin}/api/mcp`;
  const card = "bg-gray-900 border border-gray-800 rounded-xl p-5";
  const num = "inline-flex items-center justify-center w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-semibold mr-2";

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold">Connecter Claude à Aosom-sync</h2>
        <p className="text-sm text-gray-400">
          Pour parler à Claude de ton catalogue (ordinateur, claude.ai ou téléphone). 3 étapes, une seule fois.
        </p>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {/* Step 1 */}
      <div className={card}>
        <h3 className="font-medium mb-1"><span className={num}>1</span>Crée une clé</h3>
        <p className="text-sm text-gray-400">La clé est ton mot de passe pour Claude. Ce que tu coches ici est ce que Claude aura le droit de faire.</p>
        <div className="mt-3 space-y-2 text-sm text-gray-300">
          <label className="block"><input type="checkbox" checked disabled /> <b>Lecture</b> <span className="text-gray-500">— chercher des produits (importés ou non), voir l&apos;inventaire</span></label>
          <label className="block"><input type="checkbox" checked={withAnalytics} onChange={(e) => setWithAnalytics(e.target.checked)} /> <b>Analytics</b> <span className="text-gray-500">— meilleurs vendeurs, baisses de prix, stock faible</span></label>
          <label className="block"><input type="checkbox" checked={withSocial} onChange={(e) => setWithSocial(e.target.checked)} /> <b>Publications</b> <span className="text-gray-500">— créer des brouillons de posts (tu les approuves toi-même ici)</span></label>
          <label className="block"><input type="checkbox" checked={withImport} onChange={(e) => setWithImport(e.target.checked)} /> <b>Import</b> <span className="text-gray-500">— créer des produits (en ligne tout de suite, 5 à la fois, avec confirmation)</span></label>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 mt-4">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Nom de la clé (ex. Téléphone de Mat)"
            className="flex-1 px-3 py-2 bg-gray-950 border border-gray-700 rounded-lg text-sm" />
          <button onClick={create} disabled={busy || !name.trim()} className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-500 disabled:opacity-50">
            {busy ? "Création…" : "Créer la clé"}
          </button>
        </div>
        {fresh && (
          <div className="mt-4 bg-amber-950/40 border border-amber-700 rounded-lg p-4 space-y-2">
            <p className="text-sm text-amber-200 font-medium">Voici ta clé « {fresh.name} ». Copie-la et garde-la (notes, gestionnaire de mots de passe) : elle ne sera plus jamais affichée.</p>
            <code className="block break-all bg-gray-950 border border-gray-700 rounded-lg p-3 text-sm">{fresh.key}</code>
            <button onClick={() => copy("key", fresh.key)} className="px-3 py-1.5 bg-gray-800 text-sm rounded-lg hover:bg-gray-700">{copied === "key" ? "Clé copiée ✓" : "Copier la clé"}</button>
          </div>
        )}
      </div>

      {/* Step 2 */}
      <div className={card}>
        <h3 className="font-medium mb-1"><span className={num}>2</span>Ajoute ce lien dans Claude</h3>
        <code className="block break-all bg-gray-950 border border-gray-700 rounded-lg p-3 text-sm mt-2">{link}</code>
        <button onClick={() => copy("link", link)} className="mt-2 px-3 py-1.5 bg-gray-800 text-sm rounded-lg hover:bg-gray-700">{copied === "link" ? "Lien copié ✓" : "Copier le lien"}</button>
        <ol className="list-decimal list-inside text-sm text-gray-400 mt-3 space-y-1">
          <li>Va sur <b>claude.ai</b> (ou l&apos;app) → <b>Réglages</b> → <b>Connecteurs</b>.</li>
          <li>Clique <b>Ajouter un connecteur personnalisé</b>.</li>
          <li>Nom : « Aosom-sync ». Adresse : le lien ci-dessus. Ne touche pas aux options avancées.</li>
          <li>Clique <b>Ajouter</b>.</li>
        </ol>
      </div>

      {/* Step 3 */}
      <div className={card}>
        <h3 className="font-medium mb-1"><span className={num}>3</span>Autorise avec ta clé</h3>
        <p className="text-sm text-gray-400">
          Claude ouvre alors une page de ce site. <b>Colle la clé de l&apos;étape 1</b>, puis appuie sur <b>Autoriser</b>. C&apos;est fini : le connecteur
          marche aussi sur l&apos;app du téléphone (même compte Claude). Si ça refuse, la clé est mauvaise ou révoquée : crées-en une nouvelle.
        </p>
      </div>

      {/* Lists */}
      <div className={`${card} overflow-x-auto`}>
        <h3 className="font-medium mb-2">Tes clés</h3>
        <table className="w-full text-sm">
          <thead className="text-left text-gray-400 border-b border-gray-800">
            <tr><th className="p-2">Nom</th><th className="p-2">Clé</th><th className="p-2">Permissions</th><th className="p-2">Dernier usage</th><th className="p-2" /></tr>
          </thead>
          <tbody>
            {keys.length === 0 && <tr><td colSpan={5} className="p-3 text-gray-500">Aucune clé.</td></tr>}
            {keys.map((k) => (
              <tr key={k.id} className="border-b border-gray-800/60">
                <td className="p-2">{k.name}</td>
                <td className="p-2 font-mono text-gray-400">{k.key_hint}…</td>
                <td className="p-2 text-gray-400">{scopeLabel(k.scope)}</td>
                <td className="p-2 text-gray-400">{fmt(k.last_used_at)}</td>
                <td className="p-2 text-right">
                  {k.revoked_at ? <span className="text-gray-500">Révoquée</span>
                    : <button onClick={() => revokeKey(k)} className="text-red-400 hover:text-red-300">Révoquer</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={`${card} overflow-x-auto`}>
        <h3 className="font-medium mb-2">Connexions actives</h3>
        <table className="w-full text-sm">
          <thead className="text-left text-gray-400 border-b border-gray-800">
            <tr><th className="p-2">Application</th><th className="p-2">Permissions</th><th className="p-2">Autorisée</th><th className="p-2">Dernier usage</th><th className="p-2" /></tr>
          </thead>
          <tbody>
            {grants.length === 0 && <tr><td colSpan={5} className="p-3 text-gray-500">Aucune connexion.</td></tr>}
            {grants.map((g) => (
              <tr key={g.id} className="border-b border-gray-800/60">
                <td className="p-2">{g.client_name}</td>
                <td className="p-2 text-gray-400">{scopeLabel(g.scope)}</td>
                <td className="p-2 text-gray-400">{fmt(g.created_at)}</td>
                <td className="p-2 text-gray-400">{fmt(g.last_used_at)}</td>
                <td className="p-2 text-right"><button onClick={() => revokeGrant(g)} className="text-red-400 hover:text-red-300">Couper</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-gray-500 mt-2">Révoquer une clé coupe aussi les connexions faites avec elle.</p>
      </div>

      <details className="text-sm text-gray-400">
        <summary className="cursor-pointer">Avancé — Claude Desktop par fichier (pont)</summary>
        <p className="mt-2">Seulement si le connecteur ne convient pas : copie <code>scripts/mcp-remote.mjs</code> du dépôt et ajoute dans <code>claude_desktop_config.json</code> :</p>
        <pre className="bg-gray-950 border border-gray-700 rounded-lg p-3 text-xs overflow-x-auto mt-2">{JSON.stringify({ mcpServers: { "aosom-sync": { command: "node", args: ["C:\\chemin\\vers\\mcp-remote.mjs"], env: { MCP_URL: link, MCP_KEY: "<ta clé>" } } } }, null, 2)}</pre>
      </details>
    </div>
  );
}
