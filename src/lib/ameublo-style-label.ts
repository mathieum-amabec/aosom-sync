/**
 * Display name of a Studio Ameublo video style (or of a batch video type), in French or English.
 *
 * `STYLE_LABEL` (ameublo-caption.ts) only knows the seven styles the caption builder writes captions for. The Hormozi-style
 * videos (aventure, budget, vote, mesure) and the two batch video types (assembly, demand_gen_ext) are produced elsewhere, so
 * the Studio showed their raw key ("aventure"). Kept here, not in `AmeubloStyle`, so that union — which the caption builder
 * switches over exhaustively — does not grow cases it has no caption for.
 */
import { STYLE_LABEL, type AmeubloStyle } from "./ameublo-caption";

const EXTRA: Record<string, { fr: string; en: string }> = {
  aventure: { fr: "Les aventures d’Ameublo", en: "Furni’s adventures" },
  budget: { fr: "Défi budget", en: "Budget challenge" },
  vote: { fr: "Le vote d’Ameublo", en: "Furni’s vote" },
  mesure: { fr: "Ameublo mesure", en: "Furni’s rule" },
  assembly: { fr: "Montage (lot)", en: "Assembly (batch)" },
  demand_gen_ext: { fr: "Demand-gen (lot)", en: "Demand-gen (batch)" },
  // older Reel kinds that still show up in the results
  demand_gen_messages: { fr: "Demand-gen (messages)", en: "Demand-gen (messages)" },
  hero_slides: { fr: "Héros (diaporama)", en: "Hero slides" },
  ugc_video: { fr: "Vidéo client (UGC)", en: "Customer video (UGC)" },
  video: { fr: "Vidéo produit (ancienne)", en: "Product video (older)" },
};

export function styleLabelOf(style: string | null | undefined, lang: "fr" | "en" = "fr"): string {
  if (!style) return "—";
  if (style in STYLE_LABEL) return STYLE_LABEL[style as AmeubloStyle][lang];
  return EXTRA[style]?.[lang] ?? style;
}
