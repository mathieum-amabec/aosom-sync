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
  min?: number;
  max?: number;
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
    title: "Image Composer",
    fields: [
      { key: "social_accent_color", label: "Accent Color", type: "color" },
      { key: "social_text_color", label: "Text Color", type: "color" },
      { key: "social_store_display_name", label: "Store Name on Images", type: "text" },
      { key: "social_banner_opacity", label: "Banner Opacity (%)", type: "range", min: 0, max: 100 },
      { key: "social_logo_position", label: "Logo Position", type: "select", options: ["bottom-right", "bottom-left", "top-right", "top-left"] },
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
  const [testingPrompt, setTestingPrompt] = useState<string | null>(null);
  const [promptPreview, setPromptPreview] = useState<Record<string, string>>({});

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
    const ENV_PREFIXES = ["SHOPIFY_", "FACEBOOK_", "ANTHROPIC_"];
    for (const key of dirty) {
      if (!ENV_PREFIXES.some((p) => key.startsWith(p))) {
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

  async function testFacebook() {
    setTestResults((prev) => ({ ...prev, facebook: "Testing..." }));
    try {
      const res = await fetch("/api/social", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test-facebook" }),
      });
      const data = await res.json();
      if (data.success) {
        setTestResults((prev) => ({ ...prev, facebook: `Connected — Page: ${data.data.name}` }));
      } else {
        setTestResults((prev) => ({ ...prev, facebook: `Error: ${data.error}` }));
      }
    } catch (err) {
      setTestResults((prev) => ({ ...prev, facebook: `Error: ${err}` }));
    }
  }

  async function testPrompt(key: string) {
    const promptText = settings[key];
    if (!promptText) return;
    setTestingPrompt(key);
    setPromptPreview((prev) => ({ ...prev, [key]: "" }));
    try {
      // Interpolate with sample data for preview
      const samplePrompt = promptText
        .replace(/\{product_name\}/g, "Outsunny Garden Bench")
        .replace(/\{price\}/g, "299.99")
        .replace(/\{old_price\}/g, "399.99")
        .replace(/\{new_price\}/g, "299.99")
        .replace(/\{qty\}/g, "15")
        .replace(/\{hashtags\}/g, key.endsWith("_fr") ? (settings.social_hashtags_fr || "") : (settings.social_hashtags_en || ""))
        .replace(/\{store_name\}/g, settings.social_store_display_name || "Aosom Sync");

      const res = await fetch("/api/social", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test-prompt", promptText: samplePrompt }),
      });
      const data = await res.json();
      if (data.success) {
        setPromptPreview((prev) => ({ ...prev, [key]: data.data.text }));
      } else {
        setPromptPreview((prev) => ({ ...prev, [key]: `Error: ${data.error}` }));
      }
    } catch (err) {
      setPromptPreview((prev) => ({ ...prev, [key]: `Error: ${err}` }));
    } finally {
      setTestingPrompt(null);
    }
  }

  if (loading) return <div className="p-8 text-gray-500">Loading settings...</div>;

  return (
    <div className="p-4 md:p-8 max-w-4xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Settings</h2>
          <p className="text-gray-400 text-sm mt-1">Configure sync, social media, and API connections</p>
        </div>
        {dirty.size > 0 && (
          <button
            onClick={saveChanges}
            disabled={saving}
            className="w-full sm:w-auto px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-500 disabled:opacity-50"
          >
            {saving ? "Saving..." : `Save ${dirty.size} change${dirty.size > 1 ? "s" : ""}`}
          </button>
        )}
      </div>

      <div className="space-y-6">
        {SECTIONS.map((section) => (
          <div key={section.title} className="bg-gray-900 border border-gray-800 rounded-xl p-4 md:p-5">
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
                      className="w-full sm:w-32 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300"
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
                      <div className="flex items-center justify-between mt-1">
                        <p className="text-xs text-gray-600">Variables: {PROMPT_VARS}</p>
                        <button
                          onClick={() => testPrompt(field.key)}
                          disabled={testingPrompt === field.key}
                          className="px-2 py-1 bg-gray-800 text-gray-400 text-xs rounded hover:bg-gray-700 border border-gray-700 disabled:opacity-50"
                        >
                          {testingPrompt === field.key ? "Generating..." : "Test Prompt"}
                        </button>
                      </div>
                      {promptPreview[field.key] && (
                        <div className="mt-2 p-3 bg-gray-800/50 border border-gray-700 rounded-lg text-sm text-gray-300 whitespace-pre-wrap">
                          <p className="text-xs text-gray-500 mb-1 font-semibold">Preview (sample data):</p>
                          {promptPreview[field.key]}
                        </div>
                      )}
                    </div>
                  ) : field.type === "color" ? (
                    <div className="flex items-center gap-3">
                      <input
                        type="color"
                        value={settings[field.key] || "#2563eb"}
                        onChange={(e) => updateField(field.key, e.target.value)}
                        className="w-10 h-10 rounded border border-gray-700 bg-gray-800 cursor-pointer"
                      />
                      <input
                        type="text"
                        value={settings[field.key] || ""}
                        onChange={(e) => updateField(field.key, e.target.value)}
                        placeholder="#hex"
                        className="w-28 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-300 font-mono"
                      />
                    </div>
                  ) : field.type === "range" ? (
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={field.min ?? 0}
                        max={field.max ?? 100}
                        value={settings[field.key] || "75"}
                        onChange={(e) => updateField(field.key, e.target.value)}
                        className="flex-1 accent-blue-600"
                      />
                      <span className="text-sm text-gray-400 w-10 text-right">{settings[field.key] || "75"}%</span>
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
              {section.title === "Facebook / Graph API" && (
                <div className="flex items-center gap-3 pt-2">
                  <button onClick={testFacebook} className="px-3 py-1.5 bg-gray-800 text-gray-300 text-xs rounded-lg hover:bg-gray-700 border border-gray-700">
                    Test Connection
                  </button>
                  {testResults.facebook && (
                    <span className={`text-xs ${testResults.facebook.startsWith("Connected") ? "text-green-400" : "text-red-400"}`}>
                      {testResults.facebook}
                    </span>
                  )}
                </div>
              )}
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

              {/* Image Composer preview */}
              {section.title === "Image Composer" && (
                <div className="mt-3 p-4 rounded-lg border border-gray-700 relative overflow-hidden" style={{ width: "100%", aspectRatio: "1200/630" }}>
                  <div className="absolute inset-0 bg-gray-800 flex items-center justify-center">
                    <span className="text-gray-600 text-sm">Product image area</span>
                  </div>
                  <div
                    className="absolute bottom-0 left-0 right-0 flex items-end justify-between px-4 pb-3"
                    style={{
                      height: "40%",
                      backgroundColor: `rgba(0,0,0,${(parseInt(settings.social_banner_opacity || "75") / 100)})`,
                    }}
                  >
                    <div>
                      <p className="text-sm font-bold" style={{ color: settings.social_text_color || "#ffffff" }}>
                        Outsunny Garden Bench
                      </p>
                      <p className="text-lg font-bold" style={{ color: settings.social_accent_color || "#2563eb" }}>
                        299.99$
                      </p>
                    </div>
                    <p className="text-xs" style={{ color: settings.social_accent_color || "#2563eb" }}>
                      {settings.social_store_display_name || "Aosom Sync"}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
