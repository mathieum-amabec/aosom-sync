import BlogClient from "./blog-client";

export const dynamic = "force-dynamic";

// The article list is now interactive (approve / publish / delete + filters), so the page is
// a thin server shell around a client component — same shape as /videos and /sequential-ads.
export default function BlogPage() {
  return <BlogClient />;
}
