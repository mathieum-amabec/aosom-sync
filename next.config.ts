import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The branded image compositor reads Logo/*.png at runtime. These live outside
  // the route's traced module graph, so include them explicitly in the function
  // bundle for /api/image-preview (the only route that composes branded images).
  outputFileTracingIncludes: {
    "/api/image-preview": ["./Logo/logo-fr.png", "./Logo/logo-en.png"],
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
