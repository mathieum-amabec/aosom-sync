export interface QueueLinked {
  id: number;
  queue_id: number | null;
  queue_status: string | null;
  queue_scheduled_at: string | null;
}

/** Local view of a video right after a successful approve, before the list is re-fetched. */
export function markScheduled<T extends QueueLinked>(videos: T[], id: number, queueId: number, scheduledAt: string): T[] {
  return videos.map((v) =>
    v.id === id ? { ...v, queue_id: queueId, queue_status: "pending", queue_scheduled_at: scheduledAt } : v,
  );
}

/** Local view of a video right after it was taken off the schedule (its queue row is now cancelled). */
export function markUnscheduled<T extends QueueLinked>(videos: T[], id: number): T[] {
  return videos.map((v) => (v.id === id ? { ...v, queue_id: null, queue_status: null, queue_scheduled_at: null } : v));
}
