/**
 * Social tools (scope `social`): generate post DRAFTS and review them.
 *
 * These reuse the dashboard's generators (job4-social: bilingual copy + the verified lifestyle
 * photo), so the same rules apply — no white-background photos, repost cooldown, no supplier names.
 * They only ever create drafts (`facebook_drafts.status = 'draft'`): approving, scheduling and
 * publishing stay in Aosom-sync → Social, where Mat reviews. There is deliberately no approve tool.
 * Cap: 15 generated drafts per rolling 24 h across all MCP connections (each costs LLM tokens).
 */
import type { Db, ToolDef } from "@/lib/mcp/tools";

export const MAX_DRAFTS_PER_DAY = 15;
export const MAX_DRAFTS_PER_CALL = 3;

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const clamp = (v: unknown, def: number, min: number, max: number) => Math.min(Math.max(Math.trunc(num(v) ?? def), min), max);

async function select(db: Db, sql: string, args: (string | number)[] = []): Promise<Record<string, unknown>[]> {
  return (await db.execute({ sql, args })).rows as Record<string, unknown>[];
}

const REVIEW_NOTE = "Brouillons seulement : pour les approuver ou les planifier, va dans Aosom-sync → Social (je ne peux pas les approuver).";

export const SOCIAL_TOOLS: ToolDef[] = [
  {
    scope: "social",
    name: "social_categories",
    description: "Categories a social post can be drawn from (key + label + how many products have a validated lifestyle photo). Use the key in social_generate.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const { SOCIAL_CATEGORIES } = await import("@/lib/social-categories");
      return { categories: SOCIAL_CATEGORIES.map((c) => ({ key: c.key, label: c.label, products_with_lifestyle_photo: c.measuredLifestylePool })) };
    },
  },
  {
    scope: "social",
    name: "social_generate",
    description:
      "Generate social media post DRAFT(S) (French + English caption + the product's lifestyle photo). `kind`: 'highlight' = pick product(s) " +
      "from a category (1-3), 'new_product' = a post for one SKU, 'price_drop' = a post for one SKU with old/new price. Creates drafts only — " +
      `nothing is published or scheduled; the user approves in Aosom-sync → Social. Max ${MAX_DRAFTS_PER_DAY} drafts per 24 h.`,
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["highlight", "new_product", "price_drop"] },
        count: { type: "number", description: `highlight only, 1-${MAX_DRAFTS_PER_CALL}, default 1` },
        category: { type: "string", description: "highlight only: a key from social_categories (default: seasonal default / all)" },
        sku: { type: "string", description: "new_product / price_drop: an Aosom SKU already on the store" },
        old_price: { type: "number" }, new_price: { type: "number" },
      },
      required: ["kind"],
    },
    handler: async (db, a) => {
      const kind = a.kind;
      if (kind !== "highlight" && kind !== "new_product" && kind !== "price_drop") throw new Error("kind doit être highlight, new_product ou price_drop");
      const want = kind === "highlight" ? clamp(a.count, 1, 1, MAX_DRAFTS_PER_CALL) : 1;

      const [{ n }] = await select(db, `SELECT COUNT(*) AS n FROM cron_runs WHERE name = 'mcp-social' AND ran_at > ?`, [Math.floor(Date.now() / 1000) - 86400]);
      if (Number(n) + want > MAX_DRAFTS_PER_DAY) throw new Error(`Plafond atteint : ${MAX_DRAFTS_PER_DAY} brouillons par 24 h via MCP (${n} déjà faits)`);

      const job = await import("@/jobs/job4-social");
      let drafts: { draftId: number; postText: string; postTextEn: string; imageUrl: string | null }[] = [];
      let note: string | undefined;

      if (kind === "highlight") {
        const category = typeof a.category === "string" && a.category ? a.category : null;
        if (category) {
          const { isValidCategory } = await import("@/lib/social-categories");
          if (!isValidCategory(category)) throw new Error(`Catégorie inconnue : ${category} (voir social_categories)`);
        }
        const run = await job.runStockHighlight(want, category);
        drafts = run.drafts;
        if (drafts.length === 0) {
          note = run.emptyReason === "cooldown"
            ? `Tous les produits de cette catégorie ont déjà un post récent (${run.cooldownDays} jours).`
            : "Aucun produit avec photo lifestyle validée dans cette catégorie (jamais d'image fond blanc).";
        }
      } else {
        const sku = typeof a.sku === "string" ? a.sku.trim().slice(0, 60) : "";
        if (!sku) throw new Error("sku requis");
        const own = await select(db, `SELECT shopify_product_id FROM products WHERE sku = ?`, [sku]);
        if (!own[0]) throw new Error("SKU introuvable");
        if (!own[0].shopify_product_id) throw new Error("Ce produit n'est pas encore importé : rien à promouvoir");
        let r = null;
        if (kind === "new_product") r = await job.triggerNewProduct(sku);
        else {
          const oldPrice = num(a.old_price), newPrice = num(a.new_price);
          if (oldPrice === undefined || newPrice === undefined || newPrice >= oldPrice) throw new Error("old_price et new_price requis, avec new_price < old_price");
          r = await job.triggerPriceDrop(sku, oldPrice, newPrice);
        }
        if (r) drafts = [r];
        else note = "Pas de photo lifestyle validée pour ce produit : post ignoré (jamais d'image fond blanc).";
      }

      const now = Math.floor(Date.now() / 1000);
      for (const d of drafts) {
        await db.execute({ sql: `INSERT INTO cron_runs (name, status, detail, ran_at) VALUES ('mcp-social', 'success', ?, ?)`, args: [`draft=${d.draftId}`, now] });
      }
      return {
        created: drafts.length,
        drafts: drafts.map((d) => ({ draft_id: d.draftId, post_fr: d.postText, post_en: d.postTextEn, image_url: d.imageUrl })),
        note,
        review: REVIEW_NOTE,
      };
    },
  },
  {
    scope: "social",
    name: "social_drafts",
    description: "Recent social post drafts (any origin) to review: id, product, type, status, caption, photo. Newest first.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["draft", "approved", "published", "rejected"], description: "Default draft" },
        limit: { type: "number", description: "1-15, default 8" },
      },
    },
    handler: async (db, a) => {
      const status = ["draft", "approved", "published", "rejected"].includes(String(a.status)) ? String(a.status) : "draft";
      const rows = await select(db,
        `SELECT id, sku, trigger_type, status, language, substr(post_text, 1, 600) AS post_text, image_url, datetime(created_at, 'unixepoch') AS created_utc
           FROM facebook_drafts WHERE status = ? ORDER BY created_at DESC LIMIT ${clamp(a.limit, 8, 1, 15)}`, [status]);
      return { status, drafts: rows, review: REVIEW_NOTE };
    },
  },
];
