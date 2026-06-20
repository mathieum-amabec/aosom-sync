import type { Metadata } from "next";
import { DM_Sans } from "next/font/google";

export const metadata: Metadata = {
  title: "Guide d'utilisation — Aosom Sync",
};

const dmSans = DM_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"] });

// Brand accents (Shopify theme palette) layered over the dashboard's dark panels.
const NAVY = "#1B2A4A";
const GOLD = "#D4A853";

interface HelpSection {
  title: string;
  route: string;
  role: string;
  steps: [string, string, string];
  tips: string[];
}

// Ordered by daily importance (1 = most used), per the dashboard feature inventory.
const SECTIONS: HelpSection[] = [
  {
    title: "Dashboard",
    route: "/",
    role: "Vue d'ensemble du catalogue et point de départ de la synchronisation quotidienne Aosom → Shopify.",
    steps: [
      "Vérifier le bandeau « dernière sync », le résumé du jour et les alertes de prix.",
      "Lancer un « Dry Run Sync » pour prévisualiser les changements sans rien appliquer.",
      "Lancer « Run Full Sync » pour appliquer (CSV → diff → mise à jour Shopify).",
    ],
    tips: [
      "Le Dry Run n'écrit rien : utilisez-le pour vérifier avant d'appliquer.",
      "Les vignettes Price Drops / Top Sellers sont cliquables vers le produit Shopify.",
      "La « File de publication » montre les posts sociaux à venir.",
    ],
  },
  {
    title: "Drafts",
    route: "/drafts",
    role: "File de revue éditoriale pour approuver, planifier ou publier les brouillons de contenu (FR/EN) avant qu'ils partent sur les pages Facebook.",
    steps: [
      "Filtrer sur « En attente » + « Contenu » et cliquer un brouillon pour lire FR/EN.",
      "Approuver (mise en file automatique) ou planifier une heure précise.",
      "Au besoin, publier immédiatement sur Ameublo (FR), Furnish (EN) ou les deux.",
    ],
    tips: [
      "Le rejet exige une note de raison (obligatoire).",
      "La publication immédiate est irréversible.",
      "Les brouillons « Contenu » approuvés partent via le cron horaire de publication.",
    ],
  },
  {
    title: "Social Media",
    route: "/social",
    role: "Composer et publier des posts produit sur plusieurs canaux Facebook/Instagram, avec suivi d'état par canal.",
    steps: [
      "« Generate Highlight » (ou les brouillons arrivent via sync/import) ; éditer le texte et les photos.",
      "Approuver (mise en file) ou Publier en choisissant les canaux FB/IG.",
      "Suivre les badges ✓/✗ par canal et relancer (Retry) les canaux en échec.",
    ],
    tips: [
      "La vue Calendar montre les posts planifiés et publiés.",
      "Le bouton Publish est désactivé pour les anciennes lignes « scheduled » (déschéduler d'abord).",
      "Basculer l'aperçu FR/EN avant de publier.",
    ],
  },
  {
    title: "Import",
    route: "/import",
    role: "File du pipeline d'import qui génère le contenu produit (via Claude), permet la revue, puis pousse vers Shopify en brouillon.",
    steps: [
      "Mettre des produits en file (par SKU) depuis le Catalogue.",
      "Générer le contenu Claude pour chaque job, puis réviser.",
      "Pousser vers Shopify — le produit est créé en brouillon pour revue manuelle.",
    ],
    tips: [
      "Tous les nouveaux produits arrivent en brouillon Shopify.",
      "L'import en lot affiche la progression (succès / erreurs / ignorés).",
      "Le contenu est bilingue : FR pour le titre/corps, EN stocké en metafields.",
    ],
  },
  {
    title: "Catalogue",
    route: "/catalog",
    role: "Navigateur du catalogue synchronisé (lu depuis la base, pas le CSV en direct) avec filtres, badges de mouvement de prix et statut « en boutique ».",
    steps: [
      "Filtrer / chercher par type, couleur ou statut.",
      "Repérer les badges ▼/▲ (prix) et « In store / Not imported ».",
      "Cliquer « In store » pour ouvrir le produit dans Shopify.",
    ],
    tips: [
      "Les données viennent du dernier snapshot de sync, pas du CSV temps réel.",
      "Le badge boutique est piloté par le shopify_product_id du produit.",
      "Filtrez sur les non-importés pour préparer une vague d'import.",
    ],
  },
  {
    title: "Collections",
    route: "/collections",
    role: "Associer les catégories Aosom (types de produits) aux collections Shopify.",
    steps: [
      "Afficher les catégories non mappées (filtre « unmapped »).",
      "Choisir la collection Shopify correspondante pour chacune.",
      "Sauvegarder, puis lancer la synchronisation des collections.",
    ],
    tips: [
      "Filtrez sur « unmapped » pour trouver les trous de couverture.",
      "Une catégorie sans collection ne s'affiche pas correctement en boutique.",
      "La recherche aide à naviguer les longues listes de catégories.",
    ],
  },
  {
    title: "Vidéos",
    route: "/videos",
    role: "Générer et gérer des vidéos produit via plusieurs moteurs (FFmpeg gratuit, Kling, Creatomate).",
    steps: [
      "Onglet « Générer » : choisir les produits, le moteur, le type et la langue.",
      "Suivre la « File d'attente » jusqu'au statut « ready ».",
      "Approuver dans la « Bibliothèque », puis « Publier ».",
    ],
    tips: [
      "FFmpeg est gratuit ; Kling et Creatomate ont un coût par vidéo.",
      "Le type peut être product, lifestyle ou promo.",
      "Disponible en français et en anglais.",
    ],
  },
  {
    title: "Demand Gen",
    route: "/demand-gen-videos",
    role: "Bibliothèque des assets vidéo « demand gen » avec suivi du statut d'upload Meta / YouTube.",
    steps: [
      "Filtrer les assets par ratio d'image.",
      "Vérifier le statut d'upload sur Meta et YouTube.",
      "Uploader les assets manquants vers la plateforme voulue.",
    ],
    tips: [
      "Le ratio doit correspondre au placement publicitaire visé.",
      "Les badges « Uploadé » évitent les doublons d'envoi.",
      "La taille de fichier est affichée par asset.",
    ],
  },
  {
    title: "Settings",
    route: "/settings",
    role: "Configurer les clés API (Facebook/Graph), les paramètres du workflow social, les prompts de contenu et le calendrier de publication.",
    steps: [
      "Renseigner les clés API et les identifiants de page.",
      "Régler le workflow social (fréquence, heure, seuils).",
      "Ajuster les prompts de contenu et le calendrier de publication.",
    ],
    tips: [
      "Les champs marqués « env » sont sensibles (tokens) — manipuler avec soin.",
      "L'onglet Calendrier de publication pilote les créneaux de la file.",
      "Les prompts déterminent le ton du contenu généré par Claude.",
    ],
  },
  {
    title: "Sync History",
    route: "/sync",
    role: "Historique des exécutions de synchronisation, avec le détail des changements par champ (prix, images, statut).",
    steps: [
      "Parcourir la liste des runs passés.",
      "Cliquer un run pour charger ses logs détaillés.",
      "Inspecter chaque changement (prix / image / statut) pour audit.",
    ],
    tips: [
      "Idéal pour diagnostiquer un changement inattendu.",
      "Chaque run indique produits scannés / mis à jour / archivés / erreurs.",
      "Page en lecture seule — aucun effet de bord.",
    ],
  },
];

export default function HelpPage() {
  return (
    <div className={`${dmSans.className} p-4 md:p-8 max-w-4xl`}>
      {/* Header band — navy with a gold accent rule */}
      <header
        className="mb-8 rounded-xl border border-gray-800 p-5 md:p-6 border-l-4"
        style={{ backgroundColor: NAVY, borderLeftColor: GOLD }}
      >
        <p
          className="text-xs font-semibold uppercase tracking-[0.18em] mb-1"
          style={{ color: GOLD }}
        >
          Guide d’utilisation
        </p>
        <h1 className="text-2xl md:text-3xl font-bold text-white">
          Guide d’utilisation — Aosom Sync
        </h1>
        <p className="text-gray-300 text-sm mt-2">
          Comment utiliser chaque page du tableau de bord, dans l’ordre où vous
          vous en servez au quotidien. Cliquez une section pour la déplier.
        </p>
      </header>

      <div className="space-y-3">
        {SECTIONS.map((section, i) => (
          <details
            key={section.route}
            open={i === 0}
            className="group rounded-xl border border-gray-800 bg-gray-900 overflow-hidden transition-colors open:border-gray-700"
          >
            <summary className="flex items-center gap-3 cursor-pointer select-none px-4 py-3.5 list-none [&::-webkit-details-marker]:hidden hover:bg-gray-800/50">
              <span
                className="shrink-0 inline-flex h-7 w-7 items-center justify-center rounded-lg text-sm font-bold"
                style={{ backgroundColor: GOLD, color: NAVY }}
                aria-hidden="true"
              >
                {i + 1}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-base font-semibold text-white truncate group-open:text-[#D4A853]">
                  {section.title}
                </span>
                <span className="block text-xs text-gray-500 font-mono truncate">
                  {section.route}
                </span>
              </span>
              <svg
                className="shrink-0 w-5 h-5 text-gray-500 transition-transform duration-200 group-open:rotate-180"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={1.8}
                stroke="currentColor"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </summary>

            <div className="px-4 pb-5 pt-1 border-t border-gray-800 space-y-4">
              <p className="text-sm text-gray-300 leading-relaxed pt-3">
                {section.role}
              </p>

              <div>
                <h3
                  className="text-xs font-semibold uppercase tracking-wider mb-2"
                  style={{ color: GOLD }}
                >
                  Flux typique
                </h3>
                <ol className="space-y-2">
                  {section.steps.map((step, s) => (
                    <li key={s} className="flex gap-3 text-sm text-gray-300">
                      <span
                        className="shrink-0 inline-flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-semibold mt-0.5"
                        style={{ borderColor: GOLD, color: GOLD }}
                      >
                        {s + 1}
                      </span>
                      <span className="leading-relaxed">{step}</span>
                    </li>
                  ))}
                </ol>
              </div>

              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
                  Astuces
                </h3>
                <ul className="space-y-1.5">
                  {section.tips.map((tip, t) => (
                    <li key={t} className="flex gap-2 text-sm text-gray-400">
                      <span style={{ color: GOLD }} aria-hidden="true">
                        •
                      </span>
                      <span className="leading-relaxed">{tip}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </details>
        ))}
      </div>

      <p className="text-xs text-gray-600 mt-8">
        Sections classées par fréquence d’utilisation quotidienne.
      </p>
    </div>
  );
}
