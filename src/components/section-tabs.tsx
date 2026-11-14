"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface SectionTab {
  href: string;
  label: string;
}

/** The 5 video-producing pages, previously 5 separate sidebar entries. */
export const VIDEO_SECTION_TABS: SectionTab[] = [
  { href: "/videos", label: "Vidéos" },
  { href: "/demand-gen-videos", label: "Demand Gen" },
  { href: "/sequential-ads", label: "Pubs séquentielles" },
  { href: "/content-formats", label: "Nouveaux formats" },
  { href: "/ameublo", label: "Studio Ameublo" },
];

/** Generate (Social Media) and review (Drafts) — two steps of one workflow, two routes
 *  (Drafts stays outside the reviewer role's allowlist; see AUTH.REVIEWER_ALLOWED_PREFIXES
 *  in lib/config.ts — merging the URL would have silently exposed it). */
export const SOCIAL_SECTION_TABS: SectionTab[] = [
  { href: "/social", label: "Générer" },
  { href: "/drafts", label: "Réviser" },
];

/**
 * Cross-page tab bar for a group of related pages that each stayed their own route (own
 * auth rules, own revalidatePath targets, own bookmarks/help links) but are presented as one
 * section in the sidebar. Visually matches the existing in-page tab pattern (Settings,
 * /videos' own Queue/Library/Publish tabs) — border-b-2 on the active link.
 */
export function SectionTabs({ tabs }: { tabs: SectionTab[] }) {
  const pathname = usePathname();
  return (
    <div className="flex gap-1 mb-6 border-b border-gray-800 overflow-x-auto">
      {tabs.map((t) => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
              active
                ? "border-blue-500 text-white"
                : "border-transparent text-gray-400 hover:text-gray-200"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
