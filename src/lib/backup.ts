/**
 * Full backup, restore and Delete All against the real database. File format and validation live in backupFormat.ts.
 * Private diary text is only ever in a backup as ciphertext once the diary is enabled; a backup made before encryption
 * contains readable reflections and is flagged as such.
 */
import { db } from './db';
import { buildBackup, differingStores, serializeBackup, validateBackup, STORE_NAMES, type BackupFile, type BackupStores } from './backupFormat';
import { discardDiarySession, lockDiary, reloadDiaryAfterRestore, reloadDiaryMeta, resetDiaryAfterWipe } from './diaryService';

const tables = () => [db.sessions, db.offerings, db.sadhana, db.encryptionMeta, db.privateContent, db.seasonalVows, db.vowLogs, db.sadacharaAssessments];

/** One read-only transaction, so the stores are a consistent snapshot of each other. */
export async function readAllStores(): Promise<BackupStores> {
  return db.transaction('r', tables(), async () => ({
    sessions: (await db.sessions.toArray()) as unknown as Record<string, unknown>[],
    offerings: (await db.offerings.toArray()) as unknown as Record<string, unknown>[],
    sadhana: (await db.sadhana.toArray()) as unknown as Record<string, unknown>[],
    encryptionMeta: (await db.encryptionMeta.toArray()) as unknown as Record<string, unknown>[],
    privateContent: (await db.privateContent.toArray()) as unknown as Record<string, unknown>[],
    seasonalVows: (await db.seasonalVows.toArray()) as unknown as Record<string, unknown>[],
    vowLogs: (await db.vowLogs.toArray()) as unknown as Record<string, unknown>[],
    sadacharaAssessments: (await db.sadacharaAssessments.toArray()) as unknown as Record<string, unknown>[],
  }));
}

export interface CreatedBackup { text: string; backup: BackupFile; warnings: string[] }

/** Builds the file, re-parses and validates the exact text, and checks it against the database (read again afterwards to catch concurrent edits). */
export async function createVerifiedBackup(): Promise<CreatedBackup> {
  const stores = await readAllStores();
  const backup = await buildBackup(stores, db.verno);
  const text = serializeBackup(backup);
  const checked = await validateBackup(JSON.parse(text));
  if (!checked.ok) throw new Error(`The backup could not be verified (${checked.errors[0]}). Nothing was changed.`);
  const mismatch = differingStores(checked.backup.stores, stores);
  if (mismatch.length) throw new Error(`The backup did not match your data (${mismatch.join(', ')}). Nothing was changed.`);
  const after = differingStores(stores, await readAllStores());
  if (after.length) throw new Error('Your data changed while the backup was being created. Please try again.');
  return { text, backup: checked.backup, warnings: checked.warnings };
}

export async function parseBackupText(text: string): Promise<{ ok: true; backup: BackupFile; warnings: string[] } | { ok: false; errors: string[] }> {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, errors: ['This file is not valid JSON, so it is not a Sādhana backup.'] }; }
  return validateBackup(raw);
}

/** File-integrity check only: it shows the re-selected file is the same one that was generated, not that it is decryptable or stored safely. */
export async function verifyBackupFileMatches(text: string, expectedChecksum: string): Promise<boolean> {
  const parsed = await parseBackupText(text);
  return parsed.ok && parsed.backup.checksum === expectedChecksum;
}

export function downloadTextFile(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function replaceAllStores(stores: BackupStores): Promise<void> {
  await db.transaction('rw', tables(), async () => {
    await Promise.all(tables().map((table) => table.clear()));
    await db.sessions.bulkAdd(stores.sessions as never[]);
    await db.offerings.bulkAdd(stores.offerings as never[]);
    await db.sadhana.bulkAdd(stores.sadhana as never[]);
    await db.encryptionMeta.bulkAdd(stores.encryptionMeta as never[]);
    await db.privateContent.bulkAdd(stores.privateContent as never[]);
    await db.seasonalVows.bulkAdd(stores.seasonalVows as never[]);
    await db.vowLogs.bulkAdd(stores.vowLogs as never[]);
    await db.sadacharaAssessments.bulkAdd(stores.sadacharaAssessments as never[]);
  });
}

/**
 * Validates first (done by the caller via parseBackupText), then: lock the diary, snapshot current data, replace every store in ONE
 * transaction (all-or-nothing), read back and compare, and roll back from the snapshot if the comparison fails.
 * After success the diary is locked again and must be unlocked with the backup's passphrase or recovery key.
 */
export async function restoreBackup(backup: BackupFile): Promise<{ counts: BackupFile['counts'] }> {
  const locked = await lockDiary();
  if (!locked.ok) throw new Error(locked.error);
  const snapshot = await readAllStores();
  try { await replaceAllStores(backup.stores); }
  catch (error) {
    console.error('Restore failed; the previous data was kept', error instanceof Error ? error.name : 'error');
    await reloadDiaryMeta();
    throw new Error('The restore could not be completed. Your previous data was kept unchanged.');
  }
  let mismatch: string[];
  try { mismatch = differingStores(backup.stores, await readAllStores()); } catch { mismatch = ['unreadable']; }
  if (mismatch.length) {
    // Roll back. A failure inside the rollback itself must still end in a clear message, never a raw error.
    let restored: boolean;
    try { await replaceAllStores(snapshot); restored = differingStores(snapshot, await readAllStores()).length === 0; } catch { restored = false; }
    await reloadDiaryAfterRestore();
    throw new Error(restored
      ? 'The restored data did not match the backup, so your previous data was put back unchanged.'
      : `The restored data did not match the backup (${mismatch.join(', ')}) and your previous data could not be fully put back. Use your pre-restore backup file.`);
  }
  await reloadDiaryAfterRestore();
  return { counts: backup.counts };
}

/** Clears every application store in one transaction, then every in-memory trace. Does not touch backup files you saved elsewhere. */
export async function deleteAllData(): Promise<void> {
  discardDiarySession();
  try {
    await db.transaction('rw', tables(), async () => { await Promise.all(tables().map((table) => table.clear())); });
    const left = await readAllStores();
    if (STORE_NAMES.some((name) => left[name].length > 0)) throw new Error('Some records could not be removed.');
  } catch (error) {
    await reloadDiaryMeta();
    throw error instanceof Error ? error : new Error('Local records could not be deleted.');
  }
  await resetDiaryAfterWipe();
}
