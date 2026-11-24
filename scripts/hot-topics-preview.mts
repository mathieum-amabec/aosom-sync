/**
 * Preview the "sujet chaud" pipeline WITHOUT touching the database or Facebook.
 *
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/hot-topics-preview.mts [outDir]
 *
 * Collects today's candidates from the real sources (RSS + NHL API), asks the model for proposals,
 * runs every validation, adds the calendar-bank posts active today, prints the plan and writes the
 * card PNGs to <outDir> (default: ./tmp-hot-topics). The only write anywhere is the LLM token
 * counter (daily_llm_budget), same as any generation.
 */
import fs from "node:fs";
import path from "node:path";
import * as sources from "@/lib/hot-topics/sources";
import * as generator from "@/lib/hot-topics/generator";
import * as calendar from "@/lib/hot-topics/calendar";
import * as card from "@/lib/hot-topics/card";

// tsx compiles to CJS here, so named exports land on `default` (see ops-mts note in CLAUDE memory).
const { collectCandidates } = (sources as typeof sources & { default?: typeof sources }).default ?? sources;
const { generateHotTopicPosts, checkPostText } = (generator as typeof generator & { default?: typeof generator }).default ?? generator;
const { calendarPosts } = (calendar as typeof calendar & { default?: typeof calendar }).default ?? calendar;
const { renderCardPng } = (card as typeof card & { default?: typeof card }).default ?? card;

const outDir = path.resolve(process.argv[2] ?? "tmp-hot-topics");
fs.mkdirSync(outDir, { recursive: true });
const now = new Date();

const { candidates, feeds } = await collectCandidates(undefined, now);
console.log("sources:", feeds, "| candidats frais:", candidates.length);
for (const c of candidates.slice(0, 12)) {
  const age = c.published ? `${Math.round((now.getTime() / 1000 - c.published) / 3600)} h` : "?";
  console.log(`  · [${c.source} · ${age}${c.trending ? " · tendance" : ""}] ${c.title}`);
}

const out = await generateHotTopicPosts(candidates, now);
console.log(`\nbloqués avant LLM (périmés / liste noire): ${out.blockedBeforeLlm} | propositions valides: ${out.posts.length} | rejetées: ${out.rejected.length}`);
for (const r of out.rejected) console.log(`  ✗ ${r.title} — ${r.reason}`);

const all = [
  ...out.posts,
  ...calendarPosts(now)
    .filter((c) => !checkPostText(c))
    .map((c) => ({
      kind: "calendar" as const, topicKey: `calendrier:${c.id}`, source: "calendrier", sourceTitle: c.sourceNote,
      subject: undefined as string | undefined, category: c.category, divisive: 3, factLine: c.factLine,
      question: c.question, caption: c.caption, why: c.sourceNote, flags: [] as string[], expiresAt: c.expiresAt,
      sourceUrl: undefined as string | undefined,
    })),
];

let i = 0;
for (const p of all) {
  i++;
  const { png, layout } = await renderCardPng(p.factLine, p.question);
  const file = path.join(outDir, `carte-${i}.png`);
  fs.writeFileSync(file, png);
  console.log(`\n#${i} [${p.kind} · ${p.category} · divisif ${p.divisive}/5${p.flags.length ? ` · ⚠ ${p.flags.join(", ")}` : ""}] ${p.sourceTitle}  (${p.source})`);
  if (p.subject) console.log(`  sujet nommé: ${p.subject}`);
  if (p.sourceUrl) console.log(`  source: ${p.sourceUrl}`);
  console.log(`  carte: ${p.factLine} / ${p.question}  (question ${layout.fontSize}px, fait ${layout.factFontSize}px) → ${file}`);
  console.log(`  légende: ${p.caption}`);
  console.log(`  expire: ${new Date(p.expiresAt * 1000).toLocaleString("fr-CA", { timeZone: "America/Toronto" })}`);
}
