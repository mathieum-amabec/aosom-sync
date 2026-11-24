/**
 * Preview the "sujet chaud" pipeline WITHOUT touching the database or Facebook.
 *
 *   node-x64 --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/hot-topics-preview.mts [outDir]
 *
 * Collects today's candidates from the real feeds, asks the model for proposals, runs every
 * validation, prints the plan and writes the card PNGs to <outDir> (default: ./tmp-hot-topics).
 * The only write anywhere is the LLM token counter (daily_llm_budget), same as any generation.
 */
import fs from "node:fs";
import path from "node:path";
import * as sources from "@/lib/hot-topics/sources";
import * as generator from "@/lib/hot-topics/generator";
import * as card from "@/lib/hot-topics/card";

// tsx compiles to CJS here, so named exports land on `default` (see ops-mts note in CLAUDE memory).
const { collectCandidates } = (sources as typeof sources & { default?: typeof sources }).default ?? sources;
const { generateHotTopicPosts } = (generator as typeof generator & { default?: typeof generator }).default ?? generator;
const { renderCardPng } = (card as typeof card & { default?: typeof card }).default ?? card;

const outDir = path.resolve(process.argv[2] ?? "tmp-hot-topics");
fs.mkdirSync(outDir, { recursive: true });

const { candidates, feeds } = await collectCandidates();
console.log("feeds:", feeds, "| candidates:", candidates.length);

const out = await generateHotTopicPosts(candidates);
console.log(`blocked before LLM: ${out.blockedBeforeLlm} | valid proposals: ${out.posts.length} | rejected: ${out.rejected.length}`);
for (const r of out.rejected) console.log(`  ✗ ${r.title} — ${r.reason}`);

let i = 0;
for (const p of out.posts) {
  i++;
  const { png, layout } = await renderCardPng(p.lead, p.question);
  const file = path.join(outDir, `carte-${i}.png`);
  fs.writeFileSync(file, png);
  console.log(`\n#${i} [${p.category} · divisif ${p.divisive}/5] ${p.candidate.title}  (${p.candidate.source})`);
  console.log(`  carte: ${p.lead} / ${p.question}  (police ${layout.fontSize}px) → ${file}`);
  console.log(`  légende: ${p.caption}`);
  console.log(`  pourquoi: ${p.why}`);
}
