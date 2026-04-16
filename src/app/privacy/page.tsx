// Public — referenced in Meta App Review as the privacy policy URL.
// Proxy allowlists /privacy so this renders without authentication.

export const metadata = {
  title: "Privacy Policy — Aosom Sync",
  description: "Privacy policy for Aosom Sync, the internal catalogue and social publishing tool used by Ameublodirect.",
};

const CONTACT_EMAIL = "mathieu87marleau@gmail.com";
const LAST_UPDATED = "2026-04-15";

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="max-w-3xl mx-auto px-6 py-12 md:py-16">
        <header className="mb-12 pb-8 border-b border-gray-200">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
            Privacy Policy — Aosom Sync
          </h1>
          <p className="mt-3 text-sm text-gray-500">
            Last updated: {LAST_UPDATED}
          </p>
        </header>

        {/* ─────────────────── English ─────────────────── */}
        <section className="mb-16">
          <h2 className="text-2xl font-semibold mb-4">English</h2>

          <h3 className="text-lg font-semibold mt-6 mb-2">About this application</h3>
          <p className="leading-relaxed">
            <strong>Aosom Sync</strong> is a private, internal tool used by the
            Ameublodirect team to manage its product catalogue on Shopify and
            publish marketing posts to the Facebook Pages it owns and operates.
            The application is not distributed to end users and does not collect
            any data from third parties.
          </p>

          <h3 className="text-lg font-semibold mt-6 mb-2">What we collect</h3>
          <p className="leading-relaxed">
            The application connects to Facebook Pages that our own team
            administers. From those pages, the application stores only:
          </p>
          <ul className="list-disc pl-6 mt-2 space-y-1">
            <li>The public name and ID of the Facebook Pages we own</li>
            <li>The content of posts the application itself creates (text, product images, scheduled time)</li>
            <li>Basic engagement metrics (reach, reactions, comment counts) for posts we have published, to display them in the internal dashboard</li>
          </ul>
          <p className="leading-relaxed mt-2">
            The application does <strong>not</strong> collect personal data from
            any Facebook user, does <strong>not</strong> read private messages,
            and does <strong>not</strong> access friends lists, profiles, or any
            data outside the Pages owned by our team.
          </p>

          <h3 className="text-lg font-semibold mt-6 mb-2">Why we collect it</h3>
          <p className="leading-relaxed">
            Data is used solely to operate the publishing workflow: generate a
            post draft from our product catalogue, let a team member review and
            approve it, and publish it to one of our own Facebook Pages. Metrics
            are displayed so the team can see how the posts the application
            created are performing.
          </p>

          <h3 className="text-lg font-semibold mt-6 mb-2">Sharing and third parties</h3>
          <p className="leading-relaxed">
            We do not sell, share, or transfer any data to third parties. Data
            remains inside our Shopify store, our Turso database, and Meta&apos;s
            own Graph API endpoints that we call on behalf of the Pages we own.
          </p>

          <h3 className="text-lg font-semibold mt-6 mb-2">Cookies and tracking</h3>
          <p className="leading-relaxed">
            This privacy page does not use cookies or analytics. The
            authenticated portion of the application uses a single
            HTTP-only session cookie strictly to keep internal team members
            logged in; no tracking cookies are set.
          </p>

          <h3 className="text-lg font-semibold mt-6 mb-2">Data retention and deletion</h3>
          <p className="leading-relaxed">
            Because the application only stores data related to Pages our own
            team owns, any Page administrator can request full deletion of the
            data associated with that Page at any time by contacting us at the
            address below. We will delete the requested data within 30 days.
          </p>

          <h3 className="text-lg font-semibold mt-6 mb-2">Contact</h3>
          <p className="leading-relaxed">
            Questions, deletion requests, or concerns about this policy can be
            sent to{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="text-blue-700 underline">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </section>

        {/* ─────────────────── Français ─────────────────── */}
        <section>
          <h2 className="text-2xl font-semibold mb-4">Français</h2>

          <h3 className="text-lg font-semibold mt-6 mb-2">À propos de cette application</h3>
          <p className="leading-relaxed">
            <strong>Aosom Sync</strong> est un outil privé et interne utilisé
            par l&apos;équipe d&apos;Ameublodirect pour gérer son catalogue de
            produits sur Shopify et publier des publications marketing sur les
            pages Facebook qu&apos;elle possède et administre. L&apos;application
            n&apos;est pas distribuée à des utilisateurs finaux et ne collecte
            aucune donnée auprès de tiers.
          </p>

          <h3 className="text-lg font-semibold mt-6 mb-2">Données collectées</h3>
          <p className="leading-relaxed">
            L&apos;application se connecte uniquement aux pages Facebook que
            notre équipe administre. À partir de ces pages, l&apos;application
            conserve seulement :
          </p>
          <ul className="list-disc pl-6 mt-2 space-y-1">
            <li>Le nom public et l&apos;identifiant des pages Facebook qui nous appartiennent</li>
            <li>Le contenu des publications que l&apos;application elle-même crée (texte, images produit, heure de planification)</li>
            <li>Les métriques d&apos;engagement de base (portée, réactions, nombre de commentaires) sur les publications que nous avons publiées, pour les afficher dans le tableau de bord interne</li>
          </ul>
          <p className="leading-relaxed mt-2">
            L&apos;application <strong>ne collecte pas</strong> de données
            personnelles auprès d&apos;utilisateurs Facebook, <strong>ne lit
            pas</strong> les messages privés, et <strong>n&apos;accède pas</strong>{" "}
            aux listes d&apos;amis, profils ou données en dehors des pages que
            notre équipe possède.
          </p>

          <h3 className="text-lg font-semibold mt-6 mb-2">Finalité de la collecte</h3>
          <p className="leading-relaxed">
            Les données servent uniquement à faire fonctionner le flux de
            publication : générer une ébauche de post à partir de notre
            catalogue de produits, permettre à un membre de l&apos;équipe de la
            réviser et de l&apos;approuver, puis la publier sur l&apos;une de
            nos pages Facebook. Les métriques sont affichées pour que
            l&apos;équipe puisse voir la performance des publications créées
            par l&apos;application.
          </p>

          <h3 className="text-lg font-semibold mt-6 mb-2">Partage et tiers</h3>
          <p className="leading-relaxed">
            Nous ne vendons, ne partageons et ne transférons aucune donnée à
            des tiers. Les données demeurent dans notre boutique Shopify, notre
            base de données Turso et les points de terminaison de la Graph API
            de Meta que nous appelons au nom des pages que nous possédons.
          </p>

          <h3 className="text-lg font-semibold mt-6 mb-2">Témoins et suivi</h3>
          <p className="leading-relaxed">
            Cette page de politique de confidentialité n&apos;utilise aucun
            témoin (cookie) ni outil d&apos;analyse. La portion authentifiée de
            l&apos;application utilise un unique témoin de session HTTP-only,
            strictement pour maintenir la connexion des membres de
            l&apos;équipe ; aucun témoin de suivi n&apos;est déposé.
          </p>

          <h3 className="text-lg font-semibold mt-6 mb-2">Conservation et suppression</h3>
          <p className="leading-relaxed">
            Comme l&apos;application ne conserve que des données relatives aux
            pages que notre équipe possède, tout administrateur de page peut
            demander la suppression complète des données associées à cette
            page en tout temps, en nous écrivant à l&apos;adresse ci-dessous.
            Nous procéderons à la suppression dans les 30 jours.
          </p>

          <h3 className="text-lg font-semibold mt-6 mb-2">Contact</h3>
          <p className="leading-relaxed">
            Toute question, demande de suppression ou préoccupation concernant
            cette politique peut être envoyée à{" "}
            <a href={`mailto:${CONTACT_EMAIL}`} className="text-blue-700 underline">
              {CONTACT_EMAIL}
            </a>
            .
          </p>
        </section>

        <footer className="mt-16 pt-8 border-t border-gray-200 text-sm text-gray-500">
          © {new Date().getFullYear()} Aosom Sync — Ameublodirect
        </footer>
      </div>
    </div>
  );
}
