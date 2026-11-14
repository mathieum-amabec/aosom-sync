import { describe, it, expect, vi } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const { revalidateTag, revalidatePath } = vi.hoisted(() => ({ revalidateTag: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("next/cache", () => ({ revalidateTag, revalidatePath }));

import { FEEDS, revalidateFeeds } from "@/lib/feeds/revalidate";

describe("revalidateFeeds", () => {
  it("busts the 'feeds' tag and every feed route path", () => {
    expect(revalidateFeeds()).toEqual(FEEDS);
    expect(revalidateTag).toHaveBeenCalledWith("feeds", "max");
    expect(revalidatePath).toHaveBeenCalledTimes(FEEDS.length);
    for (const f of FEEDS) expect(revalidatePath).toHaveBeenCalledWith(`/api/feeds/${f}`);
  });

  it("FEEDS lists exactly the feed routes under src/app/api/feeds", () => {
    const dir = join(process.cwd(), "src/app/api/feeds");
    const routes = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "route.ts")))
      .map((e) => e.name)
      .sort();
    expect([...FEEDS].sort()).toEqual(routes);
  });
});
