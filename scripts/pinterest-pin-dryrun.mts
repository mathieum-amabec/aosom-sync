// Render the exact Pinterest Pin that would be published for a product, WITHOUT sending it.
//
//   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/pinterest-pin-dryrun.mts <SKU>
//   …                                                                            <SKU> --apply
//
// Dry-run needs NO credentials: PinterestClient records the payload instead of sending, so
// the whole Pin can be reviewed before the Pinterest app even exists. `--apply` requires
// PINTEREST_ACCESS_TOKEN + PINTEREST_BOARD_ID and will refuse without them.
//
// ⚠ PINTEREST_TAG_ID is NOT one of them. It is the storefront conversion tag served by
// /api/pixel/pinterest-script — a public identifier that authorizes nothing. Verified
// against the live API on 2026-08-18: passing it as a Bearer token returns
// `401 {"code":2,"message":"Authentication failed."}`, on the Ads endpoints as well as
// /v5/pins. See docs/PINTEREST-SETUP.md.
//
// IMPORTS: runtime values via DYNAMIC import, types via `import type` — tsx transpiles
// src/**/*.ts to CJS and node's ESM loader cannot see named exports across that boundary.
// Same convention as scripts/create-google-shopping-campaign.mts.
import type { PinInput } from "@/lib/pinterest-client";

const { pinterestClientFromEnv, composePinDescription, missingPinterestEnv, PinterestClient, readPinterestCredentials } =
  await import("@/lib/pinterest-client");
const { getProduct } = await import("@/lib/database");

const args = process.argv.slice(2);
const sku = args.find((a) => !a.startsWith("--"));
const APPLY = args.includes("--apply");

function fail(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

if (!sku) fail("Usage: pinterest-pin-dryrun.mts <SKU> [--apply]");

const product = await getProduct(sku);
if (!product) fail(`SKU introuvable dans le catalogue : ${sku}`);

const shopifyHandle = (product as { shopify_handle?: string | null }).shopify_handle ?? null;
if (!shopifyHandle) {
  fail(
    `${sku} n'a pas de handle Shopify — le produit n'est pas en boutique, il n'y a pas de PDP à épingler.`,
  );
}

const image = (product as { image1?: string | null }).image1 ?? null;
if (!image) fail(`${sku} n'a aucune image — Pinterest récupère l'image côté serveur, une URL est obligatoire.`);

const price = Number((product as { price?: number | null }).price ?? Number.NaN);
const title = String((product as { name?: string }).name ?? sku);

// products.name is the RAW ENGLISH Aosom title; the curated FR title lives only on the
// Shopify product. Flagged rather than silently pinned in the wrong language.
const pin: PinInput = {
  title,
  description: composePinDescription({
    caption: String((product as { short_description?: string | null }).short_description ?? title),
    priceCad: Number.isFinite(price) ? price : null,
    brand: "Ameublo Direct",
  }),
  link: `https://ameublodirect.ca/products/${shopifyHandle}`,
  imageUrl: image,
  altText: title,
};

const missing = missingPinterestEnv();
const creds = readPinterestCredentials();
if (APPLY && !creds) {
  fail(
    `Credentials Pinterest absentes : ${missing.join(", ")}\n` +
      "  Le compte Pinterest n'est pas encore provisionné. Suivre docs/PINTEREST-SETUP.md —\n" +
      "  la revendication du domaine prend quelques jours et bloque les Rich Pins.\n" +
      "  Le dry-run (sans --apply) fonctionne sans credentials.",
  );
}

const client = APPLY ? new PinterestClient(creds) : pinterestClientFromEnv({});

console.log(`
════════════════════════════════════════════════════════════════════════════
  ${APPLY ? "CRÉATION" : "DRY-RUN"} — Épingle Pinterest pour ${sku}
════════════════════════════════════════════════════════════════════════════

  Board        ${client.boardId}
  Titre        ${pin.title}
  Lien         ${pin.link}
  Image        ${pin.imageUrl}
  Prix         ${Number.isFinite(price) ? price.toFixed(2) + " $ CAD" : "(inconnu)"}

  Description
${pin.description.split("\n").map((l) => "    " + l).join("\n")}
`);

const res = await client.createPin(pin);

console.log("─ Corps de requête (POST /v5/pins) ─────────────────────────────────────────");
console.log(JSON.stringify(client.plan[0]?.body, null, 2));

if (APPLY) {
  console.log(`\n✓ Épingle créée : ${res.url}`);
} else {
  console.log(`
─ Avertissements ───────────────────────────────────────────────────────────
  ⚠ Le titre vient de products.name, qui est le libellé ANGLAIS brut d'Aosom.
    Le titre FR curaté n'existe que sur le produit Shopify — le brancher avant
    toute publication réelle, sinon les Épingles partent en anglais.
  ⚠ L'image est products.image1 (fond blanc en position 1), pas forcément la
    photo lifestyle. Pinterest performe nettement mieux en lifestyle.

════════════════════════════════════════════════════════════════════════════
  Rien n'a été envoyé. Pour créer :
    node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs \\
      scripts/pinterest-pin-dryrun.mts ${sku} --apply
════════════════════════════════════════════════════════════════════════════`);
}
