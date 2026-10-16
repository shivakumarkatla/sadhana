/**
 * Backup file format, validation and comparison. Pure (no Dexie, no DOM) so it can be tested with `node --test`.
 * A backup holds every application store. Private diary text is present only as ciphertext once the diary is enabled;
 * wrapped keys are included so an encrypted diary can be restored on another device. Raw keys, the passphrase and the
 * recovery secret are never part of a backup. Erasable TypeScript only.
 */

export const BACKUP_APP = 'sadhana-devotional-companion';
export const BACKUP_FORMAT_VERSION = 1;
export const STORE_NAMES = ['sessions', 'offerings', 'sadhana', 'encryptionMeta', 'privateContent'] as const;
export type StoreName = (typeof STORE_NAMES)[number];
export type BackupStores = Record<StoreName, Record<string, unknown>[]>;

export interface BackupFile {
  app: string;
  backupFormat: number;
  dbSchemaVersion: number;
  exportedAt: string;
  diaryState: 'disabled' | 'migrating' | 'enabled';
  containsPlaintextReflections: boolean;
  counts: Record<StoreName, number>;
  checksum: string;
  stores: BackupStores;
}

export type ValidationResult = { ok: true; backup: BackupFile; warnings: string[] } | { ok: false; errors: string[] };

const FORBIDDEN_KEYS = new Set(['passphrase', 'recoverysecret', 'recoverykey', 'rawkey', 'rawdek']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
const SESSION_KINDS = ['Study', 'Hearing', 'Service'];
const OFFERING_KINDS = ['Book Distribution', 'DYS Session Conducting', 'DYS Registration', 'Calling Service', 'Prasadam Cooking for Boys', 'Others'];
const ARATI = ['Attended', 'Not today', 'Unrecorded'];

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function checksumStores(stores: BackupStores): Promise<string> { return sha256Hex(JSON.stringify(stores)); }

export function diaryStateOf(stores: BackupStores): 'disabled' | 'migrating' | 'enabled' {
  const state = stores.encryptionMeta[0]?.state;
  return state === 'enabled' || state === 'migrating' ? state : 'disabled';
}

export function hasPlaintextReflections(stores: BackupStores): boolean {
  return stores.sadhana.some((row) => typeof row.reflection === 'string' && row.reflection !== '');
}

export async function buildBackup(stores: BackupStores, dbSchemaVersion: number, now: Date = new Date()): Promise<BackupFile> {
  const counts = Object.fromEntries(STORE_NAMES.map((name) => [name, stores[name].length])) as Record<StoreName, number>;
  return {
    app: BACKUP_APP, backupFormat: BACKUP_FORMAT_VERSION, dbSchemaVersion, exportedAt: now.toISOString(),
    diaryState: diaryStateOf(stores), containsPlaintextReflections: hasPlaintextReflections(stores),
    counts, checksum: await checksumStores(stores), stores,
  };
}

export function serializeBackup(backup: BackupFile): string { return JSON.stringify(backup, null, 2); }

/** Names of stores whose contents differ between two snapshots (order-sensitive JSON comparison of identically ordered reads). */
export function differingStores(left: BackupStores, right: BackupStores): StoreName[] {
  return STORE_NAMES.filter((name) => JSON.stringify(left[name]) !== JSON.stringify(right[name]));
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function findForbiddenKey(value: unknown, depth = 0): string | null {
  if (depth > 6 || typeof value !== 'object' || value === null) return null;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) return key;
    const found = findForbiddenKey(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function checkRecords(name: StoreName, records: Record<string, unknown>[], errors: string[], warnings: string[]): void {
  const ids = new Set<unknown>(); const dates = new Set<string>();
  records.forEach((record, index) => {
    const where = `${name}[${index}]`;
    if (!isRecord(record)) { errors.push(`${where} is not an object.`); return; }
    if (ids.has(record.id)) errors.push(`${where} repeats id ${String(record.id)}.`);
    ids.add(record.id);
    const str = (field: string) => typeof record[field] === 'string';
    const num = (field: string) => typeof record[field] === 'number' && Number.isFinite(record[field] as number);
    if (name === 'sessions' || name === 'offerings') {
      if (!Number.isInteger(record.id)) errors.push(`${where} has no valid id.`);
      if (!str('date') || !DATE.test(record.date as string)) errors.push(`${where} has an invalid date.`);
      if (!OFFERING_KINDS.concat(SESSION_KINDS).includes(record.kind as string) || !(name === 'sessions' ? SESSION_KINDS : OFFERING_KINDS).includes(record.kind as string)) errors.push(`${where} has an unknown kind.`);
      if (!num('minutes') || (record.minutes as number) < 0) errors.push(`${where} has invalid minutes.`);
    } else if (name === 'sadhana') {
      if (!Number.isInteger(record.id)) errors.push(`${where} has no valid id.`);
      if (!str('date') || !DATE.test(record.date as string)) errors.push(`${where} has an invalid date.`);
      else if (dates.has(record.date as string)) warnings.push(`More than one Sādhana record exists for ${record.date as string}.`);
      else dates.add(record.date as string);
      for (const field of ['rounds', 'targetRounds', 'earlyRounds']) if (!num(field)) errors.push(`${where} has an invalid ${field}.`);
      for (const field of ['sixteenthRoundTime', 'wakeUp', 'bedtime', 'sleepOnset', 'reflection']) if (!str(field)) errors.push(`${where} has an invalid ${field}.`);
      if (!ARATI.includes(record.mangalaArati as string)) errors.push(`${where} has an invalid Maṅgala Ārati value.`);
      if (record.qualityTags !== undefined && !(Array.isArray(record.qualityTags) && record.qualityTags.every((tag) => typeof tag === 'string'))) errors.push(`${where} has invalid quality tags.`);
    } else if (name === 'encryptionMeta') {
      const kdf = record.kdf; const passphraseWrap = record.passphraseWrap; const recoveryWrap = record.recoveryWrap;
      if (record.id !== 'diary') errors.push(`${where} has an unexpected id.`);
      if (!['migrating', 'enabled'].includes(record.state as string)) errors.push(`${where} has an invalid state.`);
      if (record.formatVersion !== 1) errors.push(`${where} uses an unsupported encryption format.`);
      if (!isRecord(kdf) || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256' || !Number.isInteger(kdf.iterations) || (kdf.iterations as number) < 100_000 || (kdf.iterations as number) > 10_000_000 || typeof kdf.salt !== 'string' || !B64.test(kdf.salt)) errors.push(`${where} has invalid key-derivation settings.`);
      if (!isRecord(passphraseWrap) || typeof passphraseWrap.iv !== 'string' || typeof passphraseWrap.data !== 'string' || !B64.test(passphraseWrap.iv) || !B64.test(passphraseWrap.data)) errors.push(`${where} has an invalid passphrase key record.`);
      if (!isRecord(recoveryWrap) || typeof recoveryWrap.iv !== 'string' || typeof recoveryWrap.data !== 'string' || typeof recoveryWrap.hkdfSalt !== 'string' || !B64.test(recoveryWrap.iv) || !B64.test(recoveryWrap.data) || !B64.test(recoveryWrap.hkdfSalt)) errors.push(`${where} has an invalid recovery key record.`);
      if (!Number.isInteger(record.lockTimeoutMinutes) || (record.lockTimeoutMinutes as number) < 1) errors.push(`${where} has an invalid lock timeout.`);
    } else {
      if (typeof record.id !== 'string' || !str('kind') || !str('refId') || record.id !== `${record.kind as string}:${record.refId as string}`) errors.push(`${where} has an inconsistent id.`);
      if (record.formatVersion !== 1 || record.payloadVersion !== 1) errors.push(`${where} uses an unsupported payload format.`);
      if (typeof record.iv !== 'string' || !B64.test(record.iv) || typeof record.ciphertext !== 'string' || !B64.test(record.ciphertext)) errors.push(`${where} has malformed ciphertext.`);
      if (!Number.isInteger(record.rev)) errors.push(`${where} has an invalid revision.`);
    }
  });
}

/** Validates structure and consistency without touching any database. Never echoes record contents into messages. */
export async function validateBackup(raw: unknown): Promise<ValidationResult> {
  if (!isRecord(raw)) return { ok: false, errors: ['This is not a Sādhana backup file.'] };
  if (raw.app === undefined && Array.isArray(raw.sessions) && Array.isArray(raw.offerings)) {
    return { ok: false, errors: ['This is an older, incomplete export (sessions and offerings only, no Sādhana records). Restoring it would erase your Sādhana records, so it cannot be used.'] };
  }
  if (raw.app !== BACKUP_APP) return { ok: false, errors: ['This file was not created by this app.'] };
  if (typeof raw.backupFormat !== 'number' || raw.backupFormat > BACKUP_FORMAT_VERSION) return { ok: false, errors: ['This backup was created by a newer version of the app. Update the app before restoring it.'] };
  if (raw.backupFormat !== BACKUP_FORMAT_VERSION) return { ok: false, errors: ['This backup format is not supported.'] };
  if (!isRecord(raw.stores)) return { ok: false, errors: ['The backup has no data section.'] };
  const errors: string[] = []; const warnings: string[] = [];
  for (const name of STORE_NAMES) if (!Array.isArray(raw.stores[name])) errors.push(`The backup is missing the ${name} data.`);
  if (errors.length) return { ok: false, errors };
  const stores = raw.stores as unknown as BackupStores;
  const forbidden = findForbiddenKey(stores);
  if (forbidden) errors.push(`The backup contains a field named "${forbidden}", which a genuine backup never has.`);
  for (const name of STORE_NAMES) {
    checkRecords(name, stores[name], errors, warnings);
    if (isRecord(raw.counts) && raw.counts[name] !== stores[name].length) errors.push(`The ${name} record count does not match the file.`);
  }
  if (!isRecord(raw.counts)) errors.push('The backup has no record counts.');
  if (stores.encryptionMeta.length > 1) errors.push('The backup has more than one diary key record.');
  const state = diaryStateOf(stores);
  if (state === 'disabled' && stores.privateContent.length > 0) errors.push('The backup has encrypted entries but no diary key record.');
  if (state === 'enabled' && hasPlaintextReflections(stores)) errors.push('The backup says the diary is encrypted but still contains readable reflections, so it is inconsistent.');
  if (errors.length === 0) {
    if ((await checksumStores(stores)) !== raw.checksum) errors.push('The backup checksum does not match its contents. The file may be damaged or edited.');
    if (raw.diaryState !== state) errors.push('The backup diary status does not match its contents.');
    if (raw.containsPlaintextReflections !== hasPlaintextReflections(stores)) errors.push('The backup plaintext flag does not match its contents.');
  }
  if (errors.length) return { ok: false, errors };
  if (hasPlaintextReflections(stores)) warnings.push('This backup contains readable (unencrypted) Daily Reflection text. Keep the file private.');
  return { ok: true, backup: raw as unknown as BackupFile, warnings };
}
