/**
 * In-memory store for private text that has been typed but not yet safely saved. It outlives the editor component,
 * so leaving a screen or switching dates cannot lose text, and a failed save keeps the draft instead of dropping it.
 * Pure (storage is injected) so the data-loss rules can be tested with `node --test`. Erasable TypeScript only.
 * Draft text is never logged; only the key (a date) and a generic message are exposed.
 */

export interface DraftStore {
  get(key: string): string | undefined;
  set(key: string, text: string): void;
  keys(): string[];
  /** Generic, text-free message for the first failed save, or null. */
  error(): string | null;
  /** Tries to save every draft. Rejects, keeping every draft, if any save fails or text remains unsaved. */
  flush(): Promise<void>;
  /** Explicit user choice only: throws the unsaved text away. */
  discard(): void;
}

export interface DraftStoreOptions {
  save(key: string, text: string): Promise<void>;
  delayMs?: number;
  onChange?: () => void;
}

export const SAVE_FAILED_MESSAGE = 'Your latest private text could not be saved. It is still here; nothing was discarded.';

export function createDraftStore(options: DraftStoreOptions): DraftStore {
  const delayMs = options.delayMs ?? 700;
  const drafts = new Map<string, string>();
  const failed = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let chain: Promise<unknown> = Promise.resolve();
  const changed = () => options.onChange?.();

  const saveOne = (key: string): Promise<void> => {
    const run = async () => {
      for (let pass = 0; pass < 5; pass += 1) {
        const sent = drafts.get(key);
        if (sent === undefined) return;
        try { await options.save(key, sent); }
        catch (error) { failed.add(key); changed(); throw error; }
        failed.delete(key);
        if (drafts.get(key) === sent) { drafts.delete(key); changed(); return; }
      }
    };
    const result = chain.then(run, run); // saves are serialised so an older save can never land after a newer one
    chain = result.catch(() => undefined);
    return result;
  };

  const clearTimers = () => { timers.forEach((timer) => clearTimeout(timer)); timers.clear(); };

  return {
    get: (key) => drafts.get(key),
    keys: () => [...drafts.keys()],
    error: () => (failed.size > 0 ? SAVE_FAILED_MESSAGE : null),
    set(key, text) {
      drafts.set(key, text);
      const existing = timers.get(key);
      if (existing) clearTimeout(existing);
      timers.set(key, setTimeout(() => { timers.delete(key); saveOne(key).catch(() => undefined); }, delayMs));
      changed();
    },
    async flush() {
      clearTimers();
      let problem = false;
      for (const key of [...drafts.keys()]) {
        try { await saveOne(key); } catch { problem = true; }
      }
      if (problem || drafts.size > 0) throw new Error('Some private text is still unsaved.');
    },
    discard() {
      clearTimers();
      drafts.clear(); failed.clear();
      changed();
    },
  };
}
