#!/usr/bin/env tsx
/**
 * scripts/force-social-patio.mts
 *
 * One-shot: force-generate N social-media drafts for OUTDOOR/PATIO products,
 * using the exact same logic as the automatic stock-highlight posts (job4-social
 * triggerStockHighlight): lifestyle-verified gate → bilingual FR+EN captions
 * (hook-seeded) → createFacebookDraft (status='draft') → markProductPosted.
 *
 * The drafts land in facebook_drafts with status='draft', so they show up in the
 * /social dashboard for Mat to review + approve (approve is what enqueues them into
 * publication_queue — this script does NOT publish or schedule anything).
 *
 * Selection: products whose product_type maps to the `outdoor_patio` scope
 * (Patio* / Garden* / Outdoor*), imported (shopify_product_id NOT NULL), qty>0,
 * that are lifestyle-verified on Shopify. "Force" = ignores the repost cooldown.
 *
 * Usage (run under node-x64 so libsql/network work on Windows arm64):
 *   node-x64 tsx scripts/force-social-patio.mts            # dry-run: show the 10 picks
 *   node-x64 tsx scripts/force-social-patio.mts --apply    # generate + write drafts
 *   ... [--count N]
 *
 * Env: reads .env.local (PROD Turso + Shopify + Anthropic). Writes to PROD.
 */
import * as dotenv from "dotenv";
import { join } from "node:path";

dotenv.config({ path: join(process.cwd(), ".env.local") });

const APPLY = process.argv.includes("--apply");
const countArg = process.argv.indexOf("--count");
const TARGET = countArg >= 0 ? parseInt(process.argv[countArg + 1], 10) || 10 : 10;
const CANDIDATE_POOL = 80; // patio candidates to sample before the lifestyle gate

function preview(s: string, n = 140): string {
  const flat = (s || "").replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n) + "…" : flat;
}

async function main() {
  // Import after dotenv so any module-level env reads see the loaded values.
  const { createClient } = await import("@libsql/client");
  const { getAllSettings, getProduct, createFacebookDraft, markProductPosted } = await import("@/lib/database");
  const { mapProductTypeToScope, selectHook, buildHookedPrompt, buildHookedPromptEn } = await import("@/lib/hook-selector");
  const { resolveLifestyle } = await import("@/lib/selectors/shopify-images");
  const { getAnthropicClient } = await import("@/lib/content-generator");
  const { cleanSocialCaption } = await import("@/lib/strip-markdown");
  const { CLAUDE, env } = await import("@/lib/config");
  const Anthropic = (await import("@anthropic-ai/sdk")).default;

  if (!process.env.TURSO_DATABASE_URL) throw new Error("TURSO_DATABASE_URL not set (.env.local)");
  if (!process.env.SHOPIFY_ACCESS_TOKEN) throw new Error("SHOPIFY_ACCESS_TOKEN not set (.env.local)");
  if (APPLY && !process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set (.env.local)");

  console.log(`[patio-social] mode=${APPLY ? "APPLY (writes PROD)" : "DRY-RUN"} target=${TARGET}`);
  console.log(`[patio-social] Turso: ${process.env.TURSO_DATABASE_URL?.replace(/\/\/.*@/, "//…@")}`);

  // ── Select patio/outdoor candidates from PROD ─────────────────────────────
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  const res = await db.execute({
    sql: `SELECT sku, name, product_type, shopify_product_id, price, qty
          FROM products
          WHERE shopify_product_id IS NOT NULL AND qty > 0
            AND (product_type LIKE 'Patio%' OR product_type LIKE 'Garden%' OR product_type LIKE 'Outdoor%')
          ORDER BY RANDOM()
          LIMIT ?`,
    args: [CANDIDATE_POOL],
  });
  const candidates = res.rows
    .map((r) => r as unknown as Record<string, unknown>)
    .filter((r) => mapProductTypeToScope(r.product_type as string) === "outdoor_patio");
  console.log(`[patio-social] ${candidates.length} patio candidates (of ${res.rows.length} sampled) after scope filter`);
  if (candidates.length === 0) throw new Error("No patio candidates found — check product_type values");

  const settings = APPLY ? await getAllSettings() : ({} as Record<string, string>);

  // ── Replica of job4-social generateBilingual (verbatim logic) ─────────────
  const ANTHROPIC_CALL_TIMEOUT_MS = 45_000;
  function interpolate(t: string, vars: Record<string, string>): string {
    let r = t;
    for (const [k, v] of Object.entries(vars)) r = r.replace(new RegExp(`\\{${k}\\}`, "g"), v);
    return r;
  }
  async function generatePostText(prompt: string): Promise<string> {
    const client = getAnthropicClient();
    const message = await client.messages.create(
      { model: CLAUDE.MODEL, max_tokens: CLAUDE.MAX_TOKENS_SOCIAL, messages: [{ role: "user", content: prompt }] },
      { signal: AbortSignal.timeout(ANTHROPIC_CALL_TIMEOUT_MS) },
    );
    return message.content[0]?.type === "text" ? cleanSocialCaption(message.content[0].text) : "";
  }
  async function generateBilingual(vars: Record<string, string>, productType: string | null) {
    const frTpl = settings["prompt_highlight_fr"] || "Rédige un post Facebook pour: {product_name}";
    const enTpl = settings["prompt_highlight_en"] || "Write a Facebook post for: {product_name}";
    const frVars = { ...vars, hashtags: settings.social_hashtags_fr || "" };
    const enVars = { ...vars, hashtags: settings.social_hashtags_en || "" };
    let frPrompt = interpolate(frTpl, frVars);
    let enPrompt = interpolate(enTpl, enVars);
    let hookId: number | null = null;
    try {
      const hookFr = await selectHook("FR", productType, null);
      const hookEn = await selectHook("EN", productType, null);
      frPrompt = buildHookedPrompt(interpolate(frTpl, frVars), hookFr);
      enPrompt = buildHookedPromptEn(interpolate(enTpl, enVars), hookEn);
      hookId = hookFr.hookId;
    } catch (e) {
      console.warn(`[patio-social] hook selection failed, using base prompt: ${e}`);
    }
    try {
      const [fr, en] = await Promise.all([generatePostText(frPrompt), generatePostText(enPrompt)]);
      return { fr, en, hookId };
    } catch (err) {
      if (err instanceof Anthropic.APIUserAbortError) {
        await new Promise((r) => setTimeout(r, 5000));
        const [fr, en] = await Promise.all([generatePostText(frPrompt), generatePostText(enPrompt)]);
        return { fr, en, hookId };
      }
      throw err;
    }
  }

  // ── Walk candidates: lifestyle-gate, then generate until TARGET created ────
  let created = 0;
  let checked = 0;
  const results: Array<{ sku: string; name: string; draftId?: number; frPrev: string; enPrev: string }> = [];

  for (const c of candidates) {
    if (created >= TARGET) break;
    checked++;
    const sku = c.sku as string;
    const name = (c.name as string) || sku;
    const shopId = (c.shopify_product_id as string) || "";

    const life = await resolveLifestyle(shopId.trim());
    const lifestyleUrl = life.verified && life.primaryImageUrl ? life.primaryImageUrl : null;
    if (!lifestyleUrl) {
      console.log(`  · skip ${sku} — not lifestyle-verified (or no clean photo) | ${preview(name, 60)}`);
      continue;
    }

    if (!APPLY) {
      created++;
      console.log(`  ✓ [${created}/${TARGET}] ${sku} | ${preview(name, 70)}\n       type=${c.product_type} img=${lifestyleUrl.slice(0, 70)}…`);
      results.push({ sku, name, frPrev: "(dry-run — no caption generated)", enPrev: "" });
      continue;
    }

    // APPLY: same as triggerStockHighlight for this specific SKU.
    const product = await getProduct(sku);
    if (!product) { console.log(`  · skip ${sku} — vanished from catalog`); continue; }
    const { fr, en, hookId } = await generateBilingual(
      { product_name: name, price: String(product.price), qty: String(product.qty), store_name: env.storeName },
      (product.product_type as string) || null,
    );
    if (!fr.trim() || !en.trim()) { console.log(`  · skip ${sku} — empty caption from Claude`); continue; }

    const draftId = await createFacebookDraft({
      sku,
      triggerType: "stock_highlight",
      language: "FR",
      postText: fr,
      postTextEn: en,
      imagePath: lifestyleUrl,
      imageUrl: lifestyleUrl,
      imageUrls: [lifestyleUrl],
      hookId,
    });
    await markProductPosted(sku);
    created++;
    results.push({ sku, name, draftId, frPrev: preview(fr), enPrev: preview(en) });
    console.log(`\n  ✓ [${created}/${TARGET}] draft #${draftId} — ${sku}`);
    console.log(`     TITRE : ${preview(name, 90)}`);
    console.log(`     FR    : ${preview(fr)}`);
    console.log(`     EN    : ${preview(en)}`);
  }

  console.log(`\n[patio-social] ${APPLY ? "created" : "would create"} ${created}/${TARGET} drafts (checked ${checked} candidates).`);
  if (created < TARGET) {
    console.log(`[patio-social] ⚠ only ${created} lifestyle-verified patio products found in the ${candidates.length}-candidate pool. Re-run to sample more, or lower --count.`);
  }
  if (APPLY) {
    console.log(`[patio-social] Drafts are status='draft' in facebook_drafts → visible in /social for approval.`);
    console.log(JSON.stringify(results.map((r) => ({ sku: r.sku, draftId: r.draftId })), null, 0));
  }
  db.close();
}

main().catch((e) => { console.error("[patio-social] FATAL:", e); process.exit(1); });
