/**
 * Which photo belongs to which colour — the single rule shared by the import (attachVariantImages), the Costway
 * importer and the daily variant-photo guard (Mat, 2026-10-18: "la pastille de couleur n'avait aucun rapport avec
 * l'image").
 *
 * Audit 2026-10-18 (1,023 multi-colour products) found the colour photo going wrong in five ways:
 *   1. matched by POSITION — the import attached `images[i]` assuming Shopify returns the gallery in payload order with
 *      nothing dropped; one refused upload shifted every later colour onto its neighbour's photo;
 *   2. a colour took ANY of its feed images already in the gallery — often a lifestyle shot Aosom lists under every
 *      colour, i.e. a photo of another colour;
 *   3. a colour with no photo got the position-1 photo (another colour);
 *   4. products drafted on 2026-09-30 (out of stock) missed the one-off backfill and came back with no colour photos;
 *   5. the backfill matched look-alikes by perceptual hash, which can pick a sibling colour.
 *
 * The rule here: a colour's photo must be one of ITS OWN feed images that no other colour of the product lists
 * ("exclusive"), identified by file name (`imageKey`), primary first. Pure: no I/O.
 */

/** File identity of an image URL: basename without query, extension and the `_<uuid>` Shopify appends on ingest. */
export function imageKey(url: string | null | undefined): string {
  if (!url) return "";
  const base = url.split("?")[0].split("/").pop() ?? "";
  return base
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "")
    .toLowerCase();
}

export interface ColourSource {
  /** Colour label as shown on the store (the option value). */
  colour: string;
  /** Feed images of every SKU of that colour, primary first. Empty = no source (SKU gone from the feed). */
  images: string[];
}

/**
 * Per colour, its EXCLUSIVE images (keys): its own feed images that no other colour lists, primary first. A photo
 * shared by several colours (lifestyle shot, infographic) cannot tell colours apart, so it never counts as a colour's
 * own photo.
 */
export function exclusiveImages(sources: ColourSource[]): Map<string, string[]> {
  const owners = new Map<string, Set<string>>();
  for (const s of sources) for (const u of s.images) {
    const k = imageKey(u);
    if (!k) continue;
    if (!owners.has(k)) owners.set(k, new Set());
    owners.get(k)!.add(s.colour);
  }
  const out = new Map<string, string[]>();
  for (const s of sources) {
    const seen = new Set<string>();
    const mine: string[] = [];
    for (const u of s.images) {
      const k = imageKey(u);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      if (owners.get(k)!.size === 1) mine.push(u);
    }
    out.set(s.colour, [...(out.get(s.colour) ?? []), ...mine]);
  }
  return out;
}

export interface GalleryImage {
  id: number | string;
  src: string;
}

export type ColourPhotoAction =
  | { colour: string; action: "ok"; imageId: number | string }
  | { colour: string; action: "attach"; imageId: number | string; reason: string }
  | { colour: string; action: "upload"; url: string; reason: string }
  | { colour: string; action: "no-source"; reason: string };

export interface ColourPhotoInput {
  colour: string;
  /** The image currently attached to the colour's variants (null = none, or they disagree). */
  currentImageId: number | string | null;
}

/**
 * What each colour needs so the photo shown is that colour's own:
 *   - ok      — its current photo is one of its exclusive images, and no other colour uses it;
 *   - attach  — an exclusive image of it is already in the gallery: attach that one;
 *   - upload  — none is in the gallery: add its primary exclusive image, then attach;
 *   - no-source — the feed has no exclusive image for it (gone from the feed, or only shared shots): leave as is and
 *     report; the current photo cannot be verified from the feed.
 * A current photo whose file is unknown to the feed (renamed by Aosom since import) is left alone ("ok") unless it is
 * another colour's exclusive image or shared with another colour — it is probably right, and the vision audit covers it.
 */
export function planColourPhotos(colours: ColourPhotoInput[], sources: ColourSource[], gallery: GalleryImage[]): ColourPhotoAction[] {
  const excl = exclusiveImages(sources);
  const owner = new Map<string, string>();
  for (const [c, urls] of excl) for (const u of urls) owner.set(imageKey(u), c);
  const allFeedKeys = new Set(sources.flatMap((s) => s.images.map(imageKey)));
  const galleryByKey = new Map<string, GalleryImage>();
  for (const g of gallery) { const k = imageKey(g.src); if (k && !galleryByKey.has(k)) galleryByKey.set(k, g); }
  const srcById = new Map(gallery.map((g) => [String(g.id), g.src]));
  const usage = new Map<string, number>();
  for (const c of colours) if (c.currentImageId != null) usage.set(String(c.currentImageId), (usage.get(String(c.currentImageId)) ?? 0) + 1);

  return colours.map((c): ColourPhotoAction => {
    const mine = excl.get(c.colour) ?? [];
    const curSrc = c.currentImageId != null ? srcById.get(String(c.currentImageId)) : undefined;
    const curKey = imageKey(curSrc);
    const shared = c.currentImageId != null && (usage.get(String(c.currentImageId)) ?? 0) > 1;
    const curOwner = curKey ? owner.get(curKey) : undefined;

    let problem: string | null = null;
    if (c.currentImageId == null || !curSrc) problem = "aucune photo";
    // Its own exclusive photo is right even when a colour without a source borrows it: that one is reported, not this.
    else if (curOwner === c.colour) return { colour: c.colour, action: "ok", imageId: c.currentImageId };
    else if (curOwner) problem = `photo de « ${curOwner} »`;
    else if (shared) problem = "photo partagée avec une autre couleur";
    else if (allFeedKeys.has(curKey)) problem = "photo commune à plusieurs couleurs";
    else return { colour: c.colour, action: "ok", imageId: c.currentImageId }; // unknown to the feed: not judged here

    if (mine.length === 0) return { colour: c.colour, action: "no-source", reason: problem };
    for (const u of mine) {
      const g = galleryByKey.get(imageKey(u));
      if (g) return { colour: c.colour, action: "attach", imageId: g.id, reason: problem };
    }
    return { colour: c.colour, action: "upload", url: mine[0], reason: problem };
  });
}

/**
 * Import helper: the gallery index of each colour's own photo, matched by FILE (never by position), or -1.
 * `galleryUrls[i]` is the source URL of created image i; when a created image's source is unknown (renamed on upload,
 * e.g. Costway neutral names), pass its source URL through `sourceOf`.
 */
export function colourPhotoIndex(colour: string, sources: ColourSource[], galleryUrls: string[]): number {
  const mine = exclusiveImages(sources).get(colour) ?? [];
  const keys = galleryUrls.map(imageKey);
  for (const u of mine) {
    const i = keys.indexOf(imageKey(u));
    if (i >= 0) return i;
  }
  return -1;
}
