import Link from "next/link";
import { listBlogPosts, type BlogPostRow } from "@/lib/database";
import { BLOG } from "@/lib/config";

export const dynamic = "force-dynamic";

// Rendered entirely on the server: the article log is a read-only list with no interactive
// state, so there is nothing to hydrate. Follows the same force-dynamic + try/catch shape as
// the root dashboard page (the DB may not be reachable on a cold environment).

const STATUS_STYLES: Record<BlogPostRow["status"], { label: string; className: string }> = {
  published: { label: "Publié", className: "bg-green-500/10 text-green-400 border-green-500/30" },
  draft: { label: "Brouillon", className: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30" },
  failed: { label: "Échec", className: "bg-red-500/10 text-red-400 border-red-500/30" },
};

function StatusBadge({ status }: { status: BlogPostRow["status"] }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.draft;
  return (
    <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded-md border ${s.className}`}>
      {s.label}
    </span>
  );
}

export default async function BlogPage() {
  let posts: BlogPostRow[] = [];
  let dbError = false;
  try {
    posts = await listBlogPosts(100);
  } catch {
    dbError = true; // DB not ready yet
  }

  const publishedCount = posts.filter((p) => p.status === "published").length;
  const draftCount = posts.filter((p) => p.status === "draft").length;
  const failedCount = posts.filter((p) => p.status === "failed").length;

  return (
    <div className="p-6 max-w-6xl">
      <h2 className="text-2xl font-semibold text-white">Blog</h2>
      <p className="text-sm text-gray-500 mt-1 mb-6">
        Articles générés automatiquement (lundi + jeudi, 08:00 UTC). Les articles partent en
        brouillon dans Shopify et passent en ligne seulement s&apos;ils franchissent le seuil de
        qualité, la saison et le quota hebdomadaire.
      </p>

      {!dbError && posts.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
            <p className="text-xs text-gray-500">Publiés</p>
            <p className="text-xl font-semibold text-green-400">{publishedCount}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
            <p className="text-xs text-gray-500">Brouillons</p>
            <p className="text-xl font-semibold text-yellow-400">{draftCount}</p>
          </div>
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
            <p className="text-xs text-gray-500">Échecs</p>
            <p className="text-xl font-semibold text-red-400">{failedCount}</p>
          </div>
        </div>
      )}

      {dbError ? (
        <div className="p-8 bg-gray-900 border border-gray-800 rounded-xl text-center">
          <p className="text-gray-500 text-sm">Base de données injoignable</p>
          <p className="text-gray-600 text-xs mt-1">Réessayez dans un moment.</p>
        </div>
      ) : posts.length === 0 ? (
        <div className="p-8 bg-gray-900 border border-gray-800 rounded-xl text-center">
          <p className="text-gray-500 text-sm">Aucun article généré pour l&apos;instant</p>
          <p className="text-gray-600 text-xs mt-1">
            Le prochain passage du cron remplira cette liste.
          </p>
        </div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="border-b border-gray-800 text-gray-400">
                <th className="text-left px-4 py-3 font-medium">Titre</th>
                <th className="text-left px-4 py-3 font-medium">Langue</th>
                <th className="text-left px-4 py-3 font-medium">Statut</th>
                <th className="text-left px-4 py-3 font-medium">Article</th>
                <th className="text-right px-4 py-3 font-medium">Créé</th>
              </tr>
            </thead>
            <tbody>
              {posts.map((post) => (
                <tr key={post.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="px-4 py-3 text-gray-200">{post.title}</td>
                  <td className="px-4 py-3 text-gray-400 uppercase">{post.lang}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={post.status} />
                  </td>
                  <td className="px-4 py-3">
                    {post.shopify_article_id ? (
                      <Link
                        href={BLOG.ADMIN_ARTICLE_URL(post.shopify_article_id)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 hover:underline"
                      >
                        Ouvrir dans Shopify
                      </Link>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-400">
                    {new Date(post.created_at * 1000).toLocaleString("fr-CA")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
