This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Slideshow & carousel content engine

The social-content engine lives under `src/lib/slideshow/` (+ `src/lib/selectors/`) and
renders branded product media from the catalog:

- **Video slideshow** (`render.ts`) and **Top-5 countdown Reel** (`templates/countdown.ts`,
  rendered with [Remotion](https://remotion.dev) in `src/remotion/`).
- **Image carousels** (`carousel/`) — branded square/portrait PNGs via Sharp.

Every renderer supports a **dry run** (`dryRun: true`) that returns a manifest and writes
nothing — no image download, no Remotion/Sharp/ffmpeg, no Blob upload. Real renders upload to
the **public** Vercel Blob store (Meta/YouTube fetch the asset URLs directly).

> **Real Remotion rendering runs OFF a standard Vercel function.** `buildCountdown`'s real path
> bundles `src/remotion` (referenced by source path, not traced by Next) and launches a headless
> Chromium via `@remotion/renderer` — neither is available in a plain serverless function. Run it
> on a host that has the repo source + a browser (a dedicated render worker, a CI/box run, or
> `@remotion/lambda`); load DM Sans on that host for brand-correct text. The carousel (Sharp) and
> video slideshow (ffmpeg) real paths run on the standard Node runtime; only the Remotion countdown
> needs the dedicated host. The `dryRun` manifest path runs anywhere.

> **⚠️ Remotion licence.** Remotion is **free** for individuals and companies with **≤ 3
> employees** (our current case). Teams above that threshold need a paid **company licence**
> (~$100/month). See the [Remotion licence](https://remotion.dev/license). Re-evaluate before
> the team grows past 3 employees.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
