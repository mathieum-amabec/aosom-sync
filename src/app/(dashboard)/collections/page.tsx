import { redirect } from "next/navigation";

// Collection mapping moved under Settings → Collections tab (2026-10 nav cleanup) — it's a
// one-time/occasional config task, not a daily workflow page, so it no longer needs its own
// sidebar entry. This redirect keeps old bookmarks and the /help page's route reference working.
export default function CollectionsRedirect() {
  redirect("/settings");
}
