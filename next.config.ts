import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The FFmpeg slideshow render (reached via the publish/cron routes) reads the DM Sans
  // + Noto Emoji TTFs at runtime (not via the module graph), registered with fontconfig
  // (see register-brand-fonts.ts) so slide text renders in DM Sans and the CTA emoji
  // ("Lien en bio 👆") renders instead of tofu boxes on the Vercel render host. The
  // emoji font MUST be traced alongside DM Sans, else fontconfig references a font that
  // isn't in the bundle. (Social photo posts are raw — no logo/watermark tracing.)
  outputFileTracingIncludes: {
    "/api/cron/publisher": ["./src/fonts/DMSans-Regular.ttf", "./src/fonts/DMSans-Bold.ttf", "./src/fonts/NotoEmoji.ttf"],
    "/api/cron/social": ["./src/fonts/DMSans-Regular.ttf", "./src/fonts/DMSans-Bold.ttf", "./src/fonts/NotoEmoji.ttf"],
    "/api/social": ["./src/fonts/DMSans-Regular.ttf", "./src/fonts/DMSans-Bold.ttf", "./src/fonts/NotoEmoji.ttf"],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          {
            key: "Content-Security-Policy",
            // unsafe-eval removed for production hardening; unsafe-inline kept for Next.js inline scripts
            //
            // media-src is REQUIRED, not cosmetic: without it <video> falls back to
            // default-src 'self', which blocks every dashboard preview — the Reels and
            // sequential-ad renders are served from the public Vercel Blob store, and the
            // client also plays freshly rendered clips from blob: URLs. This directive is
            // what makes those previews play at all.
            value:
              "default-src 'self'; " +
              "script-src 'self' 'unsafe-inline'; " +
              "style-src 'self' 'unsafe-inline'; " +
              "img-src 'self' https: data:; " +
              "media-src 'self' blob: https://jcskqp8orcub9i0l.public.blob.vercel-storage.com; " +
              "font-src 'self'; " +
              "connect-src 'self' https://api.anthropic.com https://graph.facebook.com; " +
              "frame-ancestors 'none';",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
