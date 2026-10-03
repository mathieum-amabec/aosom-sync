# Ameublo — the store mascot

Ameublo (FR) / Furni (EN) is the storefront assistant's character: a little gold armchair with
a face, created 2026-10-02. It replaced the chat bubble: the floating button IS the mascot.

- `ameublo-mascot.svg` — the neutral pose, standalone (480×480, scalable). Use it for social
  posts, emails, video overlays.
- `ameublo-poses.html` — the four animated poses (idle, wave, thinking, happy), with the exact CSS
  used on the site. Open it in a browser.
- Live copy: `shopify-theme/snippets/lc-assistant-widget.liquid` (inline SVG + CSS animations).

Palette: gold `#D4A853` (body), light gold `#E2BC6E` (backrest / armrest tops), deep gold
`#C99A43` (seat), cream `#FBF3E2` (cushion), wood `#8A5A2B` (legs), navy `#1B2A47` (eyes,
mouth), cheeks `#E9897E` at 55 %.

Rig (SVG groups): `am-all` (whole character: hop) › `am-body` (breathing) › `am-face`
(`am-eye` ×2 with `am-pupil`, `am-eye-happy`, `am-mouth-smile`, `am-mouth-o`); `am-arm-r` (the
right armrest is the waving arm); `am-think` (thought dots).

For videos: render frames of `ameublo-poses.html` in a headless browser with a transparent
background (e.g. Playwright `omitBackground: true`), or hand the SVG to an illustrator as the
brief for a richer v2 (turnaround + more expressions) so every appearance stays on-model.

## In videos — "Ameublo présente" (free, automated)

- `src/lib/ameublo-sprite.ts` draws any frame from parameters (eyes, mouth, gaze, both arms, hop,
  seasonal accessory), using this same drawing, so he is identical in every video.
  `ameubloPoseAt` is the choreography: pop in, wave, point at a speech bubble, wave goodbye.
- `src/lib/video-engines/ameublo-overlay.ts` lays him over any vertical clip with ffmpeg (0 $ per
  video). In the sequential ads: `scripts/render-sequential-ads.mts … --ameublo`.
- AI-generated reference sheets (multi-angle, expressions, costumes) exist as a v2 exploration,
  outside the repo. Any paid generation (Gemini Image, Veo, Kling…) needs Mat's OK first.
