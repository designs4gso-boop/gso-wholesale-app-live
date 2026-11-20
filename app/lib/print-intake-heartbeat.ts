// 2026-11-19 — is the Print Intake watcher on the RIP PC alive?
//
// The watcher calls the ERP once per pass; that call stamps a last-seen time.
// On 2026-11-19 the watcher stopped at 4:47 PM and nothing in the ERP showed
// it. This turns the last-seen time into a plain status. Pure, client-safe.

/** A pass over many large held files can take several minutes, so "late" starts well after one pass. */
export const WATCHER_STALE_AFTER_MINUTES = 15;

export type WatcherHealth = { state: "ok" | "stale" | "never"; minutesAgo: number | null; message: string };

export function watcherHealth(lastSeenAt: Date | string | null | undefined, now: Date = new Date()): WatcherHealth {
  const seen = lastSeenAt ? new Date(lastSeenAt).getTime() : NaN;
  if (!Number.isFinite(seen)) {
    return { state: "never", minutesAgo: null, message: "The print-file watcher has not checked in yet. It reports in once its updated version is running on the RIP PC." };
  }
  const minutesAgo = Math.max(0, Math.floor((now.getTime() - seen) / 60000));
  if (minutesAgo > WATCHER_STALE_AFTER_MINUTES) {
    const ago = minutesAgo >= 120 ? `${Math.floor(minutesAgo / 60)} hours` : `${minutesAgo} minutes`;
    return { state: "stale", minutesAgo, message: `The print-file watcher has not checked in for ${ago}. New files are NOT being picked up. On the RIP PC, start the task "GSO Print Intake Agent" (or sign in to Windows).` };
  }
  return { state: "ok", minutesAgo, message: minutesAgo < 1 ? "The print-file watcher is running (checked in just now)." : `The print-file watcher is running (checked in ${minutesAgo} min ago).` };
}
