/**
 * Private-diary key service. The unwrapped data key lives ONLY in this module (module-level variable, never React state,
 * never persisted). UI observes lock state through a tiny subscription. All cryptography is delegated to diaryCrypto.
 * Browser limits: JavaScript cannot guarantee memory erasure. Locking drops every reference this app controls to the key
 * and to decrypted text, but copies the browser or OS may hold (swap, GC timing, devtools, extensions) are out of reach.
 */
import { db, type EncryptionMetaRecord } from './db';
import {
  DiaryCryptoError, decodeRecoveryKey, decryptText, encodeRecoveryKey, encryptText, generateDek, generateRecoverySecret, keysMatch, newKdfParams,
  unwrapDekWithPassphrase, unwrapDekWithRecovery, validatePassphrase, wrapDekWithPassphrase, wrapDekWithRecovery,
  type KdfParams, type RecoveryWrap, type WrappedKey,
} from './diaryCrypto';
import { createDraftStore } from './diaryDrafts';
import { createUnlockThrottle } from './unlockThrottle';
import { SADACHARA_KIND } from './sadachara';
import { REFLECTION_KIND, attemptLock, migrateReflections, type CommitResult, type DiaryState, type MigrationStore } from './diaryRules';

export interface DiarySnapshot { loaded: boolean; state: DiaryState; unlocked: boolean; timeoutMinutes: number; lockError: string | null; unsavedDates: string[]; draftError: string | null }

export const DEFAULT_LOCK_MINUTES = 5;
export const LOCK_MINUTE_OPTIONS = [1, 5, 15, 30] as const;

let meta: EncryptionMetaRecord | undefined;
let loaded = false;
let loading: Promise<void> | null = null;
let dek: CryptoKey | null = null;
let lockError: string | null = null;
let epoch = 0;
let lastActivity = Date.now();
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let snapshot: DiarySnapshot = { loaded: false, state: 'disabled', unlocked: false, timeoutMinutes: DEFAULT_LOCK_MINUTES, lockError: null, unsavedDates: [], draftError: null };
const listeners = new Set<() => void>();
const holders = new Set<() => void>();
/** Typed-but-unsaved private text. Survives screen and date changes; only an explicit Discard or a successful save removes it. */
const drafts = createDraftStore({ save: (slot, text) => { const { kind, refId } = parseSlot(slot); return writePrivateText(kind, refId, text); }, onChange: () => emit() });
const throttle = createUnlockThrottle(typeof localStorage === 'undefined' ? null : localStorage);

function emit(): void {
  snapshot = { loaded, state: meta?.state ?? 'disabled', unlocked: dek !== null, timeoutMinutes: meta?.lockTimeoutMinutes ?? DEFAULT_LOCK_MINUTES, lockError, unsavedDates: drafts.keys(), draftError: drafts.error() };
  listeners.forEach((listener) => listener());
}
export function subscribeDiary(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function getDiarySnapshot(): DiarySnapshot { return snapshot; }

export function ensureDiaryLoaded(): Promise<void> {
  if (!loading) loading = reloadDiaryMeta();
  return loading;
}
export async function reloadDiaryMeta(): Promise<void> {
  meta = await db.encryptionMeta.get('diary');
  loaded = true;
  emit();
}

/** Registers a mounted editor's `clear`, which must drop decrypted text from its component state when the diary locks. Saving is handled by the draft store, not the component. */
export function registerDiaryHolder(clear: () => void): () => void {
  holders.add(clear);
  return () => { holders.delete(clear); };
}

// --- locking ------------------------------------------------------------------------------------------------------

const timeoutMs = () => (meta?.lockTimeoutMinutes ?? DEFAULT_LOCK_MINUTES) * 60_000;
function scheduleIdleCheck(delay?: number): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (!dek) return;
  idleTimer = setTimeout(checkIdle, Math.max(1000, delay ?? timeoutMs() - (Date.now() - lastActivity)));
}
function checkIdle(): void {
  if (!dek) return;
  if (Date.now() - lastActivity >= timeoutMs()) void lockDiary(true);
  else scheduleIdleCheck();
}
export function noteDiaryActivity(): void {
  lastActivity = Date.now();
  if (dek && !idleTimer) scheduleIdleCheck();
}
if (typeof document !== 'undefined') {
  for (const name of ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const) document.addEventListener(name, noteDiaryActivity, { passive: true, capture: true });
  // Timers are throttled or frozen while a PWA is backgrounded, so elapsed time is re-checked whenever the app comes back.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkIdle(); });
  window.addEventListener('pageshow', checkIdle);
  window.addEventListener('focus', checkIdle);
}

function dropKey(): void {
  dek = null;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  lockError = null;
}

/** Flush -> confirm -> clear decrypted text -> clear key -> mark locked. If any save fails the diary stays unlocked and nothing is discarded. */
export async function lockDiary(automatic = false): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!dek) return { ok: true };
  const outcome = await attemptLock({
    flush: () => drafts.flush(),
    hasUnsaved: () => drafts.keys().length > 0,
    clearDecrypted: () => holders.forEach((clear) => clear()),
    dropKey,
  });
  if (!outcome.ok) {
    lockError = 'Some private text could not be saved, so the diary stays unlocked and nothing was discarded. Use Retry saving, then lock again.';
    emit();
    if (automatic) scheduleIdleCheck(30_000);
    return { ok: false, error: lockError };
  }
  emit();
  return { ok: true };
}

function startSession(key: CryptoKey): void {
  dek = key;
  lockError = null;
  lastActivity = Date.now();
  scheduleIdleCheck();
  emit();
}

/** Re-imports a key as non-extractable for in-memory use; the temporary raw copy is zeroed immediately. */
async function toWorkingKey(extractable: CryptoKey): Promise<CryptoKey> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', extractable));
  try { return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
  finally { raw.fill(0); }
}

// --- setup (nothing is persisted until the recovery path has been verified) ------------------------------------------

interface PendingSetup { dek: CryptoKey; kdf: KdfParams; passphraseWrap: WrappedKey; recoveryWrap: RecoveryWrap; verified: boolean }
let pendingSetup: PendingSetup | null = null;

export async function prepareSetup(passphrase: string): Promise<string> {
  await ensureDiaryLoaded();
  if (meta) throw new DiaryCryptoError('unsupported-format', 'Private diary encryption is already set up.');
  validatePassphrase(passphrase);
  const key = await generateDek();
  const kdf = newKdfParams();
  const passphraseWrap = await wrapDekWithPassphrase(key, passphrase, kdf);
  const check = await unwrapDekWithPassphrase(passphraseWrap, passphrase, kdf, false);
  if (!(await keysMatch(key, check))) throw new DiaryCryptoError('corrupt', 'The passphrase key could not be verified. Nothing was changed.');
  const secret = generateRecoverySecret();
  const recoveryWrap = await wrapDekWithRecovery(key, secret);
  pendingSetup = { dek: key, kdf, passphraseWrap, recoveryWrap, verified: false };
  const text = await encodeRecoveryKey(secret);
  secret.fill(0);
  return text;
}

export async function verifySetupRecovery(entered: string): Promise<void> {
  if (!pendingSetup) throw new DiaryCryptoError('corrupt', 'Setup was interrupted. Please start again.');
  const recovered = await unwrapDekWithRecovery(pendingSetup.recoveryWrap, await decodeRecoveryKey(entered), false);
  if (!(await keysMatch(pendingSetup.dek, recovered))) throw new DiaryCryptoError('bad-recovery-key', 'That recovery key does not unlock this diary.');
  pendingSetup.verified = true;
}

export function cancelSetup(): void { pendingSetup = null; }

/** Persists the key records (state 'migrating') and unlocks. Plaintext reflections are untouched at this point. */
export async function commitSetup(): Promise<void> {
  if (!pendingSetup?.verified) throw new DiaryCryptoError('corrupt', 'The recovery key has not been verified yet.');
  const now = new Date().toISOString();
  const record: EncryptionMetaRecord = { id: 'diary', formatVersion: 1, state: 'migrating', lockTimeoutMinutes: DEFAULT_LOCK_MINUTES, kdf: pendingSetup.kdf, passphraseWrap: pendingSetup.passphraseWrap, recoveryWrap: pendingSetup.recoveryWrap, createdAt: now, updatedAt: now };
  const working = await toWorkingKey(pendingSetup.dek);
  await db.encryptionMeta.add(record);
  pendingSetup = null;
  meta = record;
  startSession(working);
}

export async function countPlaintextReflections(): Promise<number> {
  return (await db.sadhana.toArray()).filter((row) => typeof row.reflection === 'string' && row.reflection !== '').length;
}

const dexieMigrationStore: MigrationStore = {
  listRows: async () => (await db.sadhana.toArray()).map((row) => ({ id: row.id as number, date: row.date, reflection: row.reflection ?? '' })),
  commit: ({ sadhanaId, expectedText, record }) => db.transaction('rw', db.sadhana, db.privateContent, async (): Promise<CommitResult> => {
    const row = await db.sadhana.get(sadhanaId);
    if (!row || row.reflection !== expectedText) return 'stale';
    if (await db.privateContent.get(record.id)) return 'conflict';
    await db.privateContent.add(record);
    await db.sadhana.update(sadhanaId, { reflection: '' });
    return 'committed';
  }),
};

/** Resumable. Marks the diary 'enabled' only after every plaintext reflection is verified encrypted and cleared. */
export async function runReflectionMigration(onProgress?: (migrated: number) => void): Promise<{ migrated: number }> {
  const key = dek;
  if (!key || meta?.state !== 'migrating') throw new DiaryCryptoError('corrupt', 'Unlock the diary to continue setup.');
  const result = await migrateReflections(dexieMigrationStore, {
    encrypt: (text, kind, refId) => encryptText(key, text, kind, refId),
    decrypt: (payload, kind, refId) => decryptText(key, payload, kind, refId),
  }, { onProgress });
  if ((await countPlaintextReflections()) > 0) throw new DiaryCryptoError('corrupt', 'Some reflections are still readable text, so setup was not completed.');
  const next: EncryptionMetaRecord = { ...meta, state: 'enabled', updatedAt: new Date().toISOString() };
  await db.encryptionMeta.put(next);
  meta = next;
  emit();
  return { migrated: result.migrated };
}

// --- unlock, passphrase, recovery ----------------------------------------------------------------------------------

function requireMeta(): EncryptionMetaRecord {
  if (!meta) throw new DiaryCryptoError('corrupt', 'The private diary is not set up.');
  return meta;
}

export async function unlockWithPassphrase(passphrase: string): Promise<void> {
  await ensureDiaryLoaded();
  const current = requireMeta();
  const wait = throttle.remainingMs();
  if (wait > 0) throw new DiaryCryptoError('throttled', `Too many incorrect attempts. Please wait ${Math.ceil(wait / 1000)} seconds before trying again, or use your recovery key.`);
  let key: CryptoKey;
  try { key = await unwrapDekWithPassphrase(current.passphraseWrap, passphrase, current.kdf, false); }
  catch (error) {
    if (error instanceof DiaryCryptoError && error.code === 'bad-passphrase') throttle.recordFailure();
    throw error;
  }
  throttle.reset();
  startSession(key);
}

/** Seconds a user-facing countdown can show before the next passphrase attempt is allowed. */
export function unlockWaitSeconds(): number { return Math.ceil(throttle.remainingMs() / 1000); }

async function rewrapPassphrase(extractable: CryptoKey, passphrase: string): Promise<{ kdf: KdfParams; passphraseWrap: WrappedKey; working: CryptoKey }> {
  validatePassphrase(passphrase);
  const kdf = newKdfParams();
  const passphraseWrap = await wrapDekWithPassphrase(extractable, passphrase, kdf);
  const working = await unwrapDekWithPassphrase(passphraseWrap, passphrase, kdf, false);
  if (!(await keysMatch(extractable, working))) throw new DiaryCryptoError('corrupt', 'The new passphrase could not be verified. Nothing was changed.');
  return { kdf, passphraseWrap, working };
}

async function saveMeta(patch: Partial<EncryptionMetaRecord>): Promise<void> {
  const next = { ...requireMeta(), ...patch, updatedAt: new Date().toISOString() } as EncryptionMetaRecord;
  await db.encryptionMeta.put(next);
  meta = next;
}

export async function changePassphrase(current: string, next: string): Promise<void> {
  const record = requireMeta();
  const extractable = await unwrapDekWithPassphrase(record.passphraseWrap, current, record.kdf, true);
  const { kdf, passphraseWrap, working } = await rewrapPassphrase(extractable, next);
  await saveMeta({ kdf, passphraseWrap });
  startSession(working);
}

/** The recovery key unwraps the same data key, then a new passphrase is set. Existing entries are not re-encrypted. */
export async function recoverWithKey(recoveryText: string, newPassphrase: string): Promise<void> {
  await ensureDiaryLoaded();
  const record = requireMeta();
  const extractable = await unwrapDekWithRecovery(record.recoveryWrap, await decodeRecoveryKey(recoveryText), true);
  const { kdf, passphraseWrap, working } = await rewrapPassphrase(extractable, newPassphrase);
  await saveMeta({ kdf, passphraseWrap });
  throttle.reset(); // the recovery key is never throttled and proves ownership
  startSession(working);
}

interface PendingRecovery { dek: CryptoKey; recoveryWrap: RecoveryWrap }
let pendingRecovery: PendingRecovery | null = null;

/** Step 1 of replacing the recovery key: the current recovery path stays valid until step 2 succeeds. */
export async function beginRecoveryReplacement(passphrase: string): Promise<string> {
  const record = requireMeta();
  const extractable = await unwrapDekWithPassphrase(record.passphraseWrap, passphrase, record.kdf, true);
  const secret = generateRecoverySecret();
  pendingRecovery = { dek: extractable, recoveryWrap: await wrapDekWithRecovery(extractable, secret) };
  const text = await encodeRecoveryKey(secret);
  secret.fill(0);
  return text;
}

export async function confirmRecoveryReplacement(entered: string): Promise<void> {
  if (!pendingRecovery) throw new DiaryCryptoError('corrupt', 'This step expired. Please start again.');
  const recovered = await unwrapDekWithRecovery(pendingRecovery.recoveryWrap, await decodeRecoveryKey(entered), false);
  if (!(await keysMatch(pendingRecovery.dek, recovered)) || (dek && !(await keysMatch(dek, recovered)))) throw new DiaryCryptoError('bad-recovery-key', 'That recovery key does not unlock this diary.');
  await saveMeta({ recoveryWrap: pendingRecovery.recoveryWrap });
  pendingRecovery = null;
  emit();
}
export function cancelRecoveryReplacement(): void { pendingRecovery = null; }

export async function setLockTimeoutMinutes(minutes: number): Promise<void> {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) throw new RangeError('Choose a timeout between 1 and 120 minutes.');
  await saveMeta({ lockTimeoutMinutes: minutes });
  scheduleIdleCheck();
  emit();
}

// --- private entries -----------------------------------------------------------------------------------------------

let writeChain: Promise<unknown> = Promise.resolve();

/** Kinds of private text this service will read or write. Anything else is refused so a stray caller cannot create new plaintext-adjacent records. */
const PRIVATE_KINDS: readonly string[] = [REFLECTION_KIND, SADACHARA_KIND];
/** A draft slot is `kind:refId`; a bare date is a Daily Reflection (the original slot form). Only the first colon splits, so refIds may contain colons. */
function parseSlot(slot: string): { kind: string; refId: string } {
  const at = slot.indexOf(':');
  return at < 0 ? { kind: REFLECTION_KIND, refId: slot } : { kind: slot.slice(0, at), refId: slot.slice(at + 1) };
}

export async function readPrivateText(kind: string, refId: string): Promise<string> {
  if (!PRIVATE_KINDS.includes(kind)) throw new DiaryCryptoError('corrupt', 'Unknown private content type.');
  const key = dek; const ticket = epoch;
  if (!key) throw new DiaryCryptoError('corrupt', 'The diary is locked.');
  const record = await db.privateContent.get(`${kind}:${refId}`);
  if (!record) return '';
  const text = await decryptText(key, record, kind, refId);
  if (dek !== key || epoch !== ticket) throw new DiaryCryptoError('corrupt', 'The diary was locked while loading.');
  return text;
}

/** Encrypts outside the transaction, then commits in a short one. Saves are serialised so revisions never interleave. */
export function writePrivateText(kind: string, refId: string, text: string): Promise<void> {
  if (!PRIVATE_KINDS.includes(kind)) return Promise.reject(new DiaryCryptoError('corrupt', 'Unknown private content type.'));
  const run = async () => {
    const key = dek; const ticket = epoch;
    if (!key) throw new DiaryCryptoError('corrupt', 'The diary is locked.');
    const payload = await encryptText(key, text, kind, refId);
    const id = `${kind}:${refId}`;
    await db.transaction('rw', db.privateContent, async () => {
      if (dek !== key || epoch !== ticket) throw new DiaryCryptoError('corrupt', 'The diary was locked before this text could be saved.');
      const existing = await db.privateContent.get(id);
      await db.privateContent.put({ id, kind, refId, ...payload, updatedAt: new Date().toISOString(), rev: (existing?.rev ?? 0) + 1 });
    });
  };
  const result = writeChain.then(run, run);
  writeChain = result.catch(() => undefined);
  return result;
}

export const readReflection = (date: string): Promise<string> => readPrivateText(REFLECTION_KIND, date);
export const writeReflection = (date: string, text: string): Promise<void> => writePrivateText(REFLECTION_KIND, date, text);
export const getReflectionDraft = (date: string): string | undefined => drafts.get(date);
export const setReflectionDraft = (date: string, text: string): void => drafts.set(date, text);
/** Sādācāra written answers share the same draft store, so they get the same keep-on-failure, retry and save-on-hide behaviour. */
export const getPrivateDraft = (kind: string, refId: string): string | undefined => drafts.get(`${kind}:${refId}`);
export const setPrivateDraft = (kind: string, refId: string, text: string): void => drafts.set(`${kind}:${refId}`, text);
export const retryUnsavedDrafts = (): Promise<void> => drafts.flush();
/** Only ever called from an explicit user choice. */
export function discardUnsavedDrafts(): void {
  drafts.discard();
  holders.forEach((reload) => reload()); // an open editor drops the discarded text and shows what is actually saved
}

if (typeof window !== 'undefined') {
  // A backgrounded page can be frozen or discarded before a 700 ms debounce timer runs, so unsaved text is saved the moment the page is hidden, frozen or unloaded.
  const saveNow = () => { if (drafts.keys().length > 0) drafts.flush().catch(() => undefined); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
  document.addEventListener('freeze', saveNow);
  window.addEventListener('pagehide', saveNow);
  // Reloading or closing with unsaved private text asks first, because that text exists nowhere else.
  window.addEventListener('beforeunload', (event) => { if (drafts.keys().length > 0) { event.preventDefault(); event.returnValue = ''; } });
}

// --- wipe / restore hooks (used by backup.ts) ----------------------------------------------------------------------

/** Drops key, pending flows and decrypted text without saving anything (Delete All, restore). */
export function discardDiarySession(): void {
  epoch += 1;
  holders.forEach((clear) => clear());
  drafts.discard();
  pendingSetup = null; pendingRecovery = null;
  dropKey();
  emit();
}
export async function resetDiaryAfterWipe(): Promise<void> {
  discardDiarySession();
  meta = undefined;
  loaded = true;
  emit();
}
export async function reloadDiaryAfterRestore(): Promise<void> {
  discardDiarySession();
  await reloadDiaryMeta();
}
