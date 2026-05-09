import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import { getContentTemplateBySlug, createFacebookDraft } from "@/lib/database";
import { selectHook, buildHookedPrompt } from "@/lib/hook-selector";
import { getAnthropicClient } from "@/lib/content-generator";
import { CLAUDE } from "@/lib/config";

const ANTHROPIC_CALL_TIMEOUT_MS = 45_000;

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

function getSaisonFr(month: number): string {
  if (month >= 2 && month <= 4) return "printemps";
  if (month >= 5 && month <= 7) return "été";
  if (month >= 8 && month <= 10) return "automne";
  return "hiver";
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
    if (!(await isAuthenticated())) {
      return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    if ((await getSessionRole()) === "reviewer") {
      return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const { templateSlug, language } = body as {
      templateSlug?: unknown;
      language?: unknown;
    };

    if (!templateSlug || typeof templateSlug !== "string") {
      return NextResponse.json(
        { success: false, error: "templateSlug is required" },
        { status: 400 },
      );
    }

    if (language !== "fr") {
      return NextResponse.json(
        { success: false, error: "Only language 'fr' is supported at this time" },
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
    const vars: Record<string, string> = {
      saison: getSaisonFr(month),
      mois: MONTHS_FR[month],
      category: pickRandom(CATEGORIES_FR),
      room: pickRandom(ROOMS_FR),
    };

    const basePrompt = interpolateTemplate(template.prompt_pattern_fr, vars);
    const hook = await selectHook("FR", null, null);
    const hookedPrompt = buildHookedPrompt(basePrompt, hook);

    const postText = await generatePostText(hookedPrompt);
    if (!postText) {
      return NextResponse.json(
        { success: false, error: "Claude returned an empty response" },
        { status: 502 },
      );
    }

    const draftId = await createFacebookDraft({
      sku: `content-${template.slug}`,
      triggerType: "content_template",
      language: "fr",
      postText,
      hookId: hook.hookId,
    });

    return NextResponse.json({
      success: true,
      draftId,
      postText,
      templateSlug: template.slug,
      hookId: hook.hookId,
      vars,
    });
  } catch (err) {
    console.error("[API] /api/social/content/generate POST failed:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
