/**
 * Strip Markdown formatting an LLM may emit so it is not published verbatim to
 * Facebook, which renders `**`, `#`, and `---` literally. The prompts ask for
 * plain text, but a single disobedient generation otherwise leaks markdown into
 * the draft and then into publication_queue.
 *
 * Conservative on purpose — only touches:
 *  - **bold** / __bold__        → inner text
 *  - `# .. ###### ` ATX headers → heading text (leading hashes dropped)
 *  - `---` / `***` / `___` rules → removed (whole line)
 *  - trailing whitespace + 3+ blank lines collapsed, then trimmed
 *
 * Leaves emoji, punctuation, normal prose, and `#hashtags` (no space after `#`)
 * intact. Exported for unit testing.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/^\s{0,3}#{1,6}[ \t]+/gm, "")        // "# Heading" / "### Heading" → "Heading" (NOT "#hashtag")
    .replace(/^[ \t]*([-*_])\1{2,}[ \t]*(?:\r?\n|$)/gm, "") // horizontal-rule line (+ its newline): ---, ***, ___
    .replace(/\*\*([^*]+)\*\*/g, "$1")            // **bold** → bold
    .replace(/__([^_]+)__/g, "$1")                // __bold__ → bold
    .replace(/[ \t]+$/gm, "")                      // trailing whitespace per line
    .replace(/\n{3,}/g, "\n\n")                    // collapse 3+ newlines
    .trim();
}
