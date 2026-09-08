/**
 * The v3 ad design, rebuilt in React for the Remotion spike.
 *
 * Every constant here is read from v3-inputs.json, which was captured verbatim from the
 * ffmpeg run's own stdout. The engine is the ONLY variable being changed.
 *
 * The three ffmpeg limitations this exists to test are marked ★ in the code below:
 *   ★1 gold keyline — an animated WIDTH. ffmpeg does this, but the sibling case (animated
 *      alpha inside a drawbox colour) is flatly rejected, so opacity and width had to be
 *      driven by different mechanisms.
 *   ★2 price pop — an animated fontSize. This SEGFAULTS ffmpeg 8.1.1 mid-encode.
 *   ★3 word-by-word hook — ffmpeg cannot report text width, so v3 computes every word's x
 *      in TypeScript from a 0.6-em guess. A browser measures text for real.
 */
import React from "react";
import {
  AbsoluteFill, Audio, Img, OffthreadVideo, Sequence,
  interpolate, staticFile, useCurrentFrame, useVideoConfig,
} from "remotion";

export interface MusicSpec {
  track: string;
  startOffsetSec: number;
  tempo: number;
}

export interface AdProps {
  sku: string;
  sourceClipFile: string;
  visionSegmentStartSec: number;
  textZone: "top" | "bottom";
  messages: string[];
  fontSizes: number[];
  music: MusicSpec;
  design: {
    barHeight: number;
    navy: string;
    gold: string;
    windows: [number, number][];
    pushIn: { punchSec: number; punchAmount: number; driftAmount: number; maxZoom: number };
    wordRevealGapSec: number;
    hookRevealStartSec: number;
    keyline: { width: number; height: number; growSec: number };
    flash: { color: string; opacity: number; frames: number };
    pricePopScale: number[];
    pricePopSec: number;
  };
}

/** v3 band geometry, kept to the pixel so the two renders can be diffed. */
function bandFor(textZone: "top" | "bottom") {
  return textZone === "top" ? { top: 210, height: 400 } : { top: 1250, height: 410 };
}

export const Ad: React.FC<AdProps> = ({
  sourceClipFile, visionSegmentStartSec, textZone, messages, fontSizes, music, design,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const band = bandFor(textZone);

  // Same two-stage curve as v3: a fast punch over the first 1.2 s, then a slow drift.
  // In ffmpeg this is a zoompan expression string; here it is just arithmetic, which is the
  // first thing that gets easier — the curve is readable and can be unit-tested.
  const punchFrames = Math.round(design.pushIn.punchSec * fps);
  const totalFrames = fps * 15;
  const zoom = Math.min(
    1 +
      design.pushIn.punchAmount * Math.min(frame / punchFrames, 1) +
      design.pushIn.driftAmount * (frame / totalFrames),
    design.pushIn.maxZoom,
  );

  const gradient =
    textZone === "top"
      ? "linear-gradient(to bottom, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.5) 55%, rgba(0,0,0,0) 100%)"
      : "linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.55) 45%, rgba(0,0,0,0.85) 100%)";
  const gradientStyle: React.CSSProperties =
    textZone === "top"
      ? { top: 0, height: band.top + band.height + 120 }
      : { top: band.top - 150, height: height - (band.top - 150) };

  const textShadow = "0 2px 6px rgba(0,0,0,0.6), 0 0 3px rgba(0,0,0,0.55)";

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {/* Footage, cut at the segment Vision picked, with the push-in. */}
      <AbsoluteFill style={{ transform: `scale(${zoom})`, transformOrigin: "center center" }}>
        <OffthreadVideo
          src={staticFile(`clips/${sourceClipFile}`)}
          startFrom={Math.round(visionSegmentStartSec * fps)}
          muted
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>

      {/* Soft gradient over the copy band only — the product keeps its own contrast. */}
      <div style={{ position: "absolute", left: 0, width, background: gradient, ...gradientStyle }} />

      {/* ── one-frame white flash at each message change ── */}
      {design.windows.slice(1).map(([s]) => {
        const at = Math.round(s * fps);
        return frame >= at && frame < at + design.flash.frames ? (
          <AbsoluteFill key={s} style={{ backgroundColor: design.flash.color, opacity: design.flash.opacity }} />
        ) : null;
      })}

      {/* ── the four messages ── */}
      {messages.slice(0, design.windows.length).map((msg, m) => {
        const [s0, e0] = design.windows[m];
        const from = Math.round(s0 * fps);
        const durationInFrames = Math.round((e0 - s0) * fps);
        return (
          <Sequence key={m} from={from} durationInFrames={durationInFrames} layout="none">
            <Message
              index={m}
              text={msg}
              size={fontSizes[m]}
              band={band}
              design={design}
              textShadow={textShadow}
            />
          </Sequence>
        );
      })}

      {/* ── lower third: navy bar, logo plate, gold URL ── */}
      <div
        style={{
          position: "absolute", left: 0, bottom: 0, width, height: design.barHeight,
          backgroundColor: design.navy, opacity: 0.72,
        }}
      />
      <div
        style={{
          position: "absolute", left: 44, bottom: (design.barHeight - 88) / 2,
          width: 340, height: 88, backgroundColor: "rgba(255,255,255,0.92)", borderRadius: 12,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        <Img src={staticFile("brand/logo.png")} style={{ width: 300, objectFit: "contain" }} />
      </div>
      <div
        style={{
          position: "absolute", right: 56, bottom: (design.barHeight - 46) / 2 + 4,
          color: design.gold, fontFamily: "DMSans", fontSize: 46, fontWeight: 700,
          textShadow: "0 1px 2px rgba(0,0,0,0.4)",
        }}
      >
        ameublodirect.ca
      </div>

      {/* Same bed, same entry point, same tempo as the ffmpeg run. */}
      <Audio
        src={staticFile(`audio/${music.track}`)}
        startFrom={Math.round(music.startOffsetSec * fps)}
        playbackRate={music.tempo}
        volume={(f) =>
          interpolate(f, [0, fps * 0.8, totalFrames - fps, totalFrames], [0, 0.22, 0.22, 0], {
            extrapolateLeft: "clamp", extrapolateRight: "clamp",
          })
        }
      />
    </AbsoluteFill>
  );
};

/** One message plus its gold keyline. Local frame: 0 is the message's own entrance. */
const Message: React.FC<{
  index: number;
  text: string;
  size: number;
  band: { top: number; height: number };
  design: AdProps["design"];
  textShadow: string;
}> = ({ index, text, size, band, design, textShadow }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const t = frame / fps;

  const base: React.CSSProperties = {
    position: "absolute", left: 0, width, textAlign: "center",
    fontFamily: "DMSans", fontWeight: 700, color: "white",
    textShadow, lineHeight: 1.28, padding: "0 75px", boxSizing: "border-box",
  };

  // ★1 GOLD KEYLINE — animated width.
  // ffmpeg does the width fine (drawbox w is timeline-evaluated) but REFUSES an animated
  // alpha in the same filter, so v3 could not fade it. Here width and opacity are two CSS
  // properties on one div and both animate without a second thought.
  const keylineW = interpolate(t, [0, design.keyline.growSec], [0, design.keyline.width], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });
  const keylineOpacity = interpolate(t, [0, design.keyline.growSec * 0.6], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  });

  let content: React.ReactNode;
  let entrance: React.CSSProperties = {};

  if (index === 0) {
    // ★3 WORD-BY-WORD HOOK.
    // v3 had to compute every word's x in TypeScript from a 0.6-em width guess, because
    // ffmpeg centres each drawtext independently and cannot report text width. Getting that
    // wrong stacked the whole headline on one spot. Here flexbox lays the words out and the
    // browser measures the glyphs — there is no width estimate to be wrong about.
    const words = text.trim().split(/\s+/);
    content = (
      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: `0 ${size * 0.32}px` }}>
        {words.map((w, i) => (
          <span
            key={`${w}-${i}`}
            style={{
              opacity: interpolate(
                t,
                [design.hookRevealStartSec + i * design.wordRevealGapSec,
                 design.hookRevealStartSec + i * design.wordRevealGapSec + 0.12],
                [0, 1],
                { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
              ),
            }}
          >
            {w}
          </span>
        ))}
      </div>
    );
  } else if (index === 2) {
    // ★2 PRICE POP — animated fontSize.
    // This is the case that segfaults ffmpeg 8.1.1: `fontsize='72*(0.8+0.2*…)'` parses, then
    // crashes mid-encode with an empty stderr. v3 fakes it with three constant-size draws
    // gated by enable= windows. Here it is one continuous interpolation.
    const scale = interpolate(
      t, [0, design.pricePopSec],
      [design.pricePopScale[0], design.pricePopScale[design.pricePopScale.length - 1]],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
    );
    content = <span style={{ display: "inline-block", fontSize: size * scale }}>{text}</span>;
    entrance = { opacity: interpolate(t, [0, 0.18], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) };
  } else {
    const ease = 1 - Math.pow(1 - Math.min(Math.max(t / 0.25, 0), 1), 2);
    entrance = {
      opacity: interpolate(t, [0, 0.2], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
      transform: index === 1 ? `translateY(${(1 - ease) * 140}px)` : `translateX(${(1 - ease) * width}px)`,
    };
    content = <span>{text}</span>;
  }

  return (
    <>
      <div
        style={{
          ...base,
          top: band.top,
          height: band.height,
          fontSize: index === 2 ? undefined : size,
          display: "flex", alignItems: "center", justifyContent: "center",
          ...entrance,
        }}
      >
        {content}
      </div>
      <div
        style={{
          position: "absolute",
          left: (width - keylineW) / 2,
          top: band.top + band.height - 40,
          width: keylineW,
          height: design.keyline.height,
          backgroundColor: design.gold,
          opacity: keylineOpacity,
        }}
      />
    </>
  );
};
