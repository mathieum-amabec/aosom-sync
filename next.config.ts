import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Branded social images read Logo/*.png and the DM Sans TTFs at runtime (not via the
  // module graph), so each route that composes them must trace those assets into its
  // bundle. The TTFs are registered with fontconfig (see register-brand-fonts.ts) so the
  // SVG text renders in DM Sans instead of tofu boxes on the Vercel render host.
  // /api/image-preview composes the branded hero (logo + price + badge); the publish
  // routes additionally stamp the footer watermark.
  outputFileTracingIncludes: {
    "/api/image-preview": [
      "./Logo/logo-fr.png",
      "./Logo/logo-en.png",
      "./src/fonts/DMSans-Regular.ttf",
      "./src/fonts/DMSans-Bold.ttf",
    ],
    "/api/cron/publisher": ["./src/fonts/DMSans-Regular.ttf", "./src/fonts/DMSans-Bold.ttf"],
    "/api/cron/social": ["./src/fonts/DMSans-Regular.ttf", "./src/fonts/DMSans-Bold.ttf"],
    "/api/social": ["./src/fonts/DMSans-Regular.ttf", "./src/fonts/DMSans-Bold.ttf"],
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
            value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self'; connect-src 'self' https://api.anthropic.com https://graph.facebook.com; frame-ancestors 'none';",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
