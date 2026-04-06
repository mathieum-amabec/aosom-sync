"use client";

import { useState, useEffect } from "react";

interface Settings {
  [key: string]: string;
}

interface FieldDef {
  key: string;
  label: string;
  type: string;
  env?: boolean;
  options?: string[];
}

const SECTIONS: { title: string; fields: FieldDef[] }[] = [
  {
    title: "Facebook / Graph API",
    fields: [
      { key: "FACEBOOK_PAGE_ID", label: "Page ID", type: "text", env: true },
      { key: "FACEBOOK_PAGE_ACCESS_TOKEN", label: "Page Access Token", type: "password", env: true },
    ],
  },
  {
    title: "Social Workflow",
    fields: [
      { key: "social_default_language", label: "Default Language", type: "select", options: ["FR", "EN"] },
      { key: "social_post_frequency", label: "Posts per Day (highlights)", type: "number" },
      { key: "social_preferred_hour", label: "Preferred Post Hour (0-23)", type: "number" },
      { key: "social_price_drop_threshold", label: "Price Drop Threshold (%)", type: "number" },
      { key: "social_min_days_between_reposts", label: "Min Days Between Reposts", type: "number" },
    ],
  },
  {
    title: "Content",
    fields: [
      { key: "social_hashtags_fr", label: "Hashtags FR", type: "textarea" },
      { key: "social_hashtags_en", label: "Hashtags EN", type: "textarea" },
      { key: "social_tone", label: "Post Tone", type: "select", options: ["promotional", "professional", "casual"] },
      { key: "social_include_price", label: "Include Price", type: "toggle" },
      { key: "social_include_link", label: "Include Shopify Link", type: "toggle" },
    ],
  },
  {
    title: "Prompts — New Product",
    fields: [
      { key: "prompt_new_product_fr", label: "Prompt FR", type: "prompt" },
      { key: "prompt_new_product_en", label: "Prompt EN", type: "prompt" },
    ],
  },
  {
    title: "Prompts — Price Drop",
    fields: [
      { key: "prompt_price_drop_fr", label: "Prompt FR", type: "prompt" },
      { key: "prompt_price_drop_en", label: "Prompt EN", type: "prompt" },
    ],
  },
  {
    title: "Prompts — Stock Highlight",
    fields: [
      { key: "prompt_highlight_fr", label: "Prompt FR", type: "prompt" },
      { key: "prompt_highlight_en", label: "Prompt EN", type: "prompt" },
    ],
  },
  {
    title: "Shopify",
    fields: [
      { key: "SHOPIFY_STORE_URL", label: "Store URL", type: "text", env: true },
      { key: "SHOPIFY_ACCESS_TOKEN", label: "API Token", type: "password", env: true },
    ],
  },
  {
    title: "Claude API",
    fields: [
      { key: "ANTHROPIC_API_KEY", label: "API Key", type: "password", env: true },
    ],
  },
];

const PROMPT_VARS = "{product_name}, {price}, {old_price}, {new_price}, {qty}, {hashtags}, {store_name}";

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [testResults, setTestResults] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => { if (d.success) setSettings(d.data); })
      .finally(() => setLoading(false));
  }, []);

  function updateField(key: string, value: string) {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setDirty((prev) => new Set(prev).add(key));
  }

  async function saveChanges() {
    setSaving(true);
    const updates: Record<string, string> = {};
    for (const key of dirty) {
      if (!key.startsWith("SHOPIFY_") && !key.startsWith("FACEBOOK_") && !key.startsWith("ANTHROPIC_")) {
        updates[key] = settings[key];
      }
    }
    if (Object.keys(updates).length > 0) {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      const data = await res.json();
      if (data.success) {
        setSettings(data.data);
        setDirty(new Set());
      }
    }
    setSaving(false);
  }

  async function testShopify() {
    setTestResults((prev) => ({ ...prev, shopify: "Testing..." }));
    try {
      const res = await fetch("/api/catalog?limit=1");
      const data = await res.json();
      setTestResults((prev) => ({ ...prev, shopify: data.success ? "Connected" : `Error: ${data.error}` }));
    } catch (err) {
      setTestResults((prev) => ({ ...prev, shopify: `Error: ${err}` }));
    }
  }

  async function testClaude() {
    setTestResults((prev) => ({ ...prev, claude: "Testing..." }));
    try {
      const res = await fetch("/api/settings");
      setTestResults((prev) => ({ ...prev, claude: res.ok ? "API Key configured" : "Error" }));
    } catch (err) {
      setTestResults((prev) => ({ ...prev, claude: `Error: ${err}` }));
    }
  }

  if (loading) return <div className="p-8 text-gray-500">Loading settings...</div>;

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Settings</h2>
          <p className="text-gray-400 text-sm mt-1">Configure sync, social media, and API connections</p>
        </div>
        {dirty.size > 0 && (
          <button
            onClick={saveChanges}
            disabled={saving}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-500 disabled:opacity-50"
          >
            {saving ? "Saving..." : `Save ${dirty.size} change${dirty.size > 1 ? "s" : ""}`}
          </button>
        )}
      </div>

      <div className="space-y-6">
        {SECTIONS.map((section) => (
          <div key={section.title} className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h3 className="text-white font-semibold mb-4">{section.title}</h3>
            <div className="space-y-4">
              {section.fields.map((field) => (
                <div key={field.key}>
                  <label className="block text-sm text-gray-400 mb-1">{field.label}</label>

                  {field.env ? (
                    <div className="flex items-center gap-2">
                      <input
                        type={field.type === "password" ? "password" : "text"}
                        value="••••••••"
                        disabled
                        className="flex-1 bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-500"
                      />
                      <span className="text-xs text-gray-600">.env.local</span>
                    </div>
                  ) : field.type === "select" ? (
                    <select
                      value={settings[field.key] || ""}
                      onChange={(e) => updateField(field.key, e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
                    >
                      {field.options?.map((opt) => (
                        <option key={opt} value={opt}>{opt}</option>
                      ))}
                    </select>
                  ) : field.type === "toggle" ? (
                    <button
                      onClick={() => updateField(field.key, settings[field.key] === "true" ? "false" : "true")}
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        settings[field.key] === "true" ? "bg-blue-600" : "bg-gray-700"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${
                          settings[field.key] === "true" ? "translate-x-5" : ""
                        }`}
                      />
                    </button>
                  ) : field.type === "number" ? (
                    <input
                      type="number"
                      value={settings[field.key] || ""}
                      onChange={(e) => updateField(field.key, e.target.value)}
                      className="w-32 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
                    />
                  ) : field.type === "textarea" ? (
                    <textarea
                      value={settings[field.key] || ""}
                      onChange={(e) => updateField(field.key, e.target.value)}
                      rows={2}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 resize-y"
                    />
                  ) : field.type === "prompt" ? (
                    <div>
                      <textarea
                        value={settings[field.key] || ""}
                        onChange={(e) => updateField(field.key, e.target.value)}
                        rows={4}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 resize-y font-mono"
                      />
                      <p className="text-xs text-gray-600 mt-1">Variables: {PROMPT_VARS}</p>
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={settings[field.key] || ""}
                      onChange={(e) => updateField(field.key, e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
                    />
                  )}
                </div>
              ))}

              {/* Test buttons */}
              {section.title === "Shopify" && (
                <div className="flex items-center gap-3 pt-2">
                  <button onClick={testShopify} className="px-3 py-1.5 bg-gray-800 text-gray-300 text-xs rounded-lg hover:bg-gray-700 border border-gray-700">
                    Test Connection
                  </button>
                  {testResults.shopify && (
                    <span className={`text-xs ${testResults.shopify === "Connected" ? "text-green-400" : "text-red-400"}`}>
                      {testResults.shopify}
                    </span>
                  )}
                </div>
              )}
              {section.title === "Claude API" && (
                <div className="flex items-center gap-3 pt-2">
                  <button onClick={testClaude} className="px-3 py-1.5 bg-gray-800 text-gray-300 text-xs rounded-lg hover:bg-gray-700 border border-gray-700">
                    Test Connection
                  </button>
                  {testResults.claude && (
                    <span className={`text-xs ${testResults.claude.startsWith("Error") ? "text-red-400" : "text-green-400"}`}>
                      {testResults.claude}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
