/**
 * A post that went out on ONE channel but not the other (typically: Facebook ok, Instagram refused) is still marked published,
 * so the item never shows up as failed and the reason used to live only in a console line nobody reads. That made an Instagram
 * problem invisible for weeks. This keeps the reason on the queue row (`publication_queue.error`) and raises a notification.
 */
import { createNotification, ensureSchema } from "./database";

/** Best-effort by design: the post is already live; recording why part of it failed must never fail the publish. */
export async function recordPartialFailure(itemId: number, platform: string, message: string): Promise<void> {
  const db = await ensureSchema();
  await db.execute({ sql: `UPDATE publication_queue SET error = ? WHERE id = ? AND status = 'published'`, args: [message.slice(0, 1000), itemId] });
  await createNotification("warning", "Publication partielle", `File ${itemId} (${platform}) : ${message.slice(0, 400)}`);
}
