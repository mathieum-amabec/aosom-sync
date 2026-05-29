import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { getContentTemplateBySlug, createFacebookDraft, getAnyProductSku, selectCompatibleHooks } from "@/lib/database";
import { mapProductTypeToScope } from "@/lib/hook-selector";
import { getAnthropicClient } from "@/lib/content-generator";
import { searchImages, triggerDownload } from "@/lib/unsplash";
import { CLAUDE } from "@/lib/config";

const ANTHROPIC_CALL_TIMEOUT_MS = 45_000;

/**
 * Map a content_template's theme (its scopes + interpolated vars) to an
 * Unsplash search query. content_template drafts have no product image of
 * their own, so we illustrate them with a themed stock photo.
 */
function unsplashQueryForTheme(scopes: string[], vars: Record<string, string>): string {
  const hay = `${scopes.join(" ")} ${Object.values(vars).join(" ")}`.toLowerCase();
  if (/patio|outdoor|jardin|ext[eé]rieur|terrasse/.test(hay)) return "patio outdoor living";
  if (/salon|living room/.test(hay)) return "cozy living room decor";
  if (/chambre|bedroom/.test(hay)) return "bedroom furniture cozy";
  if (/lumi[eè]re|lighting|luminaire/.test(hay)) return "interior lighting home";
  if (/meuble|furniture|mobilier/.test(hay)) return "modern furniture interior";
  return "home decor interior design";
}

const CATEGORIES_FR = [
  "mobilier de salon",
  "mobilier de chambre à coucher",
  "mobilier de salle à manger",
  "mobilier de bureau",
  "articles de jardin",
  "rangement et organisation",
  "décoration intérieure",
  "mobilier d'extérieur",
];

const ROOMS_FR = [
  "salon",
  "chambre à coucher",
  "salle à manger",
  "bureau à domicile",
  "jardin et patio",
  "cuisine",
  "couloir",
  "salle de jeux",
];

const MONTHS_FR = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];

const CATEGORIES_EN = [
  "living room furniture",
  "bedroom furniture",
  "dining room furniture",
  "home office furniture",
  "garden and patio",
  "storage and organization",
  "home decor",
  "outdoor furniture",
];

const MONTHS_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function getSaisonFr(month: number): string {
  if (month >= 2 && month <= 4) return "printemps";
  if (month >= 5 && month <= 7) return "été";
  if (month >= 8 && month <= 10) return "automne";
  return "hiver";
}

function getSeasonEn(month: number): string {
  if (month >= 2 && month <= 4) return "spring";
  if (month >= 5 && month <= 7) return "summer";
  if (month >= 8 && month <= 10) return "fall";
  return "winter";
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function interpolateTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return result;
}

async function generatePostText(prompt: string): Promise<string> {
  const client = getAnthropicClient();
  const message = await client.messages.create(
    {
      model: CLAUDE.MODEL,
      max_tokens: CLAUDE.MAX_TOKENS_SOCIAL,
      messages: [{ role: "user", content: prompt }],
    },
    { signal: AbortSignal.timeout(ANTHROPIC_CALL_TIMEOUT_MS) },
  );
  return message.content[0]?.type === "text" ? message.content[0].text.trim() : "";
}

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get("authorization");
    const cronSecret = process.env.CRON_SECRET;
    const isCronAuth = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

    if (!isCronAuth) {
      if (!(await isAuthenticated())) {
        return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
      }
      if ((await getSessionRole()) === "reviewer") {
        return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
      }
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const { templateSlug, language = "fr" } = body as {
      templateSlug?: unknown;
      language?: unknown;
    };

    if (!templateSlug || typeof templateSlug !== "string") {
      return NextResponse.json(
        { success: false, error: "templateSlug is required" },
        { status: 400 },
      );
    }

    if (language !== "fr" && language !== "en") {
      return NextResponse.json(
        { success: false, error: "language must be 'fr' or 'en'" },
        { status: 400 },
      );
    }

    const template = await getContentTemplateBySlug(templateSlug);
    if (!template) {
      return NextResponse.json(
        { success: false, error: `Template '${templateSlug}' not found` },
        { status: 404 },
      );
    }
    if (!template.active) {
      return NextResponse.json(
        { success: false, error: `Template '${templateSlug}' is not active` },
        { status: 422 },
      );
    }

    const now = new Date();
    const month = now.getMonth();
    const isEn = language === "en";

    // Hook selection — only for hook_seeded templates; generative_seeded templates self-generate their hook
    let hookChosen: { id: number; text: string } | null = null;
    if (template.mode !== "generative_seeded") {
      const scope = mapProductTypeToScope(null);
      const hookLang = isEn ? "EN" : "FR";
      const hookCandidates = await selectCompatibleHooks(scope, hookLang, []);
      if (hookCandidates.length === 0) {
        return NextResponse.json(
          { success: false, error: `No ${hookLang} hooks available in pool — cannot generate hook_seeded post` },
          { status: 503 },
        );
      }
      hookChosen = hookCandidates[Math.floor(Math.random() * hookCandidates.length)];
    }

    // Inject template variables; {{hook}} only present for hook_seeded mode
    const vars: Record<string, string> = isEn
      ? {
          season: getSeasonEn(month),
          month: MONTHS_EN[month],
          category: pickRandom(CATEGORIES_EN),
          ...(hookChosen ? { hook: hookChosen.text } : {}),
        }
      : {
          saison: getSaisonFr(month),
          season: getSaisonFr(month),
          mois: MONTHS_FR[month],
          month: MONTHS_FR[month],
          category: pickRandom(CATEGORIES_FR),
          room: pickRandom(ROOMS_FR),
          ...(hookChosen ? { hook: hookChosen.text } : {}),
        };

    const pattern = isEn ? template.prompt_pattern_en : template.prompt_pattern_fr;
    const finalPrompt = interpolateTemplate(pattern, vars);

    const postText = await generatePostText(finalPrompt);
    if (!postText) {
      return NextResponse.json(
        { success: false, error: "Claude returned an empty response" },
        { status: 502 },
      );
    }

    // facebook_drafts.sku has FK on products(sku) — content template drafts use any real SKU
    const sku = await getAnyProductSku();
    if (!sku) {
      return NextResponse.json(
        { success: false, error: "No products in catalog — cannot create draft" },
        { status: 503 },
      );
    }

    // Illustrate the draft with a themed Unsplash photo. Best-effort: a fetch
    // failure (rate limit, network, no key) must not block draft creation.
    let unsplash: { url: string; photographer: string; photographerUrl: string } | null = null;
    try {
      const query = unsplashQueryForTheme(template.scopes, vars);
      const [img] = await searchImages(query, 1);
      if (img) {
        // Required by Unsplash API guidelines whenever a photo is used/displayed.
        await triggerDownload(img.downloadLocation);
        unsplash = { url: img.url, photographer: img.photographer, photographerUrl: img.photographerUrl };
      }
    } catch (imgErr) {
      console.warn(`[API] Unsplash fetch failed (non-fatal):`, imgErr instanceof Error ? imgErr.message : imgErr);
    }

    const draftId = await createFacebookDraft({
      sku,
      triggerType: "content_template",
      language: isEn ? "en" : "fr",
      postText: isEn ? "" : postText,
      postTextEn: isEn ? postText : null,
      hookId: hookChosen?.id ?? null,
      unsplashImageUrl: unsplash?.url ?? null,
      unsplashPhotographer: unsplash?.photographer ?? null,
      unsplashPhotographerUrl: unsplash?.photographerUrl ?? null,
    });

    return NextResponse.json({
      success: true,
      draftId,
      postText,
      templateSlug: template.slug,
      language,
      hookId: hookChosen?.id ?? null,
      vars,
      unsplashImageUrl: unsplash?.url ?? null,
    });
  } catch (err) {
    console.error("[API] /api/social/content/generate POST failed:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
