/**
 * Centralized configuration — single source of truth for all env vars and constants.
 * Every module imports from here instead of reading process.env directly.
 */

// ─── Environment Variables ──────────────────────────────────────────

export const env = {
  get shopifyAccessToken(): string {
    const v = process.env.SHOPIFY_ACCESS_TOKEN;
    if (!v) throw new Error("SHOPIFY_ACCESS_TOKEN not set in .env.local");
    return v;
  },
  get anthropicApiKey(): string {
    const v = process.env.ANTHROPIC_API_KEY;
    if (!v) throw new Error("ANTHROPIC_API_KEY not set in .env.local");
    return v;
  },
  get authPassword(): string | undefined {
    return process.env.AUTH_PASSWORD || undefined;
  },
  /** Optional: Klaviyo private API key. When unset, the Klaviyo client no-ops. */
  get klaviyoApiKey(): string | undefined {
    return process.env.KLAVIYO_API_KEY || undefined;
  },
  /** Optional: recipient of the 06:00 morning report (sent via a Klaviyo metric-triggered
   *  flow). When unset, the morning-report cron records an error instead of sending. */
  get morningReportEmail(): string | undefined {
    return process.env.MORNING_REPORT_EMAIL?.trim() || undefined;
  },
  get cronSecret(): string {
    const v = process.env.CRON_SECRET;
    if (!v) throw new Error("CRON_SECRET not set in .env.local");
    return v;
  },
  /** @deprecated use facebookAmeubloPageId — kept for legacy single-brand code paths */
  get facebookPageId(): string {
    const v = process.env.FACEBOOK_AMEUBLO_PAGE_ID || process.env.FACEBOOK_PAGE_ID;
    if (!v) throw new Error("FACEBOOK_AMEUBLO_PAGE_ID not set in .env.local");
    return v;
  },
  /** @deprecated use facebookAmeubloPageToken — kept for legacy single-brand code paths */
  get facebookPageAccessToken(): string {
    const v = process.env.FACEBOOK_AMEUBLO_PAGE_TOKEN || process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
    if (!v) throw new Error("FACEBOOK_AMEUBLO_PAGE_TOKEN not set in .env.local");
    return v;
  },
  // ─── Multi-brand Meta (Facebook + Instagram) ───
  get facebookAmeubloPageId(): string {
    const v = process.env.FACEBOOK_AMEUBLO_PAGE_ID;
    if (!v) throw new Error("FACEBOOK_AMEUBLO_PAGE_ID not set");
    return v;
  },
  get facebookAmeubloPageToken(): string {
    const v = process.env.FACEBOOK_AMEUBLO_PAGE_TOKEN;
    if (!v) throw new Error("FACEBOOK_AMEUBLO_PAGE_TOKEN not set");
    return v;
  },
  get facebookFurnishPageId(): string {
    const v = process.env.FACEBOOK_FURNISH_PAGE_ID;
    if (!v) throw new Error("FACEBOOK_FURNISH_PAGE_ID not set");
    return v;
  },
  get facebookFurnishPageToken(): string {
    const v = process.env.FACEBOOK_FURNISH_PAGE_TOKEN;
    if (!v) throw new Error("FACEBOOK_FURNISH_PAGE_TOKEN not set");
    return v;
  },
  get instagramAmeubloAccountId(): string {
    const v = process.env.INSTAGRAM_AMEUBLO_ACCOUNT_ID;
    if (!v) throw new Error("INSTAGRAM_AMEUBLO_ACCOUNT_ID not set");
    return v;
  },
  /** True if Furnish Instagram is configured (not yet — add later). */
  get hasInstagramFurnish(): boolean {
    return !!process.env.INSTAGRAM_FURNISH_ACCOUNT_ID;
  },
  get unsplashAccessKey(): string {
    const v = process.env.UNSPLASH_ACCESS_KEY;
    if (!v) throw new Error("UNSPLASH_ACCESS_KEY not set in .env.local");
    return v;
  },
  /**
   * Name sent as `utm_source` on the Unsplash attribution links baked into every blog
   * article. This is CUSTOMER-FACING: it ships inside the published article HTML.
   *
   * The default was "aosom-sync" — the internal repo name — and `UNSPLASH_APP_NAME` is not
   * set anywhere, so all 8 generated articles carry `utm_source=aosom-sync` four times each
   * in their photo credits. A prompt rule cannot fix this: the parameter is appended by
   * buildAttributionUrl in unsplash.ts, never by the model.
   */
  get unsplashAppName(): string {
    return process.env.UNSPLASH_APP_NAME || "ameublodirect";
  },
  get storeName(): string {
    return process.env.NEXT_PUBLIC_STORE_NAME || "Aosom Sync";
  },
  /** Meta (Facebook) Pixel ID. Optional — when unset, the injected pixel script is a no-op. */
  get metaPixelId(): string | undefined {
    return process.env.NEXT_PUBLIC_META_PIXEL_ID || undefined;
  },
  get hasMetaPixel(): boolean {
    return !!process.env.NEXT_PUBLIC_META_PIXEL_ID;
  },
  /** Pinterest Tag ID. Optional — when unset, the injected Pinterest script is a no-op.
   * Read server-side at request time by /api/pixel/pinterest-script (no NEXT_PUBLIC needed). */
  get pinterestTagId(): string | undefined {
    return process.env.PINTEREST_TAG_ID || undefined;
  },
  get hasPinterestTag(): boolean {
    return !!process.env.PINTEREST_TAG_ID;
  },
  /** Meta Marketing API access token (Ads management). Throws when the Ads features
   * are used without it configured. */
  get metaAccessToken(): string {
    const v = process.env.META_ACCESS_TOKEN;
    if (!v) throw new Error("META_ACCESS_TOKEN not set in .env.local");
    return v;
  },
  get hasMetaAccessToken(): boolean {
    return !!process.env.META_ACCESS_TOKEN;
  },
  /** Optional: the Meta ad account to report on (e.g. "act_123456789"). When set,
   * the ads insights route uses it instead of auto-picking the first ACTIVE account. */
  get metaAdAccountId(): string | undefined {
    return process.env.META_AD_ACCOUNT_ID || undefined;
  },
  /** Optional: Creatomate API key for automated product videos. Client no-ops when unset. */
  get creatomateApiKey(): string | undefined {
    return process.env.CREATOMATE_API_KEY || undefined;
  },
  /** Optional: the Creatomate template id used to render square (1080x1080) product
   * videos for Facebook. */
  get creatomateTemplateId(): string | undefined {
    return process.env.CREATOMATE_TEMPLATE_ID || undefined;
  },
  /** Optional: a second Creatomate template rendering vertical 9:16 (1080x1920)
   * videos for Instagram Reels. When unset, no reel is rendered and IG falls back to
   * the image post. */
  get creatomateReelsTemplateId(): string | undefined {
    return process.env.CREATOMATE_REELS_TEMPLATE_ID || undefined;
  },
  /** Optional: public logo URL passed to the Creatomate template's logo_url variable. */
  get creatomateLogoUrl(): string | undefined {
    return process.env.CREATOMATE_LOGO_URL || undefined;
  },
  /** Optional: French (Ameublo) square Creatomate template. Falls back to
   * CREATOMATE_TEMPLATE_ID when unset so existing single-template setups keep working. */
  get creatomateTemplateIdFr(): string | undefined {
    return process.env.CREATOMATE_TEMPLATE_ID_FR || process.env.CREATOMATE_TEMPLATE_ID || undefined;
  },
  /** Optional: English (Furnish Direct) square Creatomate template. Falls back to
   * CREATOMATE_TEMPLATE_ID when unset. */
  get creatomateTemplateIdEn(): string | undefined {
    return process.env.CREATOMATE_TEMPLATE_ID_EN || process.env.CREATOMATE_TEMPLATE_ID || undefined;
  },
  /** Optional: Kling AI API key for the cinematic image→video engine. Client no-ops when unset. */
  get klingApiKey(): string | undefined {
    return process.env.KLING_API_KEY || undefined;
  },
  // ─── Google Business Profile (GBP) ───
  // OAuth client can be a dedicated one OR the same installed-app client already used for
  // Google Ads (GOOGLE_ADS_CLIENT_ID/_SECRET) — the Business Profile API just needs to be
  // enabled on that same Cloud project. The refresh token is separate because the SCOPE
  // differs (business.manage vs adwords). See docs/GBP-SETUP.md.
  get gbpClientId(): string | undefined {
    return process.env.GOOGLE_GBP_CLIENT_ID || process.env.GOOGLE_ADS_CLIENT_ID || undefined;
  },
  get gbpClientSecret(): string | undefined {
    return process.env.GOOGLE_GBP_CLIENT_SECRET || process.env.GOOGLE_ADS_CLIENT_SECRET || undefined;
  },
  get gbpRefreshToken(): string | undefined {
    return process.env.GOOGLE_GBP_REFRESH_TOKEN || undefined;
  },
  /** "accounts/{id}" — the GBP account resource. */
  get gbpAccountId(): string | undefined {
    return process.env.GOOGLE_GBP_ACCOUNT_ID || undefined;
  },
  /** "locations/{id}" — the specific business location to post to. */
  get gbpLocationId(): string | undefined {
    return process.env.GOOGLE_GBP_LOCATION_ID || undefined;
  },
  get hasGbp(): boolean {
    return !!(
      process.env.GOOGLE_GBP_REFRESH_TOKEN &&
      (process.env.GOOGLE_GBP_CLIENT_ID || process.env.GOOGLE_ADS_CLIENT_ID) &&
      (process.env.GOOGLE_GBP_CLIENT_SECRET || process.env.GOOGLE_ADS_CLIENT_SECRET) &&
      process.env.GOOGLE_GBP_ACCOUNT_ID &&
      process.env.GOOGLE_GBP_LOCATION_ID
    );
  },
  /** Off by default — first post always waits for explicit human approval regardless of
   * this flag (see gbp-post-generator.ts). Once Mat has seen a few real posts, flipping this
   * to "true" lets the weekly cron publish straight through the quality gate unattended. */
  get gbpAutoPublish(): boolean {
    return process.env.GBP_AUTO_PUBLISH === "true";
  },
  get isProduction(): boolean {
    return process.env.NODE_ENV === "production";
  },
  /** Returns true if Shopify token is configured (for optional features). */
  get hasShopifyToken(): boolean {
    return !!process.env.SHOPIFY_ACCESS_TOKEN;
  },
} as const;

// ─── Shopify ────────────────────────────────────────────────────────

export const SHOPIFY = {
  STORE: "27u5y2-kp.myshopify.com",
  API_VERSION: "2025-01",
  PRODUCTS_PER_PAGE: 250,
  ADMIN_URL: "https://admin.shopify.com/store/27u5y2-kp",
} as const;

// Shopify Online Store blog IDs — verified by user.
// FR = "Actualités", EN = "Blog".
export const BLOG = {
  FR_ID: 90302349417,
  EN_ID: 91161428073,
  // Dedicated blog for pSEO subcategory guide pages — kept separate from the editorial
  // "Actualités" blog so the guides form their own clean topical cluster (URL:
  // /blogs/guides/{article-handle}), rather than diluting into seasonal/editorial content.
  // Created 2026-09-22 (handle "guides"). EN counterpart not created yet — FR-only pilot.
  GUIDES_FR_ID: 101889212521,
  ADMIN_ARTICLE_URL: (id: string | number) =>
    `${SHOPIFY.ADMIN_URL}/articles/${id}`,
  // Auto-publish: an article goes live only if Claude's quality judge scores it at/above
  // this (0-100) AND its topic is in season AND the weekly cap isn't reached. The weekly
  // cap + on/off switch live in the `blog_schedule` setting (BlogSchedule.posts_per_week /
  // .enabled), edited via /api/settings/schedule.
  AUTO_PUBLISH_SCORE_THRESHOLD: 80,
  // Collection metafield the queue publisher sets on a guide's shopify_collection_id once
  // the guide is actually live (never before — see Task C's "only a real published guide
  // links" requirement). The collection.liquid template reads this to render the "Guide
  // d'achat" link — see docs/collection-guide-link.liquid for the theme snippet source.
  GUIDE_URL_METAFIELD: { namespace: "custom", key: "guide_url", type: "single_line_text_field" },
} as const;

// ─── Aosom Feed ─────────────────────────────────────────────────────

export const AOSOM = {
  CSV_URL: process.env.AOSOM_FEED_URL || "https://feed-us.aosomcdn.com/390/110_feed/0/0/5e/c4857d.csv",
  FETCH_MAX_RETRIES: 2,
  FETCH_BACKOFF_MS: 5000,
} as const;

// ─── Claude API ─────────────────────────────────────────────────────

export const CLAUDE = {
  /**
   * The public shopping assistant's model (`/api/assistant` → runAssistant only).
   *
   * Moved off Sonnet 4.6 to Haiku 4.5 on 2026-09-02. The assistant's job is choosing among
   * catalogue rows the search tool has already narrowed, and it accounts for ~86% of all
   * recorded token volume. Haiku 4.5 is exactly one third of Sonnet 4.6 on BOTH input
   * ($1 vs $3 per MTok) and output ($5 vs $15), so this cuts the pool's cost by two thirds
   * however the input/output mix falls.
   *
   * ⚠️ This changes cost per token, NOT tokens consumed. The `assistant` pool caps TOKENS,
   * so this swap alone does not serve one extra shopper — raising LLM_ASSISTANT_DAILY_BUDGET
   * is what does that, and at Haiku rates 1.5M tokens/day costs what 500k did on Sonnet.
   *
   * Override per-deploy with CLAUDE_ASSISTANT_MODEL — set it to "claude-sonnet-4-6" to put
   * the assistant back on Sonnet with no code change if answer quality regresses.
   */
  MODEL_ASSISTANT: process.env.CLAUDE_ASSISTANT_MODEL?.trim() || "claude-haiku-4-5-20251001",
  /**
   * The quality / escalation tier. No longer the assistant's model: its remaining job is
   * being the model `generateProductContent` re-runs on when MODEL_BATCH output fails
   * validation (content-generator.ts). It MUST stay stronger than MODEL_BATCH or that
   * escalation degrades into a same-model retry.
   */
  MODEL: "claude-sonnet-4-6",
  /**
   * Every non-assistant ("batch") caller: product descriptions, blog articles, social
   * captions, slideshow hooks, image classification.
   *
   * Haiku 4.5 is priced at exactly one third of Sonnet 4.6 on BOTH input ($1 vs $3 per
   * MTok) and output ($5 vs $15), so moving this pool cuts its cost by two thirds no
   * matter how the input/output mix falls.
   *
   * Override per-deploy with CLAUDE_BATCH_MODEL — setting it to "claude-sonnet-4-6" puts
   * the whole batch pool back on Sonnet with no code change if quality regresses. The
   * structured callers additionally escalate to MODEL on a validation failure (see
   * generateProductContent), so a Haiku miss costs a retry, never output quality.
   */
  MODEL_BATCH: process.env.CLAUDE_BATCH_MODEL?.trim() || "claude-haiku-4-5",
  /**
   * Video-batch vision QC only (demand-gen-ext / before_after frame scoring — see
   * src/lib/demand-gen-clean-window.ts). Draws from the `video` pool, not `batch`.
   *
   * Sonnet, not Haiku: this is a strict dual-gate visual judgment call (full product
   * visible AND text/logo-free) that gates whether a rendered clip ships at all — the
   * same quality bar MODEL_BATCH's escalation tier (MODEL, above) exists for. Override
   * per-deploy with CLAUDE_VIDEO_QC_MODEL.
   */
  MODEL_VIDEO_QC: process.env.CLAUDE_VIDEO_QC_MODEL?.trim() || "claude-sonnet-4-6",
  MAX_TOKENS_CONTENT: 4000,
  MAX_TOKENS_SOCIAL: 500,
} as const;

// ─── Meta Graph API ─────────────────────────────────────────────────

export const FACEBOOK = {
  GRAPH_API_URL: "https://graph.facebook.com/v21.0",
} as const;

export const META = {
  GRAPH_API_URL: "https://graph.facebook.com/v21.0",
} as const;

// ─── Meta Marketing (Ads) API ───────────────────────────────────────
// Pinned to v18.0 per the Ads automation spec. Bump this single constant to
// migrate the whole Ads client to a newer Graph version.
export const META_ADS = {
  API_VERSION: "v18.0",
  GRAPH_API_URL: "https://graph.facebook.com/v18.0",
  /** Self-imposed cap: Meta's standard ad-account tier allows ~200 calls/hour. */
  RATE_LIMIT_PER_HOUR: 200,
} as const;

/**
 * Available publishing channels. Each channel pairs a platform with a brand.
 * `ig_furnish` is reserved for future use when Furnish Direct creates an Instagram account.
 */
export const CHANNELS = {
  FB_AMEUBLO: "fb_ameublo",
  FB_FURNISH: "fb_furnish",
  IG_AMEUBLO: "ig_ameublo",
  IG_FURNISH: "ig_furnish",
} as const;

export type ChannelKey = (typeof CHANNELS)[keyof typeof CHANNELS];

export const CHANNEL_META: Record<
  ChannelKey,
  { platform: "facebook" | "instagram"; brand: "ameublo" | "furnish"; language: "FR" | "EN"; label: string }
> = {
  fb_ameublo: { platform: "facebook", brand: "ameublo", language: "FR", label: "Facebook Ameublo Direct (FR)" },
  fb_furnish: { platform: "facebook", brand: "furnish", language: "EN", label: "Facebook Furnish Direct (EN)" },
  ig_ameublo: { platform: "instagram", brand: "ameublo", language: "FR", label: "Instagram Ameublo Direct (FR)" },
  ig_furnish: { platform: "instagram", brand: "furnish", language: "EN", label: "Instagram Furnish Direct (EN)" },
};

/** Channels that are currently configurable (have env credentials). Furnish IG pending. */
export function activeChannels(): ChannelKey[] {
  const out: ChannelKey[] = ["fb_ameublo", "fb_furnish", "ig_ameublo"];
  if (process.env.INSTAGRAM_FURNISH_ACCOUNT_ID) out.push("ig_furnish");
  return out;
}

// ─── Social Media ───────────────────────────────────────────────────

export const SOCIAL = {
  IMAGE_WIDTH: 1200,
  IMAGE_HEIGHT: 630,
  IMAGE_QUALITY: 85,
  DEFAULT_ACCENT_COLOR: "#2563eb",
  DEFAULT_TEXT_COLOR: "#ffffff",
  PRICE_DROP_BADGE_COLOR: "#dc2626",
  SAVINGS_COLOR: "#22c55e",
} as const;

/**
 * Resolve the app's public base URL (no trailing slash), or null when it can't
 * be determined reliably.
 *
 * Used to build absolute, publicly-fetchable URLs (e.g. price-alert / waitlist
 * confirmation links, video brand assets): external clients fetch these, so a
 * relative path or a localhost URL is useless to them.
 *
 * Priority:
 *  1. NEXT_PUBLIC_APP_URL — explicit override (set this for custom domains).
 *  2. VERCEL_PROJECT_PRODUCTION_URL — the STABLE production alias on Vercel.
 *     Deliberately NOT VERCEL_URL, which is a per-deployment preview host
 *     (see api/cron/content/route.ts for the same reasoning).
 *  3. null — caller must fall back (or skip) rather than emit a localhost URL
 *     that an external client can't reach.
 */
export function getPublicAppUrl(): string | null {
  const explicit = process.env.NEXT_PUBLIC_APP_URL;
  if (explicit && explicit.trim()) {
    // A misconfigured override (http://, localhost) must NOT be emitted to
    // Facebook/Instagram — return null so callers fall back to raw image URLs
    // rather than posting an unreachable branded URL.
    try {
      const u = new URL(explicit.trim());
      const host = u.hostname.toLowerCase();
      if (u.protocol === "https:" && host !== "localhost" && !host.startsWith("127.")) {
        return `https://${u.host}`;
      }
    } catch {
      /* malformed — fall through to null */
    }
    return null;
  }
  const vercelProd = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercelProd && vercelProd.trim()) return `https://${vercelProd.trim().replace(/\/+$/, "")}`;
  return null;
}

// ─── Sync ───────────────────────────────────────────────────────────

export const SYNC = {
  PRICE_TOLERANCE: 0.01,
  DEFAULT_PRICE_DROP_THRESHOLD: "10",
  DEFAULT_MIN_DAYS_BETWEEN_REPOSTS: "30",
  /**
   * Minimum real discount (%) required to display a compare_at_price (struck-through
   * "was" price). Below this, no compare_at_price is set so we never show a fake sale
   * on a 1% dip. Default 10%. Override with MIN_DISCOUNT_DISPLAY_PERCENT.
   */
  MIN_DISCOUNT_DISPLAY_PERCENT: (() => {
    // Guard against a malformed env var: Number("abc") => NaN would silently
    // disable every sale price (logic) or clear every compare_at (cleanup script),
    // since `x >= NaN` is always false. Fall back to 10 on NaN / negative.
    const n = Number(process.env.MIN_DISCOUNT_DISPLAY_PERCENT ?? "10");
    return Number.isFinite(n) && n >= 0 ? n : 10;
  })(),
} as const;

// ─── API Defaults ───────────────────────────────────────────────────

export const API = {
  DEFAULT_PAGE_SIZE: 50,
  MAX_PAGE_SIZE: 200,
  DEFAULT_INSIGHTS_LIMIT: 50,
  MAX_INSIGHTS_LIMIT: 200,
} as const;

// ─── Import batch sizing ────────────────────────────────────────────
//
// READ THIS BEFORE ADDING ANY PER-PRODUCT WORK TO queueForImport().
//
// queueForImport() (lib/import-pipeline.ts) walks its products SEQUENTIALLY, and
// every product costs real wall-clock time:
//
//   selectProductImagesAsync()    downloads + classifies each image
//   enforceCleanPrimaryImage()    ONE LLM vision call, per product
//   getProduct() x N variants     one DB round-trip each
//   upsertImportJob()             one DB write
//
// Measured in production on 2026-09-13: ~5 s/product (11 products in 58 s, from
// the Vercel runtime logs of the 504s).
//
// THE INVARIANT, enforced by a test in tests/import-batch-sizing.test.ts:
//
//   MAX_SKUS_PER_BATCH * SECONDS_PER_PRODUCT + FIXED_OVERHEAD_S <= ROUTE_MAX_DURATION_S
//
// Break it and the function is killed mid-loop. upsertImportJob() runs INSIDE the
// loop, so the products already processed stay committed: a timeout leaves a
// HALF-IMPORTED batch and the client gets a 504 with no usable body.
//
// That is exactly the regression shipped in 2f24ff3 (2026-09-11): the pos-1 vision
// guard raised the per-product cost while maxDuration stayed at 60 s, so every
// batch over ~11 products died silently. Imports of 13 and 21 products succeeded
// on 2026-09-07; on 2026-09-13 the same action wrote 1-3 jobs and 504'd.
//
// If you add per-product work: re-measure SECONDS_PER_PRODUCT and, in the SAME
// commit, lower MAX_SKUS_PER_BATCH or raise ROUTE_MAX_DURATION_S.
export const IMPORT = {
  /** Mirrored by `export const maxDuration` in api/import/queue/route.ts. */
  ROUTE_MAX_DURATION_S: 300,
  /** Measured, not guessed. Re-measure when the per-product work changes. */
  SECONDS_PER_PRODUCT: 5,
  /** CSV fetch + merge before the loop starts. */
  FIXED_OVERHEAD_S: 15,
  /** Hard cap the route enforces, and the number the catalogue UI shows. */
  MAX_SKUS_PER_BATCH: 40,
} as const;

// ─── Session / Auth ─────────────────────────────────────────────────

export const AUTH = {
  SESSION_MAX_AGE: 60 * 60 * 24 * 7, // 7 days
  COOKIE_NAME: "aosom_session",
  ROLES: ["admin", "reviewer"] as const,
  // Reviewer is the limited role used for Meta App Review. Can only reach
  // Social Media + Settings so Meta can verify the publishing workflow
  // without exposing catalogue, sync history, imports, or collections.
  REVIEWER_ALLOWED_PREFIXES: [
    "/social",
    "/settings",
    "/api/social",
    "/api/settings",
    "/api/auth",
    "/api/health",
    "/privacy",
  ],
} as const;

export type UserRole = (typeof AUTH.ROLES)[number];

// ─── Publication Schedule ───────────────────────────────────────────
// Configurable auto-posting cadence. Replaces the fixed M/W/F grid baked into
// draft-scheduler.ts with a per-weekday set of local times. Stored as JSON in
// the `settings` table under `publication_schedule` / `blog_schedule`.

export type WeekdayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

// Monday-first ordering for display + iteration.
export const WEEKDAY_KEYS: readonly WeekdayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export interface PublicationSlot {
  day: WeekdayKey;
  /** "HH:MM" 24h wall-clock times, local to the schedule's `timezone`. */
  times: string[];
}

export interface PublicationSchedule {
  enabled: boolean;
  slots: PublicationSlot[];
  /** IANA timezone, e.g. "America/Toronto". */
  timezone: string;
  /** Hard cap on posts auto-scheduled to any single calendar day (1..5). */
  max_per_day: number;
}

export interface BlogSchedule {
  enabled: boolean;
  /** 1..3 */
  posts_per_week: number;
  preferred_days: WeekdayKey[];
  /** "HH:MM" 24h wall-clock time. */
  preferred_time: string;
}

// Video reels carry two extra knobs beyond the publication shape: the rendered
// aspect ratio to publish and which platform(s) to target.
export type VideoRatio = "9:16" | "1:1" | "16:9";
export type VideoPlatform = "facebook" | "instagram" | "both";

export const VIDEO_RATIOS: readonly VideoRatio[] = ["9:16", "1:1", "16:9"];
export const VIDEO_PLATFORMS: readonly VideoPlatform[] = ["facebook", "instagram", "both"];

export interface VideoSchedule extends PublicationSchedule {
  /** Rendered aspect ratio to publish (selects the matching demand-gen asset). */
  ratio: VideoRatio;
  /** Target platform(s); intersected with the brand's active channels at publish time. */
  platform: VideoPlatform;
}

export const DEFAULT_PUBLICATION_SCHEDULE: PublicationSchedule = {
  enabled: true,
  slots: [
    { day: "mon", times: ["09:00", "12:00", "18:00"] },
    { day: "wed", times: ["09:00", "18:00"] },
    { day: "fri", times: ["09:00", "12:00", "18:00"] },
    { day: "sat", times: ["10:00"] },
  ],
  timezone: "America/Toronto",
  max_per_day: 3,
};

// posts_per_week is counted PER ARTICLE, not per bilingual pair — reserveBlogPublishSlot
// takes one slot for FR and one for EN. The cron runs twice a week (Mon + Thu) and each run
// produces a pair, so 2 runs x 2 languages = 4. A lower cap silently blocks the late run's
// articles from ever publishing while still paying for their generation.
export const DEFAULT_BLOG_SCHEDULE: BlogSchedule = {
  enabled: true,
  posts_per_week: 4,
  preferred_days: ["mon", "thu"],
  preferred_time: "08:00",
};

// Video reels publish on their OWN schedule, independent of social posts and the blog
// (same shape as PublicationSchedule). Lighter default cadence than social.
export const DEFAULT_VIDEO_SCHEDULE: VideoSchedule = {
  enabled: true,
  slots: [
    { day: "wed", times: ["10:00"] },
    { day: "fri", times: ["10:00"] },
    { day: "sat", times: ["10:00"] },
  ],
  timezone: "America/Toronto",
  max_per_day: 2,
  ratio: "9:16",
  platform: "both",
};

// Content-scale chantier's 3 batch video formats each get their OWN dedicated recurring
// grid (plain PublicationSchedule shape — no ratio/platform knob, unlike video_schedule:
// these are always 9:16 vertical, published to 'facebook' only, per the batch scripts).
// Distinct weekday/time from publication_schedule and video_schedule on purpose — real
// collisions on the shared (platform, scheduled_at) slot are then rare rather than
// designed-in, though getNextAvailableSlot's retry-on-collision still covers the rare case.
// Cadence is sized to the backlog each format had at launch (2026-09-21): demand_gen_ext 4,
// before_after 10 (biggest, so 2/day), assembly 9 (daily — its UGC-clip pool is small, ~90
// SKUs total, so it won't refill fast).
export const DEFAULT_DEMAND_GEN_EXT_SCHEDULE: PublicationSchedule = {
  enabled: true,
  slots: [
    { day: "mon", times: ["09:15"] },
    { day: "wed", times: ["09:15"] },
    { day: "fri", times: ["09:15"] },
  ],
  timezone: "America/Toronto",
  max_per_day: 1,
};

export const DEFAULT_BEFORE_AFTER_SCHEDULE: PublicationSchedule = {
  enabled: true,
  slots: [
    { day: "tue", times: ["13:00", "13:30"] },
    { day: "thu", times: ["13:00", "13:30"] },
    { day: "sat", times: ["11:00"] },
  ],
  timezone: "America/Toronto",
  max_per_day: 2,
};

// pSEO guide deferred publish — operator approval no longer publishes immediately (see
// guide-scheduler.ts); it books the next free slot on THIS grid instead. Default cadence is
// Mat's explicit "1-2 guides/week, spaced" ask: Tuesday + Friday, one per day, so guides never
// all land on the same day.
export const DEFAULT_GUIDE_SCHEDULE: PublicationSchedule = {
  enabled: true,
  slots: [
    { day: "tue", times: ["10:00"] },
    { day: "fri", times: ["10:00"] },
  ],
  timezone: "America/Toronto",
  max_per_day: 1,
};

export const DEFAULT_ASSEMBLY_SCHEDULE: PublicationSchedule = {
  enabled: true,
  slots: [
    { day: "mon", times: ["17:00"] },
    { day: "tue", times: ["17:00"] },
    { day: "wed", times: ["17:00"] },
    { day: "thu", times: ["17:00"] },
    { day: "fri", times: ["17:00"] },
    { day: "sat", times: ["17:00"] },
    { day: "sun", times: ["17:00"] },
  ],
  timezone: "America/Toronto",
  max_per_day: 1,
};

// ─── Slideshow content settings ─────────────────────────────────────
// Operator controls for the slideshow/montage content engine (Module G). The
// template keys mirror SlideshowTemplate in src/lib/slideshow/types.ts but are
// kept as plain string literals here so config has no dependency on the render
// engine (which pulls in ffmpeg/sharp).
export type SlideshowTemplateKey =
  | "SHOWCASE"
  | "BEST_SELLERS"
  | "PRICE_DROP"
  | "URGENCY"
  | "LOOKBOOK"
  | "DISCOVERY"
  | "COUNTDOWN"
  | "REMIX";

export const SLIDESHOW_TEMPLATE_KEYS: readonly SlideshowTemplateKey[] = [
  "SHOWCASE",
  "BEST_SELLERS",
  "PRICE_DROP",
  "URGENCY",
  "LOOKBOOK",
  "DISCOVERY",
  "COUNTDOWN",
  "REMIX",
];

/** Human labels (FR) for the slideshow templates, used by the settings UI. */
export const SLIDESHOW_TEMPLATE_LABELS: Record<SlideshowTemplateKey, string> = {
  SHOWCASE: "Showcase (un produit, multi-angles)",
  BEST_SELLERS: "Meilleurs vendeurs",
  PRICE_DROP: "Rabais en cours",
  URGENCY: "Urgence (stock faible)",
  LOOKBOOK: "Lookbook (par catégorie)",
  DISCOVERY: "Découverte",
  COUNTDOWN: "Top 5 / Countdown saisonnier",
  REMIX: "Remix thématique",
};

export interface SlideshowSettings {
  /**
   * Per-template enable toggles. These gate FUTURE automated generation
   * (cron/Modules C–F); the manual generation panel can still produce any
   * template explicitly chosen by the operator.
   */
  enabled_templates: Record<SlideshowTemplateKey, boolean>;
  /** Default rendered aspect ratio for new slideshows. */
  default_ratio: VideoRatio;
  /** Target platform(s); intersected with the brand's active channels at publish time. */
  platform: VideoPlatform;
}

export const DEFAULT_SLIDESHOW_SETTINGS: SlideshowSettings = {
  enabled_templates: {
    SHOWCASE: true,
    BEST_SELLERS: true,
    PRICE_DROP: true,
    URGENCY: true,
    LOOKBOOK: true,
    DISCOVERY: true,
    COUNTDOWN: true,
    // REMIX needs a prior rendered set (Modules C–F); off until those land.
    REMIX: false,
  },
  default_ratio: "9:16",
  platform: "both",
};

// ─── Settings Allowlist ─────────────────────────────────────────────
// Single source of truth — used by both the API route and the UI.

export const ALLOWED_SETTINGS_KEYS = new Set([
  "social_default_language",
  "social_post_frequency",
  "social_preferred_hour",
  "social_price_drop_threshold",
  "social_min_days_between_reposts",
  "social_hashtags_fr",
  "social_hashtags_en",
  "social_include_price",
  "social_include_link",
  "social_tone",
  "prompt_new_product_fr",
  "prompt_new_product_en",
  "prompt_price_drop_fr",
  "prompt_price_drop_en",
  "prompt_highlight_fr",
  "prompt_highlight_en",
  "social_accent_color",
  "social_text_color",
  "social_store_display_name",
  "social_banner_opacity",
  "social_logo_position",
  // Auto-post price drop settings
  "social_autopost_enabled",
  "social_autopost_min_drop_percent",
  "social_autopost_max_per_day",
  "social_autopost_channels",
  // Publication schedule (JSON blobs, edited via /api/settings/schedule).
  // blog_schedule (BlogSchedule) carries posts_per_week — the blog auto-publish weekly cap.
  "publication_schedule",
  "blog_schedule",
  // video_schedule (PublicationSchedule shape) — independent reel/video cadence.
  "video_schedule",
  // Per-format recurring grids for the content-scale chantier's 3 batch video formats
  // (PublicationSchedule shape each, edited via the generic /api/settings route — no
  // dedicated schedule-tab UI for these yet).
  "demand_gen_ext_schedule",
  "before_after_schedule",
  "assembly_schedule",
  // guide_schedule (PublicationSchedule shape) — pSEO guide deferred-publish cadence.
  "guide_schedule",
]);
