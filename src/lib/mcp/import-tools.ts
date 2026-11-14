/**
 * Import tools (scope `import`): preview, then confirm. The ONLY MCP tools that write.
 *
 * `import_preview` touches nothing: it reads the catalogue, flags problems and returns a signed,
 * 15-minute `plan_id` bound to the exact SKU list. `import_confirm` takes that plan_id — a model
 * cannot import something nobody previewed — and runs the same pipeline as the dashboard
 * (queueForImport → generateContent → importToShopify), so every existing gate applies
 * (clean image, French copy, no supplier-name leak) and the product goes live like any Aosom import.
 *
 * Guardrails: max 5 SKUs per plan, max 20 imports per rolling 24 h across all MCP connections,
 * each attempt logged in cron_runs ('mcp-import') and summarised in a dashboard notification.
 * Costway is not importable here (its importer is a gated script with its own isolation rules).
 */
import crypto from "node:crypto";
import type { Db, ToolDef } from "@/lib/mcp/tools";

export const MAX_SKUS_PER_PLAN = 5;
export const MAX_IMPORTS_PER_DAY = 20;
const PLAN_TTL_SEC = 15 * 60;
const TIME_BUDGET_MS = 230_000;

function secret(): string {
  const s = process.env.SESSION_SECRET?.trim();
  if (!s) throw new Error("SESSION_SECRET is required to sign import plans");
  return s;
}
const mac = (payload: string) => crypto.createHmac("sha256", secret()).update(payload).digest("base64url");

export function signPlan(skus: string[], now = Math.floor(Date.now() / 1000)): string {
  const payload = Buffer.from(JSON.stringify({ skus: [...skus].sort(), exp: now + PLAN_TTL_SEC })).toString("base64url");
  return `${payload}.${mac(payload)}`;
}

export function verifyPlan(planId: string, now = Math.floor(Date.now() / 1000)): string[] {
  const [payload, sig] = planId.split(".");
  if (!payload || !sig) throw new Error("plan_id invalide");
  const expected = Buffer.from(mac(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) throw new Error("plan_id invalide");
  const { skus, exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { skus: string[]; exp: number };
  if (!Array.isArray(skus) || skus.length === 0 || skus.length > MAX_SKUS_PER_PLAN) throw new Error("plan_id invalide");
  if (exp < now) throw new Error("plan_id expiré — relance import_preview");
  return skus;
}

function cleanSkus(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error("skus doit être une liste");
  const skus = [...new Set(raw.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean))];
  if (skus.length === 0) throw new Error("Aucun SKU fourni");
  if (skus.length > MAX_SKUS_PER_PLAN) throw new Error(`Maximum ${MAX_SKUS_PER_PLAN} SKU par demande`);
  if (skus.some((s) => s.length > 60)) throw new Error("SKU invalide");
  return skus;
}

async function select(db: Db, sql: string, args: (string | number)[]): Promise<Record<string, unknown>[]> {
  return (await db.execute({ sql, args })).rows as Record<string, unknown>[];
}

export const IMPORT_TOOLS: ToolDef[] = [
  {
    scope: "import",
    name: "import_preview",
    description:
      `Step 1 of 2 — NOTHING is created. Checks 1 to ${MAX_SKUS_PER_PLAN} Aosom SKUs (the SKU of any colour/size variant; variants of the same ` +
      "product are merged into one listing) and returns, per SKU, whether it can be imported, plus a `plan_id` valid 15 minutes. " +
      "Show the preview to the user and get their explicit OK before calling import_confirm. Aosom only (not Costway).",
    inputSchema: { type: "object", properties: { skus: { type: "array", items: { type: "string" }, description: `1-${MAX_SKUS_PER_PLAN} Aosom SKUs` } }, required: ["skus"] },
    handler: async (db, a) => {
      const skus = cleanSkus(a.skus);
      const found = await select(db,
        `SELECT sku, name, price, qty, color, product_type, shopify_product_id FROM products WHERE sku IN (${skus.map(() => "?").join(",")})`, skus);
      const bySku = new Map(found.map((r) => [String(r.sku), r]));
      const items = [];
      let importable = 0;
      for (const sku of skus) {
        const r = bySku.get(sku);
        if (!r) {
          const cw = await select(db, `SELECT item_no FROM costway_products WHERE sku = ? OR item_no = ? LIMIT 1`, [sku, sku]);
          items.push({ sku, status: "refused", reason: cw[0] ? "Produit Costway : import via le script Costway, pas ici" : "SKU introuvable dans le catalogue Aosom" });
          continue;
        }
        if (r.shopify_product_id) { items.push({ sku, status: "refused", reason: "Déjà importé", shopify_product_id: r.shopify_product_id }); continue; }
        const warnings = [];
        if (Number(r.qty) <= 0) warnings.push("Rupture de stock chez le fournisseur");
        importable++;
        items.push({ sku, status: "ok", title_en: r.name, price: r.price, qty: r.qty, color: r.color, category: r.product_type, warnings });
      }
      const importableSkus = items.filter((i) => i.status === "ok").map((i) => i.sku);
      return {
        importable,
        items,
        plan_id: importableSkus.length ? signPlan(importableSkus) : null,
        next: importableSkus.length
          ? "Montre cet aperçu à l'utilisateur. S'il confirme, appelle import_confirm avec ce plan_id. Le produit sera mis EN LIGNE immédiatement."
          : "Rien à importer.",
      };
    },
  },
  {
    scope: "import",
    name: "import_confirm",
    description:
      "Step 2 of 2 — creates the products on Shopify (LIVE immediately, same as a dashboard import): generates the French copy, runs the quality " +
      "gates, pushes. Requires the `plan_id` from import_preview AND the user's explicit confirmation. Can take a few minutes; if it reports " +
      "`not_started` items, call it again with the same plan_id.",
    inputSchema: { type: "object", properties: { plan_id: { type: "string" } }, required: ["plan_id"] },
    handler: async (db, a) => {
      const skus = verifyPlan(typeof a.plan_id === "string" ? a.plan_id : "");
      const [{ n }] = await select(db, `SELECT COUNT(*) AS n FROM cron_runs WHERE name = 'mcp-import' AND ran_at > ?`, [Math.floor(Date.now() / 1000) - 86400]);
      if (Number(n) + skus.length > MAX_IMPORTS_PER_DAY) {
        throw new Error(`Plafond atteint : ${MAX_IMPORTS_PER_DAY} imports par 24 h via MCP (${n} déjà faits)`);
      }

      // Heavy dependencies only when actually importing (keeps the read-only paths light).
      const { queueForImport, generateContent, importToShopify } = await import("@/lib/import-pipeline");
      const { createNotification } = await import("@/lib/database");

      const started = Date.now();
      const queued = await queueForImport(skus);
      const results: Record<string, unknown>[] = queued.skipped.map((s) => ({ sku: s.sku, outcome: "skipped", reason: s.reason }));
      for (const job of queued.jobs) {
        if (Date.now() - started > TIME_BUDGET_MS) { results.push({ group: job.groupKey, outcome: "not_started" }); continue; }
        try {
          await generateContent(job.id);
          const done = await importToShopify(job.id);
          results.push({ group: job.groupKey, outcome: done.status, shopify_product_id: done.shopifyId, error: done.error });
        } catch (e) {
          results.push({ group: job.groupKey, outcome: "error", error: e instanceof Error ? e.message.slice(0, 200) : "error" });
        }
      }

      const imported = results.filter((r) => r.outcome === "done" || r.outcome === "already_imported").length;
      const now = Math.floor(Date.now() / 1000);
      for (const sku of skus) {
        await db.execute({ sql: `INSERT INTO cron_runs (name, status, detail, ran_at) VALUES ('mcp-import', ?, ?, ?)`, args: [imported ? "success" : "error", `sku=${sku}`, now] });
      }
      await createNotification("mcp_import", "Import via MCP", `${imported}/${queued.jobs.length} produit(s) importé(s) : ${skus.join(", ")}`).catch(() => undefined);
      return { requested: skus, imported, results };
    },
  },
];
