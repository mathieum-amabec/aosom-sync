import { getContentTemplates, ContentTemplate } from "./database";

export async function selectRandomTemplate(): Promise<ContentTemplate | null> {
  const templates = await getContentTemplates({ active_only: true });
  if (templates.length === 0) return null;

  // Build weighted pool: each template appears frequency_per_month times
  const pool: ContentTemplate[] = [];
  for (const t of templates) {
    const weight = Math.max(1, t.frequency_per_month);
    for (let i = 0; i < weight; i++) pool.push(t);
  }

  return pool[Math.floor(Math.random() * pool.length)];
}
