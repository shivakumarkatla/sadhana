/**
 * In-memory bookkeeping for fire-and-forget Sādhana saves, so "Reload now" can wait for them and refuse to reload if one failed.
 * It writes nothing itself: the save is whatever function the caller passes in. Nothing is persisted. Erasable TypeScript only.
 *
 * Rules: a newer save for the same key supersedes an older one (an older save finishing late can neither record nor clear a failure);
 * a failed save keeps its retry action until a newer save for that key succeeds; settleTrackedSaves never rejects.
 */

type Run<T> = () => Promise<T>;

const latest = new Map<string, number>();            // key -> id of the newest attempt
const failed = new Map<string, Run<unknown>>();      // key -> retry action of the newest attempt, if it failed
const inflight = new Set<Promise<void>>();           // never-rejecting observers of attempts that have not finished
const retrying = new Set<Run<unknown>>();            // retry actions currently being re-run by some settle call

/**
 * Starts `run`, remembers it while it is in flight, and remembers it for a retry if it fails. Returns the save's own promise, so the
 * caller keeps its existing `.then` / `.catch`; an ignored rejection is still handled here, so it can never become an unhandled one.
 */
export function trackSave<T>(key: string, run: Run<T>): Promise<T> {
  const id = (latest.get(key) ?? 0) + 1;
  latest.set(key, id);
  const result = (async () => run())();
  const observed: Promise<void> = result.then(
    () => { if (latest.get(key) === id) failed.delete(key); },
    () => { if (latest.get(key) === id) failed.set(key, run); },
  ).then(() => { inflight.delete(observed); });
  inflight.add(observed);
  return result;
}

/**
 * Waits for every tracked save, retries each failed one once, and waits for that too (including any save started meanwhile).
 * Resolves true only when nothing is in flight and nothing remains failed. Never rejects. Safe to call concurrently.
 */
export async function settleTrackedSaves(): Promise<boolean> {
  const tried = new Set<Run<unknown>>();
  for (;;) {
    while (inflight.size > 0) await Promise.allSettled([...inflight]);
    const pending = [...failed].filter(([, run]) => !tried.has(run) && !retrying.has(run));
    if (pending.length === 0) {
      if (inflight.size > 0) continue; // a retry started by another call, or a new save, is still running
      return failed.size === 0;
    }
    for (const [key, run] of pending) {
      tried.add(run); retrying.add(run);
      trackSave(key, run).then(() => undefined, () => undefined).then(() => { retrying.delete(run); });
    }
  }
}
