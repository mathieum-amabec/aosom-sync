/**
 * Studio AI retouch — edit a product photo through Vercel AI Gateway (Chat Completions with
 * image output, docs: /docs/ai-gateway/sdks-and-apis/openai-chat-completions/image-generation).
 *
 * Every preset carries the same guardrail: the PRODUCT must stay identical (shape, colours,
 * proportions, materials) — only its surroundings change. An ad showing a product that
 * differs from what ships is a returns/complaints risk and a Meta ad-policy risk, which is
 * why Mat validates each result side by side with the original before it can be used, and
 * why AI images only ever feed videos (studio_images), never the Shopify product gallery.
 */
import { STUDIO_AI } from "@/lib/config";

export type RetouchPreset = "clean" | "stage" | "empty_room" | "enhance" | "season" | "free";

export const STAGE_SCENES = {
  salon: "a bright, modern Canadian living room",
  chambre: "a calm, modern bedroom",
  patio: "a sunny backyard patio with a lawn and plants",
  jardin: "a lush garden in summer",
  cuisine: "a clean, modern kitchen",
  bureau: "a tidy home office",
} as const;
export type StageScene = keyof typeof STAGE_SCENES;

export const SEASONS = {
  halloween: "tasteful Halloween decorations (pumpkins, autumn leaves, warm evening light)",
  noel: "cosy Christmas decorations (a decorated tree, garlands, warm lights)",
  automne: "autumn atmosphere (orange leaves, warm light)",
  ete: "a bright summer atmosphere",
} as const;
export type Season = keyof typeof SEASONS;

export const PRESETS: { id: RetouchPreset; label: string; description: string }[] = [
  { id: "clean", label: "Nettoyer", description: "Enlève logos, filigranes et textes incrustés." },
  { id: "stage", label: "Mettre en scène", description: "Place le produit dans une pièce réaliste (crée un « après »)." },
  { id: "empty_room", label: "Pièce vide", description: "Efface le produit de la photo lifestyle (crée un « avant »)." },
  { id: "enhance", label: "Améliorer", description: "Éclairage, netteté et couleurs plus flatteurs." },
  { id: "season", label: "Ambiance saisonnière", description: "Ajoute un décor de saison autour du produit." },
  { id: "free", label: "Consigne libre", description: "Décris toi-même la retouche, en français." },
];

const KEEP_PRODUCT =
  "CRITICAL: the product itself must stay exactly identical — same shape, proportions, colours, " +
  "materials, pattern and every detail. Do not add any text, logo, watermark or caption. " +
  "Keep it photorealistic, like a professional furniture catalogue photo.";

export interface RetouchInput {
  preset: RetouchPreset;
  scene?: StageScene;
  season?: Season;
  /** Free-text instruction (French is fine), used by the "free" preset. */
  instruction?: string;
  productTitle?: string;
}

/** Build the model instruction for a preset. Pure, unit-tested. Returns null when inputs are missing. */
export function buildRetouchPrompt(i: RetouchInput): string | null {
  const product = i.productTitle ? `The product is: "${i.productTitle}". ` : "";
  switch (i.preset) {
    case "clean":
      return `${product}Remove every logo, watermark, brand name, text overlay, caption, icon and dimension marking from this image. Reconstruct the areas underneath naturally. Change nothing else. ${KEEP_PRODUCT}`;
    case "stage": {
      const scene = STAGE_SCENES[i.scene ?? "salon"];
      return `${product}Place this exact product in ${scene}, realistically lit, at a natural scale, as the clear focal point of the photo. ${KEEP_PRODUCT}`;
    }
    case "empty_room":
      return `${product}Remove the main piece of furniture/product from this room entirely, and fill the space naturally with the floor, walls and background so the room looks real and simply empty where the product was. Keep the room, lighting, camera angle and every other object exactly the same. Do not add any text, logo or watermark. Photorealistic.`;
    case "enhance":
      return `${product}Improve this photo: better, brighter natural lighting, sharper details, pleasant true-to-life colours, clean background. Do not change the composition. ${KEEP_PRODUCT}`;
    case "season": {
      const season = SEASONS[i.season ?? "halloween"];
      return `${product}Add ${season} around this product, keeping the room otherwise the same. The decorations must not cover the product. ${KEEP_PRODUCT}`;
    }
    case "free": {
      const text = (i.instruction ?? "").trim().slice(0, 600);
      if (!text) return null;
      return `${product}Edit this photo as follows (instruction in French): ${text}. ${KEEP_PRODUCT}`;
    }
  }
}

export function isAiRetouchConfigured(): boolean {
  return !!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
}

export class RetouchError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

/**
 * Send one image + instruction to the Gateway and return the edited image bytes (JPEG).
 * `source` must be a JPEG/PNG buffer; it is sent inline (data URI) so the model never has
 * to fetch a URL itself.
 */
export type RetouchTier = keyof typeof STUDIO_AI.IMAGE_MODELS;
export const isRetouchTier = (v: unknown): v is RetouchTier => typeof v === "string" && v in STUDIO_AI.IMAGE_MODELS;

export async function retouchImage(source: Buffer, prompt: string, tier: RetouchTier = "quality"): Promise<Buffer> {
  const apiKey = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
  if (!apiKey) throw new RetouchError("Retouche IA non configurée : ajoute AI_GATEWAY_API_KEY dans Vercel.", 503);
  const sharp = (await import("sharp")).default;
  // Cap the input at 2048px: enough detail for a 1080-wide video, keeps the request small.
  const input = await sharp(source).rotate().resize(2048, 2048, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();

  const res = await fetch(`${STUDIO_AI.GATEWAY_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: STUDIO_AI.IMAGE_MODELS[tier].id,
      modalities: ["image", "text"],
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${input.toString("base64")}` } },
            { type: "text", text: prompt },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(STUDIO_AI.TIMEOUT_MS),
  });
  const bodyText = await res.text();
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? "clé AI Gateway invalide ou absente"
        : res.status === 402
          ? "crédit AI Gateway épuisé"
          : res.status === 429
            ? "trop de demandes, réessaie dans une minute"
            : `erreur ${res.status}`;
    throw new RetouchError(`Retouche IA refusée (${hint}) : ${bodyText.slice(0, 200)}`, res.status === 429 ? 429 : 502);
  }
  let json: { choices?: { message?: { images?: { image_url?: { url?: string } }[]; content?: string } }[] };
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new RetouchError("Réponse IA illisible");
  }
  const msg = json.choices?.[0]?.message;
  const dataUrl = msg?.images?.find((im) => im.image_url?.url?.startsWith("data:image/"))?.image_url?.url;
  if (!dataUrl) {
    throw new RetouchError(`L'IA n'a pas renvoyé d'image${msg?.content ? ` (« ${String(msg.content).slice(0, 160)} »)` : ""}`);
  }
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return sharp(Buffer.from(b64, "base64")).jpeg({ quality: 90 }).toBuffer();
}
