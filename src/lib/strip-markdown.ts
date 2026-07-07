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
 * Conservative: only strips a FIRST line that clearly IS such a label —
 * `Post`/`Publication` + platform, or `<Platform> post` — plus any trailing
 * emoji/`:`/`-`/title text on that line. Never touches real prose (a marketing
 * caption never opens with "Post Facebook"). Exported for unit testing.
 */
export function stripLeadingPlatformLabel(text: string): string {
  return text.replace(
    /^\s*(?:(?:post|publication)\s+(?:facebook|instagram|fb|ig)|(?:facebook|instagram)\s+post)\b[^\n]*(?:\r?\n+|$)/i,
    "",
  );
}
