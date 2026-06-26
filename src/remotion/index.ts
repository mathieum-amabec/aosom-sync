/**
 * Remotion bundle entry point (Module D).
 *
 * `buildCountdown` (src/lib/slideshow/templates/countdown.ts) points
 * @remotion/bundler at THIS file to produce the serve URL it renders from.
 * It must do nothing but register the root — no side effects, no app imports.
 */
import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
