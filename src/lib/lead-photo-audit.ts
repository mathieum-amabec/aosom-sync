/**
 * Daily read-only guard on the LEAD photo of live products (Mat, 2026-11-19: "la première image n'est pas une lifestyle
 * tandis qu'il y en a une de disponible… trouve une façon que tout ça n'arrive plus").
 *
 * Why a guard: new imports are covered at creation (`whole_product` in auto-import/verify.ts, `enforceCleanPrimaryImage`),
 * but nothing watched the products already live, so a regression in the importer — or a gallery rewritten by another job —
 * stayed invisible until a customer saw it. The 2026-11-19 catalogue pass found ~58 % of the garden products leading with a
 * white packshot while a clean lifestyle sat further down the gallery.
 *
 * What it checks (0 token, 0 Shopify write — it only reads the `image_styles` cache that the 4-hourly `image-styles` cron
 * fills): for every active product, the style of the gallery's first photo and of the DEFAULT variant's photo (what the page
 * actually opens on), and whether a lifestyle photo exists elsewhere in the gallery.
 *
 * Red only for what must NEVER happen again: a product imported in the last NEW_DAYS days whose gallery lead is a studio
 * packshot although a lifestyle photo is in the gallery. The older backlog (multi-colour packshots, ~1,100 products) is
 * reported as numbers, not as an alert — it is fixed by `scripts/curate-top-photos.mts`, and an alert that is red every day
 * for weeks teaches everyone to ignore it. A photo whose style is not cached yet is "unknown": never counted as a defect.
 */
import { imageUrlStem } from "./image-compliance-audit";
import { getCachedImageStyles, setSetting } from "./database";
import { fetchShopifyFeedProducts, type ShopifyFeedProduct } from "./feeds/source";
import type { AdImageStyle } from "./image-style";

export const LEAD_PHOTO_SETTING = "lead_photo_audit";
/** A product younger than this must already follow the curated pattern. */
export const NEW_DAYS = 14;
const MAX_EXAMPLES = 15;

export interface LeadPhotoAudit {
  auditedAt: number;
  products: number;
  /** Gallery lead style counts (position 1). */
  galleryLead: { lifestyle: number; studio: number; unknown: number };
  /** Style of the photo the page opens on (default variant's own photo, else the gallery lead). */
  pageLead: { lifestyle: number; studio: number; unknown: number };
  /** Gallery lead is a studio packshot although the gallery holds a lifestyle photo. */
  fixable: number;
  /** The same, for products created in the last NEW_DAYS days — the red condition. */
  newFixable: number;
  examples: Array<{ handle: string; createdAt: string | null; isNew: boolean }>;
  ok: boolean;
  reasons: string[];
}

export interface LeadPhotoDeps {
  products: () => Promise<ShopifyFeedProduct[]>;
  styles: (stems: string[]) => Promise<Map<string, AdImageStyle>>;
  now: () => Date;
}

export const productionLeadPhotoDeps: LeadPhotoDeps = {
  products: fetchShopifyFeedProducts,
  styles: getCachedImageStyles,
  now: () => new Date(),
};

type Counts = { lifestyle: number; studio: number; unknown: number };
const bump = (c: Counts, s: AdImageStyle | undefined) => { c[s ?? "unknown"]++; };

export async function runLeadPhotoAudit(deps: LeadPhotoDeps = productionLeadPhotoDeps): Promise<LeadPhotoAudit> {
  const now = deps.now();
  const products = (await deps.products()).filter((p) => p.status === "active" && (p.images?.length ?? 0) > 0);
  const stemOf = (src: string | undefined) => (src ? imageUrlStem(src) : "");
  const styles = await deps.styles(products.flatMap((p) => (p.images ?? []).map((i) => stemOf(i.src))).filter(Boolean));

  const galleryLead: Counts = { lifestyle: 0, studio: 0, unknown: 0 };
  const pageLead: Counts = { lifestyle: 0, studio: 0, unknown: 0 };
  let fixable = 0, newFixable = 0;
  const examples: LeadPhotoAudit["examples"] = [];
  const cutoff = now.getTime() - NEW_DAYS * 86_400_000;

  for (const p of products) {
    const imgs = p.images ?? [];
    const lead = styles.get(stemOf(imgs[0]?.src));
    bump(galleryLead, lead);
    // The page opens on the default (first) variant's own photo when it has one.
    const v0 = p.variants?.[0];
    const own = v0?.image_id != null ? imgs.find((i) => String(i.id) === String(v0.image_id)) : undefined;
    bump(pageLead, own ? styles.get(stemOf(own.src)) : lead);

    if (lead === "studio" && imgs.some((i, k) => k > 0 && styles.get(stemOf(i.src)) === "lifestyle")) {
      fixable++;
      const created = p.created_at ? Date.parse(p.created_at) : NaN;
      const isNew = Number.isFinite(created) && created >= cutoff;
      if (isNew) newFixable++;
      if (examples.length < MAX_EXAMPLES && (isNew || examples.every((e) => !e.isNew))) examples.push({ handle: p.handle, createdAt: p.created_at ?? null, isNew });
    }
  }

  const reasons: string[] = [];
  if (newFixable > 0) {
    reasons.push(`${newFixable} produit${newFixable > 1 ? "s" : ""} importé${newFixable > 1 ? "s" : ""} depuis ${NEW_DAYS} jours ouvre${newFixable > 1 ? "nt" : ""} sur un fond blanc alors qu'une photo lifestyle existe (ex. ${examples.filter((e) => e.isNew).slice(0, 3).map((e) => e.handle).join(", ")})`);
  }
  return {
    auditedAt: Math.floor(now.getTime() / 1000),
    products: products.length,
    galleryLead, pageLead, fixable, newFixable, examples,
    ok: reasons.length === 0,
    reasons,
  };
}

export async function persistLeadPhotoAudit(result: LeadPhotoAudit): Promise<void> {
  await setSetting(LEAD_PHOTO_SETTING, JSON.stringify(result));
}
