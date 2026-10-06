// Send a Studio Ameublo video to the brand's TikTok inbox as a DRAFT (the owner adds a sound + the caption and taps Publish).
//
//   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/tiktok-draft.mts <videoId>            # dry run
//   …                                                              scripts/tiktok-draft.mts <videoId> --apply    # really uploads
//
// The brand follows the video's language: FR -> the Ameublo Direct account, EN -> the Furnish Direct account (each authorized
// once with scripts/tiktok-oauth.mts). Dry run needs no credentials and sends/downloads NOTHING. TikTok drafts carry no
// caption, so the text to paste is printed — and it is the Studio's own caption, links removed (they are not clickable on TikTok).
const { TikTokClient, tiktokCaptionToPaste } = await import("@/lib/tiktok-client");
const { resolveTikTokCredentials } = await import("@/lib/tiktok-auth");
const { getAmeubloTestVideo } = await import("@/lib/database");

const args = process.argv.slice(2);
const id = Number(args.find((a) => !a.startsWith("--") && /^\d+$/.test(a)));
const APPLY = args.includes("--apply");

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}
if (!Number.isInteger(id) || id <= 0) fail("Usage : tiktok-draft.mts <videoId> [--apply]");

const video = await getAmeubloTestVideo(id);
if (!video) fail(`Vidéo #${id} introuvable dans le Studio.`);
if (!video.lang) fail(`Vidéo #${id} sans langue : on ne sait pas vers quel compte TikTok l'envoyer.`);
if (!video.video_url) fail(`Vidéo #${id} sans fichier.`);
const brand = video.lang;

const creds = APPLY ? await resolveTikTokCredentials(brand) : null;
if (APPLY && !creds) fail(`Le compte TikTok « ${brand} » n'est pas autorisé : lance tiktok-oauth.mts url / exchange --brand ${brand}.`);
const client = APPLY ? new TikTokClient(creds) : new TikTokClient(null, { dryRun: true });

const caption = tiktokCaptionToPaste(video.caption ?? "");
console.log(`
════════════════════════════════════════════════════════════════════════════
  ${APPLY ? "ENVOI EN BROUILLON" : "DRY-RUN"} — vidéo #${id} (${brand === "fr" ? "Ameublo Direct" : "Furnish Direct"})${video.label ? ` — ${video.label}` : ""}
════════════════════════════════════════════════════════════════════════════
  Fichier   ${video.video_url}

  Légende à coller dans TikTok (un brouillon n'en porte pas) :
${caption.split("\n").map((l) => "    " + l).join("\n")}
`);

const res = await client.uploadDraft(video.video_url);
for (const s of client.plan) console.log(`  • ${s.step.padEnd(9)} ${s.path}`);
if (APPLY) console.log(`\n✓ Brouillon dans la boîte TikTok (publish_id ${res.publishId}, statut ${res.status}). Ouvre TikTok → boîte de réception : ajoute un son, colle la légende, publie.\n`);
else console.log("\nRien n'a été envoyé. Pour envoyer : ajoute --apply.\n");
