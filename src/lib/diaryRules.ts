/**
 * Pure diary rules that must hold regardless of UI or storage: what an autosave may write to the plaintext
 * `reflection` column, and the resumable plaintext -> ciphertext migration. Storage and crypto are injected so the
 * logic is testable with `node --test` and no IndexedDB. Erasable TypeScript only.
 */

export type DiaryState = 'disabled' | 'migrating' | 'enabled';

/**
 * What an autosave of a Sādhana row may leave in `reflection`.
 * Only while the diary is disabled may incoming text be written. Once setup begins (migrating) or finishes (enabled),
 * the stored value is kept untouched, so a stale in-memory record can never resurrect plaintext, and the migration
 * commit is the only code that clears it.
 */
export function reflectionForSave(state: DiaryState, incoming: string, stored: string | undefined): string {
  return state === 'disabled' ? incoming : (stored ?? '');
}

export interface PlainRow { id: number; date: string; reflection: string }
export interface PrivateRecord {
  id: string; kind: string; refId: string;
  formatVersion: number; payloadVersion: number; iv: string; ciphertext: string;
  updatedAt: string; rev: number;
}
export type CommitResult = 'committed' | 'stale' | 'conflict';
export interface MigrationStore {
  listRows(): Promise<PlainRow[]>;
  /** One short transaction: only if the row's reflection still equals expectedText and no private record has this id, write the record and clear the row. */
  commit(input: { sadhanaId: number; expectedText: string; record: PrivateRecord }): Promise<CommitResult>;
}
export interface MigrationCrypto {
  encrypt(text: string, kind: string, refId: string): Promise<{ formatVersion: number; payloadVersion: number; iv: string; ciphertext: string }>;
  decrypt(payload: { formatVersion: number; payloadVersion: number; iv: string; ciphertext: string }, kind: string, refId: string): Promise<string>;
}
export interface MigrationResult { migrated: number; remaining: number }

export class MigrationIncompleteError extends Error {
  remaining: number;
  constructor(remaining: number) {
    super(`${remaining} reflection${remaining === 1 ? '' : 's'} could not be verified and ${remaining === 1 ? 'was' : 'were'} left unchanged. Nothing was lost; you can retry.`);
    this.name = 'MigrationIncompleteError';
    this.remaining = remaining;
  }
}

export const REFLECTION_KIND = 'reflection';

/**
 * Encrypts every non-empty plaintext reflection and verifies it before touching the original.
 * Order per record: encrypt (outside any transaction) -> decrypt and compare exactly -> short commit that rechecks the row.
 * A failure at any step leaves the plaintext in place. Safe to run again: encrypted rows have an empty column and are skipped.
 * If a date has several rows, the lowest id (the one the app shows) takes the date; the others get an `#id` suffix so no text is dropped.
 */
export async function migrateReflections(store: MigrationStore, crypto: MigrationCrypto, options: { maxPasses?: number; now?: () => string; onProgress?: (migrated: number) => void } = {}): Promise<MigrationResult> {
  const maxPasses = options.maxPasses ?? 3;
  const now = options.now ?? (() => new Date().toISOString());
  let migrated = 0;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const pending = (await store.listRows()).filter((row) => row.reflection !== '').sort((a, b) => a.id - b.id);
    if (!pending.length) break;
    for (const row of pending) {
      const primary = !(await hasEarlierRow(store, row));
      let refId = primary ? row.date : `${row.date}#${row.id}`;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const payload = await crypto.encrypt(row.reflection, REFLECTION_KIND, refId);
        if ((await crypto.decrypt(payload, REFLECTION_KIND, refId)) !== row.reflection) throw new Error('Encryption check failed; the original reflection was left unchanged.');
        const result = await store.commit({ sadhanaId: row.id, expectedText: row.reflection, record: { id: `${REFLECTION_KIND}:${refId}`, kind: REFLECTION_KIND, refId, ...payload, updatedAt: now(), rev: 1 } });
        if (result === 'committed') { migrated += 1; options.onProgress?.(migrated); break; }
        if (result === 'conflict' && attempt === 0) { refId = `${row.date}#${row.id}`; continue; }
        break;
      }
    }
  }
  const remaining = (await store.listRows()).filter((row) => row.reflection !== '').length;
  if (remaining > 0) throw new MigrationIncompleteError(remaining);
  return { migrated, remaining };
}

async function hasEarlierRow(store: MigrationStore, row: PlainRow): Promise<boolean> {
  // An earlier row for the same date (even with an empty reflection) is the one the app shows, so this row is a duplicate.
  return (await store.listRows()).some((other) => other.date === row.date && other.id < row.id);
}

export interface LockDeps { flush(): Promise<void>; hasUnsaved(): boolean; clearDecrypted(): void; dropKey(): void }

/**
 * Lock order: flush pending saves, confirm nothing is left unsaved, then clear decrypted state, then the key.
 * Any failure, or text typed during the flush, aborts the lock and leaves the key and every draft in place.
 */
export async function attemptLock(deps: LockDeps): Promise<{ ok: boolean }> {
  try { await deps.flush(); } catch { return { ok: false }; }
  if (deps.hasUnsaved()) return { ok: false };
  deps.clearDecrypted();
  deps.dropKey();
  return { ok: true };
}
