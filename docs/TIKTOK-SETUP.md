# TikTok — envoyer les vidéos du Studio en brouillon

**Statut (2026-10-06)** : le client, l'autorisation OAuth (avec renouvellement automatique) et l'envoi de brouillons sont
fusionnés et **dormants** : rien dans `src/app` ne les importe, la file de publication n'est pas touchée. Il reste à créer
les comptes de marque et l'application TikTok (étapes 1 à 3, à faire par Mat).

## Ce que fait — et ne fait pas — la voie « brouillon »

Permission `video.upload` : la vidéo arrive dans la **boîte de réception TikTok** du compte, en brouillon. Le propriétaire du
compte ouvre TikTok, choisit un son, **colle la légende** et appuie sur « Publier ». Avantages : pas d'audit TikTok, et le choix
d'un son tendance (qui aide la portée). Limites :

- **Un brouillon ne porte ni légende ni titre** (l'API ne les accepte pas). `scripts/tiktok-draft.mts` imprime la légende du Studio,
  liens retirés (non cliquables sur TikTok), à coller.
- **Un geste manuel par vidéo.**
- La publication **directe et publique** (`video.publish`) exige l'**audit TikTok** (≈ 3 semaines, interface de publication
  conforme, site, conditions, politique de confidentialité, vidéos de démonstration) ; tant qu'il n'est pas passé, tout ce qui est
  publié directement est **privé**. Hors de ce guide.

## 1. Créer les deux comptes de marque (dans l'appli TikTok)

Il faut **un compte par marque** : `Ameublo Direct` (FR) et `Furnish Direct` (EN). Ne mélange pas les deux langues sur un compte.

1. Ouvre TikTok → **Profil** → touche ton **nom d'utilisateur** en haut → **Ajouter un compte** → **S'inscrire**.
2. Inscris-toi avec un **courriel (ou numéro) qui n'est lié à aucun autre compte TikTok** (un courriel ou un numéro = un seul
   compte). Idéalement une adresse dédiée par marque, que tu contrôles (par exemple une adresse en `@ameublodirect.ca`).
3. Nom d'utilisateur : `@ameublodirect` et `@furnishdirect` (ou le plus proche disponible).
4. **Profil → ☰ → Paramètres et confidentialité → Compte → Passer à un compte professionnel**, choisis une catégorie
   (commerce / maison). Un compte professionnel donne le lien du site dans la biographie.
5. Photo de profil = le logo (dossier `Logo/Ameublo/`), biographie courte, lien `ameublodirect.ca` / `furnishdirect.ca`.
6. Répète pour la deuxième marque. TikTok permet plusieurs comptes sur le même appareil (touche ton nom d'utilisateur pour
   passer de l'un à l'autre).

## 2. Créer l'application TikTok (<https://developers.tiktok.com/>)

1. Connecte-toi avec n'importe quel compte TikTok (ton compte personnel convient : c'est le compte **développeur**, distinct des
   comptes de marque), accepte les conditions, vérifie ton courriel.
2. **Manage apps → Connect an app**. Remplis :

   | Champ | Valeur proposée |
   |---|---|
   | Nom de l'app | `Ameublo Direct Publisher` |
   | Icône | le logo, 1024 × 1024 |
   | Catégorie | commerce / shopping (la plus proche) |
   | Description | Envoie les vidéos de promotion d'Ameublo Direct / Furnish Direct vers les brouillons TikTok de la marque. |
   | Site web | `https://ameublodirect.ca` |
   | Conditions d'utilisation | `https://ameublodirect.ca/policies/terms-of-service` |
   | Politique de confidentialité | `https://ameublodirect.ca/policies/privacy-policy` |
   | Plateforme | **Web** |

3. **Add products** : ajoute **Login Kit** et **Content Posting API**. Permissions (scopes) : `user.info.basic` et **`video.upload`**
   (pas `video.publish`).
4. Dans **Login Kit → Redirect URI**, enregistre **`https://ameublodirect.ca/`**. TikTok exige une adresse **`https` absolue,
   sans paramètres** : `localhost` ne marche pas. La page elle-même importe peu (le script lit l'adresse dans la barre du navigateur).
   Si TikTok refuse ce domaine, note le message : on essaiera une autre adresse.
5. **Sandbox** : crée un sandbox, puis **Target users → Add account** pour **chacun des deux comptes de marque** (jusqu'à 10 comptes).
   En sandbox on peut tester tout le flux (autorisation + envoi de brouillons) **sans soumettre l'app à la révision de TikTok**.
   Pour sortir du sandbox, il faudra **« Submit for review »** (vidéo de démonstration de l'autorisation et de l'envoi).
   À confirmer à l'usage : si le sandbox reste utilisable sans limite de durée pour nos deux comptes.
6. Note la **Client key** et le **Client secret** de l'app.

## 3. Variables d'environnement (`.env.local`, jamais dans le chat ni dans git)

```bash
TIKTOK_CLIENT_KEY=        # Client key de l'app
TIKTOK_CLIENT_SECRET=     # Client secret — secret
TIKTOK_REDIRECT_URI=https://ameublodirect.ca/
```

## 4. Autoriser chaque compte (une seule fois par marque)

Toutes les commandes : `node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/tiktok-oauth.mts <commande> --brand fr|en`

```
url                      affiche le lien : ouvre-le dans un navigateur connecté au compte de la MARQUE (pas ton compte personnel) et autorise
exchange "<adresse>"     colle l'adresse complète vers laquelle TikTok t'a redirigé (…/?code=…) ; les jetons sont enregistrés
whoami                   montre quel compte TikTok est autorisé
refresh                  force le renouvellement (normalement automatique)
```

Le jeton d'accès dure **24 h**, le jeton de renouvellement **365 jours** : `src/lib/tiktok-auth.ts` renouvelle tout seul
(avec 2 h de marge), un renouvellement par appel au plus (les appels simultanés partagent le même). **Avec `.env.local`, les jetons
sont écrits dans les réglages de la PRODUCTION** (clés `tiktok_oauth_fr` / `tiktok_oauth_en`).

## 5. Envoyer une vidéo en brouillon

```
… scripts/tiktok-draft.mts <idVidéoStudio>            # essai à blanc : montre les 4 appels et la légende, n'envoie rien
… scripts/tiktok-draft.mts <idVidéoStudio> --apply    # envoie vraiment
```

Le compte suit la langue de la vidéo (FR → Ameublo Direct, EN → Furnish Direct). Ensuite : ouvre TikTok sur ce compte → boîte de
réception → le brouillon → ajoute un son, colle la légende imprimée, publie.

## 6. Pas fait exprès

- **Pas branché à la file de publication** : ajouter `'tiktok'` à `publication_queue.platform` demande de reconstruire la table
  (contrainte CHECK de SQLite, voir `PINTEREST-SETUP.md` § 7). Une fois fait, le publisher pourra envoyer un brouillon par vidéo approuvée.
- **L'envoi par lien** (`PULL_FROM_URL`) n'est pas utilisé : il exige un domaine vérifié par TikTok, ce que notre hébergement de
  fichiers (Vercel Blob) n'est pas. On téléverse donc le fichier nous-mêmes (`FILE_UPLOAD`).
- **Publication directe publique** : exige l'audit TikTok. Alternative payante : un service qui détient une app déjà auditée (à
  vérifier auprès du fournisseur : certains, comme Post for Me, demandent *ton* audit pour le public).
