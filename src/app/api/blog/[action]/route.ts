/**
 * /api/blog/[action] — the /blog dashboard's queue + review actions.
 *
 *   GET    /api/blog/queue            list articles (?lang=fr|en, ?status=…, ?limit=)
 *   POST   /api/blog/approve  {id}    draft → approved
 *   POST   /api/blog/publish  {id}    approved → published (flips the Shopify article live)
 *   DELETE /api/blog/:id              remove the dashboard row (Shopify article untouched)
 *
 * One dynamic segment covers all four: `approve`/`publish`/`queue` are verbs, and DELETE
 * reads the same segment as a numeric row id. The sibling static `/api/blog/generate`
 * route still wins for that path (Next.js resolves static segments before dynamic ones).
 */

import { NextResponse } from "next/server";
import { isAuthenticated, getSessionRole } from "@/lib/auth";
import {
  listBlogPosts,
  countBlogPostsByStatus,
  getBlogPost,
  approveBlogPost,
  markBlogPostPublished,
  deleteBlogPost,
  countBlogPublishSlot,
  BLOG_POST_STATUSES,
  type BlogPostLang,
  type BlogPostStatus,
} from "@/lib/database";
import { publishBlogArticle, blogIdFor } from "@/lib/shopify-blog";
import { BLOG } from "@/lib/config";
import { isoWeekKey } from "@/lib/blog-topics";

const DEFAULT_LIMIT = 100;

/** Mutating actions are admin-only — the seeded `reviewer` role is read-only everywhere. */
async function denyWrite(): Promise<NextResponse | null> {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if ((await getSessionRole()) === "reviewer") {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }
  return null;
}

function parseLang(raw: string | null): BlogPostLang | undefined {
  return raw === "fr" || raw === "en" ? raw : undefined;
}

function parseStatus(raw: string | null): BlogPostStatus | undefined {
  return raw && (BLOG_POST_STATUSES as readonly string[]).includes(raw)
    ? (raw as BlogPostStatus)
    : undefined;
}

/** Read `{ id }` from a JSON body. Returns null for anything that isn't a positive integer. */
async function readId(request: Request): Promise<number | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  // A literal `null` body parses fine (json() only throws on malformed input), so guard
  // before the property read — otherwise it throws outside the handler's try and the
  // caller gets an unlogged 500 instead of the 400 this is meant to produce.
  if (body === null || typeof body !== "object") return null;
  const raw = (body as { id?: unknown }).id;
  const id = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * GET /api/blog/queue — newest-first article list plus whole-table status counts
 * (the counts drive the sidebar badge, so they ignore the lang/status filters).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ action: string }> },
) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { action } = await params;
  if (action !== "queue") {
    return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const limitRaw = Number.parseInt(searchParams.get("limit") ?? "", 10);
  const limit = Number.isInteger(limitRaw) ? limitRaw : DEFAULT_LIMIT;

  try {
    const [posts, counts] = await Promise.all([
      listBlogPosts(limit, {
        lang: parseLang(searchParams.get("lang")),
        status: parseStatus(searchParams.get("status")),
      }),
      countBlogPostsByStatus(),
    ]);
    // adminUrl is built here rather than in the client so the dashboard bundle never has to
    // import lib/config (which reads server-only env).
    return NextResponse.json({
      success: true,
      data: {
        posts: posts.map((p) => ({
          ...p,
          adminUrl: p.shopify_article_id ? BLOG.ADMIN_ARTICLE_URL(p.shopify_article_id) : null,
        })),
        counts,
      },
    });
  } catch (err) {
    console.error("[API] GET /api/blog/queue failed:", err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}

/** POST /api/blog/approve | /api/blog/publish — body `{ id }`. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ action: string }> },
) {
  const denied = await denyWrite();
  if (denied) return denied;

  const { action } = await params;
  if (action !== "approve" && action !== "publish") {
    return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  }

  const id = await readId(request);
  if (id === null) {
    return NextResponse.json(
      { success: false, error: "`id` must be a positive integer" },
      { status: 400 },
    );
  }

  try {
    const post = await getBlogPost(id);
    if (!post) {
      return NextResponse.json({ success: false, error: "Article introuvable" }, { status: 404 });
    }

    if (action === "approve") {
      if (post.status !== "draft") {
        return NextResponse.json(
          { success: false, error: `Seuls les brouillons peuvent être approuvés (statut: ${post.status})` },
          { status: 409 },
        );
      }
      if (!(await approveBlogPost(id))) {
        return NextResponse.json(
          { success: false, error: "L'article a changé de statut entre-temps" },
          { status: 409 },
        );
      }
      return NextResponse.json({ success: true, data: await getBlogPost(id) });
    }

    // action === "publish"
    if (post.status !== "approved") {
      return NextResponse.json(
        { success: false, error: `Seuls les articles approuvés peuvent être publiés (statut: ${post.status})` },
        { status: 409 },
      );
    }
    if (!post.shopify_article_id) {
      return NextResponse.json(
        { success: false, error: "Aucun article Shopify rattaché à cette ligne" },
        { status: 409 },
      );
    }

    // Shopify first, DB second: a failed publish leaves the row 'approved' so the operator
    // can retry, whereas flipping the row first would strand it as 'published' while the
    // article stays hidden. Shopify's publish is idempotent, so a retry is safe.
    await publishBlogArticle(blogIdFor(post.lang), post.shopify_article_id);

    if (!(await markBlogPostPublished(id))) {
      // The article IS live now, but the guarded UPDATE matched nothing — someone deleted
      // or re-published the row in between. Loud, because the storefront and the dashboard
      // have diverged and only the log says so.
      console.warn(
        `[API] /api/blog/publish: article ${post.shopify_article_id} published on Shopify but ` +
          `blog_posts row ${id} was no longer 'approved' — dashboard and storefront may disagree`,
      );
    }

    // Count it against the weekly cap so the cron's auto-publisher backs off accordingly.
    // Best-effort: the article is already live, so a counter write must not fail the request.
    try {
      await countBlogPublishSlot(isoWeekKey(new Date()));
    } catch (err) {
      console.error("[API] /api/blog/publish: weekly cap counter update failed:", err);
    }

    return NextResponse.json({ success: true, data: await getBlogPost(id) });
  } catch (err) {
    console.error(`[API] POST /api/blog/${action} failed:`, err);
    // Shopify payloads (tokens, ids) stay in the server log; the client gets a code.
    const shopify = err instanceof Error && /^Shopify/i.test(err.message);
    return NextResponse.json(
      {
        success: false,
        error: shopify ? "La publication Shopify a échoué" : "Internal server error",
        code: shopify ? "shopify_error" : "internal_error",
      },
      { status: shopify ? 502 : 500 },
    );
  }
}

/**
 * DELETE /api/blog/:id — drop the dashboard row only. The Shopify article is deliberately
 * left alone: deleting it there is irreversible, and an unpublished article is harmless.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ action: string }> },
) {
  const denied = await denyWrite();
  if (denied) return denied;

  const { action } = await params;
  const id = Number.parseInt(action, 10);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== action) {
    return NextResponse.json({ success: false, error: "Invalid article id" }, { status: 400 });
  }

  try {
    if (!(await deleteBlogPost(id))) {
      return NextResponse.json({ success: false, error: "Article introuvable" }, { status: 404 });
    }
    return NextResponse.json({ success: true, id });
  } catch (err) {
    console.error(`[API] DELETE /api/blog/${id} failed:`, err);
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
  }
}
