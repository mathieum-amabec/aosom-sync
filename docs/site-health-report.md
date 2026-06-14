# Site Health Report — 2026-06-14

Full read-only verification of the live storefront, feeds, video content, and Turso.
No mutations performed. Generated against production.

## Summary

| Check | Status |
|-------|--------|
| Site live accessible | ✅ |
| Nouveau thème actif | ✅ |
| og:image lifestyle | ✅ |
| Méta-description naturelle | ✅ |
| Feeds Google / Meta / Pinterest OK | ✅ |
| Page « Voyez-le chez vous » accessible | ✅ |
| Produits vidéo publiés | ✅ |
| Turso fonctionnel | ✅ |

**Verdict: 8/8 ✅ — site en santé.**

## ÉTAPE 1 — Storefront live (`scripts/verify-live-storefront.mjs`)

`GET https://ameublodirect.ca/` → **200** (431 263 bytes). All 6 checks pass:

- ✅ Titre hero présent — `Meublez votre espace à votre image` (h1 live: `Meublez votre espace à votre image.`)
- ✅ `<title>` correct — `Ameublo Direct | Meubles et mobiliers extérieurs`
- ✅ og:image présent — `https://ameublodirect.ca/cdn/shop/t/7/assets/og-image-social.jpg` (lifestyle social image)
- ✅ meta description présente + naturelle — `Aménagez votre patio et votre jardin pour l…`
- ✅ 0 Liquid error
- ✅ Section vidéo présente (nouveau thème live) — marqueurs `hv-grid` / « Voyez-le chez vous »

The video-section markers confirm theme `160213696617` ("Copie de Copie de Trade v2") is the active live theme.

## ÉTAPE 2 — Feeds

All four feeds respond **HTTP 200** with **1 064 produits** each (`application/xml`):

| Feed | HTTP | Items | Bytes |
|------|-----:|------:|------:|
| `/api/feeds/google` | 200 | 1064 | 3 475 844 |
| `/api/feeds/meta-xml` | 200 | 1064 | 3 593 143 |
| `/api/feeds/pinterest` | 200 | 1064 | 3 475 846 |
| `/api/feeds/pinterest-en` | 200 | 1064 | 3 471 206 |

Base: `https://aosom-sync.vercel.app`.

## ÉTAPE 3 — Page « Voyez-le chez vous »

`GET https://ameublodirect.ca/pages/voyez-le-chez-vous` → **200** (170 315 bytes).

- ✅ Contenu vidéo présent: **15 balises `<video>`**, 15 références `.mp4`, marqueurs `hv-grid` / « Voyez-le chez vous » présents.

## ÉTAPE 4 — Produits vidéo publiés (Turso `video_ingest_log`)

`SELECT COUNT(*) FROM video_ingest_log WHERE status='READY'` → **16**.

| status | n |
|--------|--:|
| READY | 16 |
| SKIPPED | 3 |

16 produits vidéo `READY` — dans la fourchette attendue (15-16). Cohérent avec les 15 balises `<video>` rendues sur la page « Voyez-le chez vous » (un produit READY peut ne pas être sur cette page précise).

## ÉTAPE 5 — Turso

DB répond normalement — `SELECT COUNT(*) FROM products` = **11 205**. Connexion + quota OK au moment du check.

---

_Read-only. Aucune écriture sur Shopify, les feeds, ou Turso. Seul ce rapport a été créé._
