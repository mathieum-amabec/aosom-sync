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
  get unsplashAppName(): string {
    return process.env.UNSPLASH_APP_NAME || "aosom-sync";
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
  ADMIN_ARTICLE_URL: (id: string | number) =>
    `${SHOPIFY.ADMIN_URL}/articles/${id}`,
  // Auto-publish: an article goes live only if Claude's quality judge scores it at/above
  // this (0-100) AND its topic is in season AND the weekly cap isn't reached. The weekly
  // cap + on/off switch live in the `blog_schedule` setting (BlogSchedule.posts_per_week /
  // .enabled), edited via /api/settings/schedule.
  AUTO_PUBLISH_SCORE_THRESHOLD: 80,
} as const;

// ─── Aosom Feed ─────────────────────────────────────────────────────

export const AOSOM = {
  CSV_URL: process.env.AOSOM_FEED_URL || "https://feed-us.aosomcdn.com/390/110_feed/0/0/5e/c4857d.csv",
  FETCH_MAX_RETRIES: 2,
  FETCH_BACKOFF_MS: 5000,
} as const;

// ─── Claude API ─────────────────────────────────────────────────────

export const CLAUDE = {
  MODEL: "claude-sonnet-4-6",
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
 * Used to build absolute, publicly-fetchable URLs for the branded image
 * compositor (`/api/image-preview`): Facebook/Instagram fetch the image
 * themselves, so a relative path or a localhost URL is useless to them.
 *
 * Priority:
 *  1. NEXT_PUBLIC_APP_URL — explicit override (set this for custom domains).
 *  2. VERCEL_PROJECT_PRODUCTION_URL — the STABLE production alias on Vercel.
 *     Deliberately NOT VERCEL_URL, which is a per-deployment preview host
 *     (see api/cron/content/route.ts for the same reasoning).
 *  3. null — caller must skip branding and fall back to raw image URLs rather
 *     than emit a localhost URL that the social platforms can't reach.
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

export const DEFAULT_BLOG_SCHEDULE: BlogSchedule = {
  enabled: true,
  posts_per_week: 2,
  preferred_days: ["tue", "thu"],
  preferred_time: "10:00",
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
]);
