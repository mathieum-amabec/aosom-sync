# Courriel gratuit — le guide de Mat

Tu as choisi de ne pas payer Klaviyo. Voici comment passer aux outils gratuits, étape par étape.
Tout est déjà programmé et **éteint**. Rien ne change tant que tu ne cliques pas sur le bouton (étape d).

## En bref : qui envoie quoi

| Courriel | Avant (aujourd'hui) | Après la bascule | Coût |
|---|---|---|---|
| Courriels automatiques : roue (3 courriels), bienvenue, paniers et paiements abandonnés, baisse de prix, retour en stock, rapport du matin, crédit de parrainage, merci de parrainage | Klaviyo | **Resend**, envoyé par notre application | 0 $ (3 000/mois, 100/jour) |
| Campagnes générales : Boxing Day, saisons, nouveautés | Klaviyo | **Shopify Email** | 0 $ (10 000/mois avec Shopify Basic) |

Pourquoi deux outils :
- Resend envoie un courriel personnalisé à **une** personne, par exemple avec son code de roue ou son code de parrainage.
- Shopify Email envoie le **même** courriel à beaucoup de monde. Il ne sait pas mettre un code unique par client.

Klaviyo continue de servir pour une chose : il **voit** ce qui se passe dans Shopify (paniers, commandes, inscriptions à l'infolettre) et nous le transmet. Il n'envoie plus rien. Au-delà de 250 profils, Klaviyo bloque les **envois**, pas cette lecture. Garde quand même le compte sous 250 avec le script de la fin de ce guide : c'est plus prudent.

**L'application respecte toujours ces règles :**
- **Jamais deux fois le même courriel.** Chaque courriel a une clé unique, vérifiée à trois endroits.
- **Plafond de Resend : 100 courriels par jour.** L'application s'arrête à 95. Les plus importants passent en premier :
  1. les codes de roue, le crédit de parrainage et les confirmations ;
  2. les paniers et les paiements abandonnés ;
  3. les avis ;
  4. le marketing (bienvenue, baisse de prix, merci de parrainage).

  Un courriel qui ne trouve pas de place attend dans une file et part dès qu'il y a de la place.
- **Désabonnement en 1 clic** dans chaque courriel, conforme à la loi anti-pourriel (LCAP) :
  - la personne est retirée chez nous, dans Klaviyo et dans Shopify ;
  - Shopify Email ne lui écrira donc plus non plus.
- **Chaque courriel affiche l'expéditeur et l'adresse postale**, comme la loi l'exige.

---

## (a) Créer le compte Resend (10 minutes)

1. Va sur **resend.com**, puis « Sign up ». Utilise l'adresse info@ameublodirect.ca. Le forfait gratuit suffit : aucune carte de crédit n'est demandée.
2. Menu **Domains**, puis **Add Domain**. Écris `ameublodirect.ca` et choisis la région **North Virginia (us-east-1)**.
3. Resend affiche 3 enregistrements DNS. Garde la page ouverte : tu en as besoin à l'étape (b).
4. Menu **API Keys**, puis **Create API Key** :
   - nom : `aosom-sync` ;
   - permission : **Sending access** ;
   - domaine : ameublodirect.ca.

   Copie la clé, qui commence par `re_`. Elle ne s'affiche qu'une fois.
5. Menu **Webhooks**, puis **Add Endpoint** :
   - adresse : `https://outils.ameublodirect.ca/api/email/webhook` ;
   - coche ces événements : `email.delivered`, `email.bounced`, `email.complained`, `email.opened`, `email.clicked`.

   Copie le **Signing secret**, qui commence par `whsec_`.

## (b) Les enregistrements DNS pour ameublodirect.ca (15 minutes, plus jusqu'à 24 h d'attente)

**Où est géré ton DNS.** J'ai vérifié en lecture seulement, le 2026-11-27 :
- le registraire est **Tucows** ;
- les serveurs de noms sont `ns-cloud-b1` à `b4.googledomains.com`.

C'est la configuration des domaines achetés **dans Shopify**. Va donc dans **Shopify admin → Paramètres → Domaines → ameublodirect.ca → Paramètres DNS** (« Gérer le DNS »).

Si le domaine n'apparaît pas là comme géré par Shopify, il est chez **Squarespace Domains** (l'ancien Google Domains) : fais les mêmes ajouts là-bas.

**Ajoute ces 3 enregistrements.** Copie les valeurs exactes affichées par Resend. La clé DKIM est propre à ton compte : ne la tape pas à la main.

| Type | Nom (hôte) | Valeur | Priorité |
|---|---|---|---|
| MX | `send` | `feedback-smtp.us-east-1.amazonses.com` | 10 |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` | — |
| TXT | `resend._domainkey` | `p=MIGfMA0GCSq…` (la longue valeur donnée par Resend) | — |

**Ne touche pas à ceux qui existent déjà :**
- le TXT `v=spf1 include:_spf.hostedemail.com include:zohocloud.ca ~all` à la racine ;
- les MX de Zoho (ta boîte de réception) ;
- le DMARC `_dmarc` (`v=DMARC1; p=none; …`). Il est déjà là et Gmail l'exige.

Resend utilise le sous-domaine `send.`, donc ta boîte Zoho n'est pas touchée.

Retourne ensuite dans Resend, puis **Domains → Verify**. Attends que les 3 lignes soient vertes : quelques minutes, parfois jusqu'à 24 h.

## (c) Les variables à mettre dans Vercel (10 minutes)

Va dans **Vercel → projet aosom-sync → Settings → Environment Variables**, environnement **Production** :

| Variable | Valeur |
|---|---|
| `RESEND_API_KEY` | la clé `re_…` de l'étape (a) |
| `EMAIL_FROM` | `Ameublo Direct <bonjour@ameublodirect.ca>` |
| `EMAIL_REPLY_TO` | `info@ameublodirect.ca` (les réponses des clients arrivent dans Zoho) |
| `EMAIL_TOKEN_SECRET` | 40 caractères au hasard, par exemple générés sur un site de mots de passe. Ne la change jamais sans garder l'ancienne dans `EMAIL_TOKEN_SECRET_PREVIOUS` pendant 60 jours, sinon les anciens liens de désabonnement cessent de fonctionner |
| `RESEND_WEBHOOK_SECRET` | le `whsec_…` de l'étape (a) |
| `NEXT_PUBLIC_APP_URL` | `https://outils.ameublodirect.ca` (vérifie qu'elle existe déjà) |

Ensuite :
1. Clique sur **Redeploy** sur le dernier déploiement de production.
2. Dans le tableau de bord de l'application, panneau **Courriels**, remplis **l'adresse postale du pied de page** : ta case postale, par exemple « C.P. 123, Saint-Hubert QC J3Y 0A1 ». La loi l'exige. Sans elle, l'application refuse d'envoyer.

Quand tout est bon, le panneau n'affiche plus « À faire avant le premier envoi ».

## (d) L'ordre de bascule (environ 1 h, réparti sur 2 jours)

1. **Simulation, sans aucun envoi** (5 minutes). Demande-moi de lancer `GET /api/cron/email-flows?dryRun=1`. La réponse indique :
   - combien de courriels partiraient maintenant, groupe par groupe ;
   - où ils partiraient (`route`) ;
   - ce qui manque encore (`problems`) ;
   - la file d'attente.
2. **Test sur ton adresse** (30 minutes) :
   1. Dans le panneau Courriels, mets ton adresse dans « Adresses de test ».
   2. Clique sur **Test Resend (mon adresse)**. Les clients continuent de recevoir les courriels de Klaviyo, comme avant. Toi, tu reçois en plus la version Resend.
   3. Essaie :
      - la roue sur le site, avec ton adresse et la case cochée ;
      - un panier puis une caisse abandonnée ;
      - le rapport du matin du lendemain.
   4. Vérifie dans chaque courriel :
      - l'expéditeur « Ameublo Direct » ;
      - l'adresse postale ;
      - le lien « Se désabonner », qui doit fonctionner (il retire ton adresse : remets-la avec moi après le test) ;
      - qu'il n'est pas arrivé dans les indésirables.
3. **Bascule** (1 clic). Clique sur **Resend (gratuit)** et confirme. À partir de là :
   - tous les courriels automatiques partent par Resend ;
   - les relais Klaviyo s'arrêtent d'eux-mêmes ;
   - la roue n'écrit plus rien dans Klaviyo.

   La ligne « Resend : x/95 en 24 h » du panneau montre la consommation.
4. **Parrainage** (quand tu le veux). Le courriel 1, « Un petit merci », avec un code unique par client, part par Resend, étalé sur plusieurs jours :

   ```
   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/referral-launch.mts --via resend --per-day 50
   ```

   Ça, c'est la simulation. Ajoute `--apply` seulement avec ton accord. Le courriel 2, « Votre ami a commandé », part tout seul par Resend.

## (e) Une campagne Boxing Day dans Shopify Email (30 minutes)

1. **Une seule fois : authentifier le domaine d'envoi.** Sans ça, les clients voient « via shopifyemail.com » à côté de ton nom, et Gmail est plus méfiant.
   1. Va dans **Shopify admin → Paramètres → Notifications → Courriel de l'expéditeur**. Mets `bonjour@ameublodirect.ca`.
   2. Shopify affiche « Authentifier ». Si le DNS est chez Shopify (voir (b)), un clic suffit.
   3. Sinon, Shopify te donne des enregistrements CNAME à ajouter au même endroit qu'en (b).
   4. Attends le crochet vert.
2. Va dans **Marketing → Créer une campagne → Shopify Email**. Choisis un modèle « Soldes ».
3. Choisis les **destinataires** : « Clients abonnés au marketing par courriel ». Shopify n'écrit qu'aux personnes qui ont accepté. Les désabonnements faits dans nos courriels Resend y sont recopiés automatiquement.
4. Objet, par exemple : « Boxing Day : jusqu'à X % sur … ».
   - Un rabais affiché doit être vrai : vérifie les prix barrés.
   - Pas de code unique ici. Si tu veux un code, prends un code commun, par exemple BOXING10, que tu crées dans Rabais : ≤ 10 % et non cumulable (règle « jamais à perte »).
5. **Envoie-toi un test**, puis programme l'envoi. 10 000 courriels par mois sont gratuits, et tu as environ 184 abonnés : c'est très large.

## (f) Revenir en arrière

- **Retour immédiat à Klaviyo :** un clic sur **Klaviyo (actuel)** dans le panneau. Les relais Klaviyo reprennent au tour suivant, dans les 15 minutes. Ils voient ce que Resend a déjà envoyé : personne ne reçoit le même courriel deux fois.
- **À savoir :**
  - Les courriels en file d'attente restent en attente, puis expirent.
  - Les tours de roue faits pendant la période Resend ont leur courriel 1 déjà envoyé. Leurs courriels 2 et 3 ne partiront pas par Klaviyo.
- **Si Resend tombe en panne ou si une variable disparaît :** l'application repasse **toute seule** à Klaviyo et le panneau l'affiche en jaune.

## Bonus : ne pas bloquer Klaviyo d'ici la bascule

Klaviyo gratuit bloque **tous** les envois au-delà de 250 profils actifs. Le 2026-11-27, il y en avait **252**.

Le script `scripts/klaviyo-headroom.mts` « met en sourdine » (en anglais *suppress*) les profils qui ne servent à rien. Ce sont les profils qui remplissent toutes ces conditions :
- ni acheteurs ni abonnés ;
- créés il y a plus de 14 jours ;
- sans relance en cours.

Un profil en sourdine ne compte plus dans la limite. C'est **réversible** et rien n'est effacé.

Simulation du 2026-11-27 :

| | Profils |
|---|---|
| Acheteurs | 160 |
| Abonnés | 60 |
| Créés il y a moins de 14 jours | 9 |
| Sans courriel | 2 |
| Déjà bloqués | 86 |
| **À mettre en sourdine** | **21** |

Résultat : **231 actifs**, donc une marge de 19 profils, environ 4 jours au rythme de 35 nouveaux par semaine.

Le script compte aussi les **41 abonnés Shopify** dont le profil Klaviyo a été bloqué lors du ménage (40 d'entre eux le 13 novembre). Il les compte seulement, sans les modifier.

Avec ton accord : ajoute `--apply`. Pour annuler : `--undo <fichier>`.

**La vraie solution reste la bascule vers Resend.** Après, la limite de Klaviyo ne bloque plus aucun envoi.
