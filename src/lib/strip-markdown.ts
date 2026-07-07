/**
 * Strip Markdown formatting an LLM may emit so it is not published verbatim to
 * Facebook, which renders `**`, `#`, and `---` literally. The prompts ask for
 * plain text, but a single disobedient generation otherwise leaks markdown into
 * the draft and then into publication_queue.
 *
 * Conservative on purpose — only touches:
 *  - **bold** / __bold__        → inner text
 *  - *italic*                   → inner text (single-asterisk emphasis; run AFTER **bold**
 *                                 so it never eats bold markers, and same-line only so a
 *                                 leading `* ` bullet can't pair with the next line's `*`)
 *  - `# .. ###### ` ATX headers → heading text (leading hashes dropped)
 *  - `---` / `***` / `___` rules → removed (whole line)
 *  - trailing whitespace + 3+ blank lines collapsed, then trimmed
 *
 * Leaves emoji, punctuation, normal prose, and `#hashtags` (no space after `#`)
 * intact. Exported for unit testing.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")     // "# Heading" / "### Heading" → "Heading" (NOT "#hashtag")
    .replace(/^[ \t]*([-*_])\1{2,}[ \t]*(?:\r?\n|$)/gm, "") // horizontal-rule line (+ its newline): ---, ***, ___
    .replace(/\*\*([^*]+)\*\*/g, "$1")            // **bold** → bold
    .replace(/\*([^*\n]+)\*/g, "$1")              // *italic* → italic (after **bold**; same-line only)
    .replace(/__([^_]+)__/g, "$1")                // __bold__ → bold
    .replace(/[ \t]+$/gm, "")                      // trailing whitespace per line
    .replace(/\n{3,}/g, "\n\n")                    // collapse 3+ newlines
    .trim();
}

/**
 * Remove a leading platform-label line the model sometimes prepends as a title —
 * e.g. "Post Facebook 🌿", "Publication Instagram", "Facebook Post:". The prompts
 * ask Claude to return only the post, but a disobedient generation puts a label on
 * the first line; without this the caption publishes starting with that label
 * instead of the marketing hook.
 *
 * Conservative: only strips a FIRST line that clearly opens with such a label —
 * `Post`/`Publication` + platform, or `<Platform> post`. Two shapes:
 *  - **Label as a header** (a newline follows on the first line): the model put
 *    the label on its own line with the real caption below, so the WHOLE first
 *    line is scaffolding — drop it and the trailing newline(s).
 *  - **Label inline** (no newline — single-line generation): drop only the label
 *    token and its trailing decoration (`:`/`-`/emoji/spaces), and KEEP the real
 *    words that follow. This is why the tail stops at the first letter/number
 *    (`[^\p{L}\p{N}]*`): otherwise `"Publication Instagram: Découvrez…"` would
 *    lose "Découvrez…" (and, being consumed whole, get re-added by the caller's
 *    empty-fallback). A label-only generation ("Post Facebook 🌿") strips to ""
 *    — the correct signal for callers to reject/fall back, not publish the label.
 * Exported for unit testing.
 */
export function stripLeadingPlatformLabel(text: string): string {
  return text.replace(
    /^\s*(?:(?:post|publication)\s+(?:facebook|instagram|fb|ig)|(?:facebook|instagram|fb|ig)\s+post)\b(?:[^\n]*\r?\n+|[^\p{L}\p{N}]*)/iu,
    "",
  );
}

/**
 * Full cleanup for a social caption before it is stored/published. Order matters:
 * strip Markdown FIRST (so a markdown-titled label like `# Post Facebook 🌿` or
 * `**Post Facebook 🌿**` becomes a bare label line), THEN strip the leading
 * platform label.
 *
 * Returns "" only for a degenerate label-only generation (the model emitted
 * nothing but a label). That empty is the CORRECT signal — every caller handles
 * it safely: the reel path (`text || null`) keeps the original stored caption,
 * the content route returns 502, and a product draft is caught in human review.
 * Do NOT re-add a `|| md` fallback here: `md` still starts with the label, so it
 * would re-publish the exact prefix this function exists to remove — on the
 * unreviewed reel cron path.
 *
 * This is the single entry point every social-caption generator should use
 * (product posts, content templates, and publish-time Reel captions) so a new
 * path can't silently skip the cleanup.
 */
export function cleanSocialCaption(raw: string): string {
  return stripLeadingPlatformLabel(stripMarkdown(raw));
}
