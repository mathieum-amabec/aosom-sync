// Render — and optionally create — the Pinterest video Pin for a Studio Ameublo video.
//
//   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/pinterest-video-pin.mts <videoId>
//   …                                                              scripts/pinterest-video-pin.mts <videoId> --apply [--sandbox]
//   …                                                              scripts/pinterest-video-pin.mts <videoId> --cover <image URL>
//
// Default is a DRY RUN: it needs no credentials and sends NOTHING (the client only records the four calls a video Pin
// takes: register media, upload, wait for processing, create the Pin). `--apply` creates the Pin with the stored OAuth
// tokens (scripts/pinterest-oauth.mts) + PINTEREST_BOARD_ID. While the app is on Trial access use --sandbox: the Pin is
// created in the sandbox, visible to nobody but you.
//
// The Pin links to the product page of the video's FIRST sku; a video with no product is refused (a Pin without a
// destination is worth nothing). The cover defaults to that product's photo; pass --cover for a better one.
import type { VideoPinInput } from "@/lib/pinterest-client";

const { PinterestClient } = await import("@/lib/pinterest-client");
const { resolvePinterestCredentials } = await import("@/lib/pinterest-auth");
const { studioVideoToPin } = await import("@/lib/pinterest-video");
const { getAmeubloTestVideo, getProduct } = await import("@/lib/database");

const args = process.argv.slice(2);
const id = Number(args.find((a) => !a.startsWith("--") && /^\d+$/.test(a)));
const APPLY = args.includes("--apply");
const SANDBOX = args.includes("--sandbox");
const coverIdx = args.indexOf("--cover");
const cover = coverIdx >= 0 ? args[coverIdx + 1] : undefined;

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}
if (!Number.isInteger(id) || id <= 0) fail("Usage : pinterest-video-pin.mts <videoId> [--apply] [--sandbox] [--cover <url>]");

const video = await getAmeubloTestVideo(id);
if (!video) fail(`Vidéo #${id} introuvable dans le Studio.`);
const sku = video.skus?.[0] ?? video.sku?.split(",")[0]?.trim() ?? null;
const product = sku ? await getProduct(sku) : null;
const mapped = studioVideoToPin(
  video,
  product ? { shopify_handle: (product as { shopify_handle?: string | null }).shopify_handle ?? null, image1: (product as { image1?: string | null }).image1 ?? null } : null,
  { coverImageUrl: cover },
);
if (!mapped.ok) fail(`Vidéo #${id} non épinglable : ${mapped.reason}`);
const input: VideoPinInput = mapped.input;

if (SANDBOX) process.env.PINTEREST_ENV = "sandbox";
const creds = APPLY ? await resolvePinterestCredentials() : null;
if (APPLY && !creds) fail("Pas de jeton ou de tableau : lance pinterest-oauth.mts (url, exchange) et mets PINTEREST_BOARD_ID dans .env.local.");
const client = APPLY ? new PinterestClient(creds) : new PinterestClient(null, { dryRun: true });

console.log(`
════════════════════════════════════════════════════════════════════════════
  ${APPLY ? `CRÉATION${creds?.sandbox ? " (SANDBOX)" : ""}` : "DRY-RUN"} — Épingle vidéo Pinterest pour la vidéo #${id} (${video.lang})
════════════════════════════════════════════════════════════════════════════
  Tableau   ${client.boardId}
  Titre     ${input.title}
  Lien      ${input.link}
  Vidéo     ${input.videoUrl}
  Couverture ${input.coverImageUrl}

  Description
${input.description.split("\n").map((l) => "    " + l).join("\n")}
`);

const res = await client.createVideoPin(input);
for (const s of client.plan) console.log(`  • ${s.step.padEnd(14)} ${s.path}`);
if (APPLY) console.log(`\n✓ Épingle créée : ${res.url}\n`);
else console.log("\nRien n'a été envoyé. Pour créer : ajoute --apply (et --sandbox tant que l'accès est « Trial »).\n");
