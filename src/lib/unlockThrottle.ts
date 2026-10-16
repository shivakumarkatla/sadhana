/**
 * A modest, user-facing delay after repeated wrong diary passphrases.
 *
 * What this is NOT: it does not stop offline guessing against a copied database or backup file, and anyone who can edit this
 * browser's storage can reset it. The real defence is the passphrase length rule plus the slow PBKDF2 key derivation.
 * Delays never exceed two minutes, there is no permanent lockout, and the recovery key path is never throttled, so the owner
 * cannot be locked out of their own data. Erasable TypeScript only.
 */

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

/** Wait imposed after the n-th consecutive failure (index n). The first two mistakes are free; the cap is 2 minutes. */
export const THROTTLE_STEPS_MS = [0, 0, 0, 5_000, 10_000, 30_000, 60_000, 120_000];
export const THROTTLE_MAX_MS = 120_000;
const STORAGE_KEY = 'sadhana.diary.unlockThrottle';

export function delayAfterFailures(failures: number): number {
  return THROTTLE_STEPS_MS[Math.min(Math.max(0, Math.floor(failures)), THROTTLE_STEPS_MS.length - 1)];
}

export interface UnlockThrottle {
  /** Milliseconds still to wait before another passphrase attempt is allowed (0 = go ahead). */
  remainingMs(): number;
  /** Call after a wrong passphrase. Returns the wait now in force. */
  recordFailure(): number;
  /** Call after any successful unlock. */
  reset(): void;
  failures(): number;
}

export function createUnlockThrottle(storage: StorageLike | null, now: () => number = Date.now): UnlockThrottle {
  let memory = { failures: 0, until: 0 };
  const read = () => {
    if (!storage) return memory;
    try {
      const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null');
      if (parsed && typeof parsed === 'object') {
        const { failures, until } = parsed as { failures?: unknown; until?: unknown };
        if (Number.isFinite(failures) && Number.isFinite(until)) return { failures: Math.max(0, Number(failures)), until: Number(until) };
      }
    } catch { /* unreadable state is treated as no failures */ }
    return { failures: 0, until: 0 };
  };
  const write = (state: { failures: number; until: number }) => {
    memory = state;
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* storage blocked: the in-memory copy still applies */ }
  };
  return {
    remainingMs() { return Math.min(THROTTLE_MAX_MS, Math.max(0, read().until - now())); }, // a far-future timestamp can never exceed the cap
    failures: () => read().failures,
    recordFailure() {
      const failures = read().failures + 1;
      const wait = delayAfterFailures(failures);
      write({ failures, until: now() + wait });
      return wait;
    },
    reset() {
      memory = { failures: 0, until: 0 };
      try { storage?.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    },
  };
}
