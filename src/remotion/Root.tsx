/**
 * Remotion composition registry (Module D).
 *
 * Registers the single `TopFiveCountdown` 9:16 composition. `durationInFrames`
 * is data-driven: it defaults to the canonical 5-item length but is recomputed
 * per render from the actual number of input items via `calculateMetadata`, so a
 * short set never leaves dead frames at the end.
 */
import { Composition } from "remotion";
import { TopFiveCountdown, type TopFiveCountdownProps } from "./compositions/TopFiveCountdown";
import {
  computeCountdownTiming,
  COUNTDOWN_FPS,
  COUNTDOWN_WIDTH,
  COUNTDOWN_HEIGHT,
} from "./timing";

const DEFAULT_PROPS: TopFiveCountdownProps = {
  items: [],
  brand: "ameublo",
  language: "fr",
};

export function RemotionRoot() {
  return (
    <Composition
      id="TopFiveCountdown"
      component={TopFiveCountdown}
      durationInFrames={computeCountdownTiming(5).durationInFrames}
      fps={COUNTDOWN_FPS}
      width={COUNTDOWN_WIDTH}
      height={COUNTDOWN_HEIGHT}
      defaultProps={DEFAULT_PROPS}
      calculateMetadata={({ props }) => ({
        durationInFrames: computeCountdownTiming(Math.max(1, props.items.length || 5)).durationInFrames,
      })}
    />
  );
}
