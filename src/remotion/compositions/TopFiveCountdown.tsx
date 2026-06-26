/**
 * "Top 5 du mois" — a 9:16 countdown Reel (Module D).
 *
 * Counts DOWN from #5 to #1 (the #1 best seller gets a longer winner beat),
 * each rank sliding in from the bottom over a dark, gold-accented stage. Props
 * are the raw best-seller `ProductItem[]` (exactly 5); the composition resolves
 * the Shopify-CDN photo (`images[0]`), cleans the title with formatVideoTitle,
 * formats the price per language, and shows a gold discount badge only when the
 * derived compare-at is ≥ 10% above price (the project-wide badge rule).
 *
 * All imports here are RELATIVE on purpose: the Remotion bundler does not read
 * the app's `@/*` tsconfig path alias, so the composition stays self-contained
 * (it only reaches into pure, dependency-free lib modules).
 */
import { AbsoluteFill, Img, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { ProductItem } from "../../lib/selectors/types";
import { formatVideoTitle } from "../../lib/video-title-utils";
import { VIDEO_BRAND } from "../../lib/video-brand-tokens";
// Share the canonical badge/discount predicate so the rendered video agrees with
// the dry-run manifest (which also uses validate.ts) — including the float
// tolerance for an exact 10% off. validate.ts is pure (no @/ alias, no heavy
// deps), so it bundles cleanly into the Remotion composition.
import { shouldShowBadge, discountPct } from "../../lib/slideshow/validate";
import { computeCountdownTiming, COUNTDOWN_WIDTH, COUNTDOWN_HEIGHT } from "../timing";

export type CountdownBrand = "ameublo" | "furnish";
export type CountdownLanguage = "fr" | "en";

export interface TopFiveCountdownProps {
  /** Best sellers, best-first (index 0 = #1). The engine passes exactly 5. */
  items: ProductItem[];
  brand: CountdownBrand;
  language: CountdownLanguage;
}

const STAGE = "#0E1116";
const STAGE_2 = "#161B26";
const GOLD = VIDEO_BRAND.colors.gold;
const OFF_WHITE = VIDEO_BRAND.colors.offWhite;
const FONT = `"${VIDEO_BRAND.font.family}", system-ui, Arial, sans-serif`;

const STORE_URL: Record<CountdownBrand, string> = {
  ameublo: "ameublodirect.ca",
  furnish: "furnishdirect.ca",
};

function introCopy(language: CountdownLanguage): { kicker: string; title: string } {
  return language === "en"
    ? { kicker: "BEST SELLERS", title: "TOP 5" }
    : { kicker: "MEILLEURES VENTES", title: "TOP 5" };
}

function ctaCopy(language: CountdownLanguage): string {
  return language === "en" ? "Shop now" : "Magasinez maintenant";
}

/** Price for the overlay: CA convention — "249.99 $" (fr) / "$249.99" (en). */
function formatCountdownPrice(price: number, language: CountdownLanguage): string {
  const v = Number(price).toFixed(2);
  return language === "en" ? `$${v}` : `${v} $`;
}

/** Clean overlay title — no supplier brand, no ellipsis, never mid-word. */
function titleOf(item: ProductItem, language: CountdownLanguage): string {
  const raw = language === "en" ? item.title_en : item.title_fr;
  return formatVideoTitle(raw, 34, { uppercase: false, aggressive: false });
}

/** Slide-in-from-bottom wrapper driven by a spring on its first `enterFrames`. */
function Rise({
  children,
  delay = 0,
  distance = 140,
}: {
  children: React.ReactNode;
  delay?: number;
  distance?: number;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - delay, fps, config: { damping: 200 }, durationInFrames: 16 });
  const translateY = interpolate(enter, [0, 1], [distance, 0]);
  const opacity = interpolate(enter, [0, 1], [0, 1]);
  return <div style={{ transform: `translateY(${translateY}px)`, opacity }}>{children}</div>;
}

function IntroCard({ language }: { language: CountdownLanguage }) {
  const { kicker, title } = introCopy(language);
  return (
    <AbsoluteFill style={{ background: STAGE, alignItems: "center", justifyContent: "center" }}>
      <Rise>
        <div style={{ textAlign: "center", fontFamily: FONT }}>
          <div style={{ color: GOLD, fontSize: 56, fontWeight: 700, letterSpacing: 8 }}>{kicker}</div>
          <div style={{ color: OFF_WHITE, fontSize: 320, fontWeight: 700, lineHeight: 1 }}>{title}</div>
          <div style={{ width: 240, height: 8, background: GOLD, margin: "40px auto 0" }} />
        </div>
      </Rise>
    </AbsoluteFill>
  );
}

function OutroCard({ brand, language }: { brand: CountdownBrand; language: CountdownLanguage }) {
  return (
    <AbsoluteFill style={{ background: STAGE, alignItems: "center", justifyContent: "center" }}>
      <Rise>
        <div style={{ textAlign: "center", fontFamily: FONT }}>
          <div style={{ color: GOLD, fontSize: 92, fontWeight: 700 }}>{STORE_URL[brand]}</div>
          <div style={{ color: OFF_WHITE, fontSize: 56, marginTop: 28 }}>{ctaCopy(language)}</div>
        </div>
      </Rise>
    </AbsoluteFill>
  );
}

function RevealCard({
  item,
  rank,
  language,
  winner,
}: {
  item: ProductItem;
  rank: number;
  language: CountdownLanguage;
  winner: boolean;
}) {
  const image = item.images?.[0];
  const pct = shouldShowBadge(item.price, item.compare_at_price)
    ? discountPct(item.price, item.compare_at_price)
    : undefined;
  return (
    <AbsoluteFill style={{ background: `linear-gradient(180deg, ${STAGE} 0%, ${STAGE_2} 100%)` }}>
      {/* Rank number, large and gold, pinned top-left. */}
      <Rise distance={90}>
        <div
          style={{
            position: "absolute",
            top: 70,
            left: 70,
            fontFamily: FONT,
            fontWeight: 700,
            fontSize: winner ? 260 : 200,
            color: GOLD,
            lineHeight: 0.9,
          }}
        >
          #{rank}
        </div>
      </Rise>

      {/* Product photo, centered in the upper two-thirds. */}
      <Rise delay={4}>
        <div
          style={{
            position: "absolute",
            top: 360,
            left: 90,
            width: COUNTDOWN_WIDTH - 180,
            height: 900,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {image ? (
            <Img src={image} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", borderRadius: 24 }} />
          ) : (
            <div style={{ width: "100%", height: "100%", background: STAGE_2, borderRadius: 24 }} />
          )}
        </div>
      </Rise>

      {/* Title + price + optional discount badge, lower third. */}
      <Rise delay={8}>
        <div style={{ position: "absolute", left: 90, right: 90, top: 1320, fontFamily: FONT }}>
          <div style={{ width: 160, height: 6, background: GOLD, marginBottom: 28 }} />
          <div style={{ color: OFF_WHITE, fontSize: 64, fontWeight: 700, lineHeight: 1.05 }}>
            {titleOf(item, language)}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 28, marginTop: 28 }}>
            <span style={{ color: GOLD, fontSize: 96, fontWeight: 700 }}>
              {formatCountdownPrice(item.price, language)}
            </span>
            {pct !== undefined && item.compare_at_price !== undefined ? (
              <>
                <span
                  style={{
                    color: OFF_WHITE,
                    fontSize: 48,
                    opacity: 0.7,
                    textDecoration: "line-through",
                  }}
                >
                  {formatCountdownPrice(item.compare_at_price, language)}
                </span>
                <span
                  style={{
                    background: GOLD,
                    color: VIDEO_BRAND.colors.navy,
                    fontSize: 44,
                    fontWeight: 700,
                    padding: "8px 24px",
                    borderRadius: 40,
                  }}
                >
                  -{pct}%
                </span>
              </>
            ) : null}
          </div>
        </div>
      </Rise>
    </AbsoluteFill>
  );
}

/**
 * The full countdown. Lays out intro → ranked reveals (5→1) → outro using the
 * shared `computeCountdownTiming` model so it matches the Node-side manifest.
 */
export function TopFiveCountdown({ items, brand, language }: TopFiveCountdownProps) {
  const timing = computeCountdownTiming(items.length);
  return (
    <AbsoluteFill style={{ background: STAGE }}>
      <Sequence durationInFrames={timing.introFrames}>
        <IntroCard language={language} />
      </Sequence>

      {timing.segments.map((seg) => {
        const item = items[seg.itemIndex];
        if (!item) return null;
        return (
          <Sequence key={seg.rank} from={seg.from} durationInFrames={seg.durationInFrames}>
            <RevealCard item={item} rank={seg.rank} language={language} winner={seg.rank === 1} />
          </Sequence>
        );
      })}

      <Sequence
        from={timing.durationInFrames - timing.outroFrames}
        durationInFrames={timing.outroFrames}
      >
        <OutroCard brand={brand} language={language} />
      </Sequence>
    </AbsoluteFill>
  );
}
