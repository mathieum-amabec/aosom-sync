import React from "react";
import { Composition, staticFile, continueRender, delayRender } from "remotion";
import { Ad } from "./Ad";
import inputs from "../v3-inputs.json";

// The brand face, loaded the same way the ffmpeg run loads it (the same TTF file).
// A missing font is the classic silent difference between two renders, so it is registered
// explicitly and the render is held until it is ready.
const handle = delayRender("DMSans");
const font = new FontFace("DMSans", `url(${staticFile("brand/DMSans.ttf")}) format("truetype")`);
font
  .load()
  .then(() => {
    document.fonts.add(font);
    continueRender(handle);
  })
  .catch(() => continueRender(handle));

const D = inputs.design;

export const RemotionRoot: React.FC = () => (
  <>
    {inputs.clips.map((c) => (
      <Composition
        key={c.sku}
        id={c.sku.replace(/[^A-Za-z0-9-]/g, "")}
        component={Ad}
        durationInFrames={D.fps * D.durationSec}
        fps={D.fps}
        width={D.width}
        height={D.height}
        defaultProps={{
          sku: c.sku,
          sourceClipFile: `${c.sku}.mp4`,
          visionSegmentStartSec: c.visionSegmentStartSec,
          textZone: c.textZone as "top" | "bottom",
          messages: c.messages,
          fontSizes: c.fontSizes,
          music: c.music,
          design: {
            barHeight: D.barHeight,
            navy: D.navy,
            gold: D.gold,
            windows: D.windows as [number, number][],
            pushIn: D.pushIn,
            wordRevealGapSec: D.wordRevealGapSec,
            hookRevealStartSec: D.hookRevealStartSec,
            keyline: D.keyline,
            flash: D.flash,
            pricePopScale: D.pricePopScale,
            pricePopSec: D.pricePopSec,
          },
        }}
      />
    ))}
  </>
);
