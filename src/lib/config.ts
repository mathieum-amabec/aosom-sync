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
  get storeName(): string {
    return process.env.NEXT_PUBLIC_STORE_NAME || "Aosom Sync";
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

// ─── Aosom Feed ─────────────────────────────────────────────────────

export const AOSOM = {
  CSV_URL: process.env.AOSOM_FEED_URL || "https://feed-us.aosomcdn.com/390/110_feed/0/0/5e/c4857d.csv",
  FETCH_MAX_RETRIES: 2,
  FETCH_BACKOFF_MS: 5000,
} as const;

// ─── Claude API ─────────────────────────────────────────────────────

export const CLAUDE = {
  MODEL: "claude-sonnet-4-20250514",
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

// ─── Sync ───────────────────────────────────────────────────────────

export const SYNC = {
  PRICE_TOLERANCE: 0.01,
  DEFAULT_PRICE_DROP_THRESHOLD: "10",
  DEFAULT_MIN_DAYS_BETWEEN_REPOSTS: "30",
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
]);
