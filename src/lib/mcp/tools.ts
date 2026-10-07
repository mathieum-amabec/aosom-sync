/**
 * Read-only tools of the aosom-sync MCP server (Claude Desktop / Claude Code).
 *
 * Every tool is a bounded SELECT: no writes, no Shopify call, no LLM call. The server opens its
 * OWN libsql client (not database.ts' ensureSchema, which runs DDL), and `run` below refuses
 * anything that is not a single SELECT/WITH/PRAGMA-free statement. Turso bills per row READ, so
 * each tool caps its result size and prefers indexed predicates (FTS, PK, status columns).
 *
 * Writes (import, publish, drafts) are deliberately NOT here: they will be added later behind an
 * explicit confirmation step.
 */
import { toFtsQuery } from "@/lib/catalog-filters";
import type { Scope } from "@/lib/mcp/scopes";
import { ANALYTICS_TOOLS } from "@/lib/mcp/analytics-tools";
import { MORNING_REPORT_LAST_KEY, parseStoredReport } from "@/lib/morning-report-store";

export interface Db {
  execute(stmt: { sql: string; args?: (string | number)[] }): Promise<{ rows: unknown[] }>;
}

export interface ToolDef {
  /** Permission required to list and call this tool. */
  scope: Scope;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (db: Db, args: Record<string, unknown>) => Promise<unknown>;
}

const MAX_LIMIT = 25;
const READ_ONLY_RE = /^\s*(select|with)\b/i;

/** Single read-only statement runner — the only way a tool touches the database. */
async function run(db: Db, sql: string, args: (string | number)[] = []): Promise<Record<string, unknown>[]> {
  if (!READ_ONLY_RE.test(sql) || sql.trim().replace(/;\s*$/, "").includes(";")) {
    throw new Error("MCP tools are read-only: only a single SELECT is allowed");
  }
  return (await db.execute({ sql, args })).rows as Record<string, unknown>[];
}

const str = (v: unknown, max = 120): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const lim = (v: unknown): number => Math.min(Math.max(Math.trunc(num(v) ?? 10), 1), MAX_LIMIT);
const listing = (v: unknown): "listed" | "unlisted" | "all" => (v === "listed" || v === "unlisted" ? v : "all");
const LISTED_SQL = `(shopify_product_id IS NOT NULL AND shopify_product_id <> '')`;
const toLike = (s: string) => `%${s.replace(/[!%_]/g, (c) => `!${c}`)}%`;

async function searchAosom(db: Db, a: Record<string, unknown>) {
  const q = str(a.query);
  const conds: string[] = [];
  const args: (string | number)[] = [];
  const fts = q ? toFtsQuery(q) : null;
  if (fts) { conds.push(`rowid IN (SELECT rowid FROM products_fts WHERE products_fts MATCH ?)`); args.push(fts); }
  const l = listing(a.listing);
  if (l === "listed") conds.push(LISTED_SQL);
  if (l === "unlisted") conds.push(`NOT ${LISTED_SQL}`);
  if (a.in_stock === true) conds.push(`qty > 0`);
  const cat = str(a.category, 80);
  if (cat) { conds.push(`product_type LIKE ? ESCAPE '!'`); args.push(`${cat.replace(/[!%_]/g, (c) => `!${c}`)}%`); }
  const min = num(a.min_price), max = num(a.max_price);
  if (min !== undefined) { conds.push(`price >= ?`); args.push(min); }
  if (max !== undefined) { conds.push(`price <= ?`); args.push(max); }
  const limit = lim(a.limit);
  const sql = (where: string[]) =>
    `SELECT sku, name, price, qty, color, product_type, shopify_product_id, shopify_handle FROM products
     ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY qty DESC, name ASC LIMIT ${limit}`;
  let rows = await run(db, sql(conds), args);
  // FTS matches whole-token prefixes; one LIKE fallback (a full scan of ~12k rows) only on a miss.
  if (rows.length === 0 && q && fts) {
    const c2 = conds.filter((c) => !c.startsWith("rowid IN"));
    c2.push(`name LIKE ? ESCAPE '!'`);
    const a2 = [...args.slice(1), toLike(q)];
    rows = await run(db, sql(c2), a2);
  }
  return rows.map((r) => ({
    supplier: "aosom", sku: r.sku, title_en: r.name, price: r.price, qty: r.qty, color: r.color, category: r.product_type,
    listed: !!r.shopify_product_id, shopify_product_id: r.shopify_product_id || null, handle: r.shopify_handle || null,
  }));
}

async function searchCostway(db: Db, a: Record<string, unknown>) {
  const q = str(a.query);
  const conds: string[] = [`removed_at IS NULL`];
  const args: (string | number)[] = [];
  if (q) { conds.push(`(title LIKE ? ESCAPE '!' OR item_no = ?)`); args.push(toLike(q), q); }
  const l = listing(a.listing);
  if (l === "listed") conds.push(LISTED_SQL);
  if (l === "unlisted") conds.push(`NOT ${LISTED_SQL}`);
  if (a.in_stock === true) conds.push(`qty >= 3`);
  const cat = str(a.category, 80);
  if (cat) { conds.push(`(product_type LIKE ? ESCAPE '!' OR top_category LIKE ? ESCAPE '!')`); const c = `${cat.replace(/[!%_]/g, (x) => `!${x}`)}%`; args.push(c, c); }
  const min = num(a.min_price), max = num(a.max_price);
  if (min !== undefined) { conds.push(`price >= ?`); args.push(min); }
  if (max !== undefined) { conds.push(`price <= ?`); args.push(max); }
  const rows = await run(db,
    `SELECT item_no, MIN(title) AS title, MIN(top_category) AS top_category, MIN(product_type) AS product_type,
            MIN(price) AS price_from, MAX(price) AS price_to, COUNT(*) AS variants, SUM(qty) AS qty,
            MAX(shopify_product_id) AS shopify_product_id, MAX(import_status) AS import_status, MAX(sell_price) AS sell_price
       FROM costway_products WHERE ${conds.join(" AND ")} GROUP BY item_no ORDER BY qty DESC LIMIT ${lim(a.limit)}`, args);
  return rows.map((r) => ({
    supplier: "costway", item_no: r.item_no, title_en: r.title, category: r.product_type || r.top_category,
    feed_price_from: r.price_from, feed_price_to: r.price_to, variants: r.variants, qty: r.qty,
    listed: !!r.shopify_product_id, shopify_product_id: r.shopify_product_id || null, import_status: r.import_status || null,
    our_price: r.sell_price ?? null,
  }));
}

export const READ_TOOLS: ToolDef[] = [
  {
    scope: "read",
    name: "search_products",
    description:
      "Search the catalogue of Aosom and/or Costway products (English supplier titles). `listing`: 'listed' = already on the Shopify store " +
      "(imported), 'unlisted' = in the supplier feed but not imported, 'all'. Returns at most 25 rows. Titles here are the supplier's English " +
      "titles, not our French store titles.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to search in the product name (e.g. 'patio table')" },
        supplier: { type: "string", enum: ["aosom", "costway", "all"], description: "Default all" },
        listing: { type: "string", enum: ["listed", "unlisted", "all"], description: "Default all" },
        in_stock: { type: "boolean", description: "Only products with sellable stock" },
        category: { type: "string", description: "Category prefix, e.g. 'Patio & Garden'" },
        min_price: { type: "number" }, max_price: { type: "number" },
        limit: { type: "number", description: "1-25, default 10" },
      },
    },
    handler: async (db, a) => {
      const s = a.supplier === "aosom" || a.supplier === "costway" ? a.supplier : "all";
      const [aosom, costway] = await Promise.all([
        s !== "costway" ? searchAosom(db, a) : Promise.resolve([]),
        s !== "aosom" ? searchCostway(db, a) : Promise.resolve([]),
      ]);
      return { count: aosom.length + costway.length, results: [...aosom, ...costway] };
    },
  },
  {
    scope: "read",
    name: "get_product",
    description: "Full catalogue record of one Aosom SKU, or one Costway item_no / SKU, including its Shopify link and import status.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Aosom SKU, Costway item_no or Costway SKU" } }, required: ["id"] },
    handler: async (db, a) => {
      const id = str(a.id, 80);
      if (!id) throw new Error("id is required");
      const aosom = await run(db,
        `SELECT sku, name, price, qty, color, size, product_type, image1, shopify_product_id, shopify_handle, created_at, last_seen_at
           FROM products WHERE sku = ? LIMIT 1`, [id]);
      if (aosom[0]) return { supplier: "aosom", ...aosom[0] };
      const cw = await run(db,
        `SELECT sku, item_no, title, category, color, price, price_drop, qty, us_qty, ca_qty, in_stock, shopify_product_id, shopify_handle,
                internal_sku, import_status, import_batch, sell_price, imported_at, removed_at
           FROM costway_products WHERE item_no = ? OR sku = ? ORDER BY sku LIMIT 40`, [id, id]);
      if (cw.length) return { supplier: "costway", variants: cw };
      return { found: false, id };
    },
  },
  {
    scope: "read",
    name: "catalog_overview",
    description: "Counts: Aosom and Costway products, how many are listed on Shopify, how many in stock.",
    inputSchema: { type: "object", properties: {} },
    handler: async (db) => {
      const [a] = await run(db, `SELECT COUNT(*) AS total, SUM(${LISTED_SQL}) AS listed, SUM(qty > 0) AS in_stock FROM products`);
      const [c] = await run(db, `SELECT COUNT(*) AS variants, COUNT(DISTINCT item_no) AS products, SUM(${LISTED_SQL}) AS listed_variants, SUM(qty >= 3) AS sellable_variants FROM costway_products WHERE removed_at IS NULL`);
      return { aosom: a, costway: c };
    },
  },
  {
    scope: "read",
    name: "import_queue",
    description: "Aosom import jobs by status (pending / generating / reviewing / importing / done / failed) plus the 10 most recently updated.",
    inputSchema: { type: "object", properties: {} },
    handler: async (db) => ({
      by_status: await run(db, `SELECT status, COUNT(*) AS n FROM import_jobs GROUP BY status ORDER BY n DESC`),
      latest: await run(db, `SELECT id, group_key, status, shopify_id, substr(COALESCE(error,''),1,160) AS error, updated_at FROM import_jobs ORDER BY updated_at DESC LIMIT 10`),
    }),
  },
  {
    scope: "read",
    name: "llm_budget",
    description: "LLM tokens used per budget pool (assistant / batch / video / maintenance) for the last 3 days.",
    inputSchema: { type: "object", properties: {} },
    handler: async (db) => ({
      rows: await run(db, `SELECT day, pool, tokens_used FROM daily_llm_budget ORDER BY day DESC, pool LIMIT 16`),
    }),
  },
  {
    scope: "read",
    name: "recent_cron_runs",
    description: "Most recent scheduled-job runs (name, status, detail, time) to check that sync / publisher / price jobs are healthy. Optional `name` filter.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, limit: { type: "number", description: "1-25, default 10" } } },
    handler: async (db, a) => {
      const name = str(a.name, 60);
      return {
        runs: await run(db,
          `SELECT name, status, substr(COALESCE(detail,''),1,200) AS detail, datetime(ran_at,'unixepoch') AS ran_at_utc
             FROM cron_runs ${name ? "WHERE name = ?" : ""} ORDER BY ran_at DESC LIMIT ${lim(a.limit)}`, name ? [name] : []),
      };
    },
  },
];

/**
 * The daily morning report, READ from where the 06:00 cron stored it (one SELECT on `settings`): no Meta call, no email provider.
 * This is how the report is reached when the email never arrives, and what a scheduled agent fetches to deliver it elsewhere.
 */
const REPORT_TOOL: ToolDef = {
  scope: "read",
  name: "morning_report",
  description:
    "The latest morning report (the daily 06:00 Montréal digest: Meta ads, guides, videos, Reels and photo results, alerts, guards), as plain text. " +
    "Returns the date it is for, how old it is, and any section that was unavailable. Built once a day by the 06:00 job.",
  inputSchema: { type: "object", properties: {} },
  handler: async (db) => {
    const [row] = await run(db, `SELECT value FROM settings WHERE key = ?`, [MORNING_REPORT_LAST_KEY]);
    const report = parseStoredReport(row?.value);
    if (!report) return { available: false, message: "Aucun rapport du matin n'a encore été enregistré (le premier est construit à 06:00, heure de Montréal)." };
    const ageHours = report.generatedAt ? Math.round((Date.now() - Date.parse(report.generatedAt)) / 3_600_000) : null;
    return {
      available: true,
      date: report.date,
      subject: report.subject,
      generated_at: report.generatedAt,
      age_hours: ageHours,
      missing_sections: report.missingSections,
      text: report.text,
    };
  },
};

/** Everything the database-only server can offer (read + analytics). Import tools live in import-tools.ts. */
export const TOOLS: ToolDef[] = [...READ_TOOLS, REPORT_TOOL, ...ANALYTICS_TOOLS];
