/**
 * Private-diary cryptography (Web Crypto only; no hand-written primitives).
 * This module is self-contained and DOM/Dexie free so it can be unit-tested with `node --test`.
 * Keep to erasable TypeScript syntax (no enums or parameter properties) so Node can run it directly.
 *
 * Formats (all versioned, see CRYPTO_FORMAT_VERSION / PAYLOAD_VERSION):
 *  - DEK:        random AES-256-GCM key. Only ever stored wrapped.
 *  - Passphrase: NFKC-normalised, PBKDF2-HMAC-SHA-256 (salt + iterations stored) -> AES-GCM wrapping key -> wraps the DEK.
 *  - Recovery:   32 random bytes. Shown to the user as Crockford Base32 of [version=1 | secret(32) | check(2)] = 35 bytes
 *                = 56 characters in 14 groups of 4. HKDF-SHA-256(secret, random salt, info) -> AES-GCM wrapping key -> wraps the DEK.
 *                The 2-byte check only catches typing mistakes; it is not a security mechanism.
 *  - Payload:    AES-256-GCM, fresh random 96-bit IV per encryption, plaintext = UTF-8 JSON {"v":1,"text":...},
 *                additional authenticated data binds kind, refId and payload version.
 *
 * Known limitation (padding deliberately deferred): AES-GCM ciphertext length equals plaintext length plus a 16-byte tag, so the
 * approximate length of each private entry, its date and its existence are visible to anyone who can read the database.
 */

export const CRYPTO_FORMAT_VERSION = 1;
export const PAYLOAD_VERSION = 1;
export const PBKDF2_ITERATIONS = 600_000;
export const MIN_PBKDF2_ITERATIONS = 100_000;
export const MAX_PBKDF2_ITERATIONS = 10_000_000;
export const MIN_PASSPHRASE_LENGTH = 12;

export type DiaryErrorCode = 'unsupported' | 'weak-passphrase' | 'bad-passphrase' | 'bad-recovery-key' | 'auth-failed' | 'unsupported-format' | 'corrupt' | 'throttled';

export class DiaryCryptoError extends Error {
  code: DiaryErrorCode;
  constructor(code: DiaryErrorCode, message: string) {
    super(message);
    this.name = 'DiaryCryptoError';
    this.code = code;
  }
}

export interface WrappedKey { iv: string; data: string }
export interface RecoveryWrap extends WrappedKey { hkdfSalt: string }
export interface KdfParams { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string }
export interface EncryptedPayload { formatVersion: number; payloadVersion: number; iv: string; ciphertext: string }

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function subtle(): SubtleCrypto {
  if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
    throw new DiaryCryptoError('unsupported', 'Secure encryption is not available here. Open the app over https (or localhost) in a current browser.');
  }
  return globalThis.crypto.subtle;
}

export function randomBytes(length: number): Uint8Array {
  subtle();
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function toB64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64(text: string): Uint8Array {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new DiaryCryptoError('corrupt', 'Stored encryption data is malformed.');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const wrapAad = (kind: 'passphrase' | 'recovery') => encoder.encode(`sadhana-diary|v${CRYPTO_FORMAT_VERSION}|dek-wrap|${kind}`);
const payloadAad = (kind: string, refId: string, payloadVersion: number) => encoder.encode(`sadhana-diary|v${CRYPTO_FORMAT_VERSION}|payload|${payloadVersion}|${kind}|${refId}`);

export function validatePassphrase(passphrase: string): void {
  if ([...passphrase].length < MIN_PASSPHRASE_LENGTH) throw new DiaryCryptoError('weak-passphrase', `Use at least ${MIN_PASSPHRASE_LENGTH} characters for the diary passphrase.`);
}

function checkKdf(kdf: KdfParams): void {
  if (!kdf || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256') throw new DiaryCryptoError('unsupported-format', 'This diary uses a key-derivation method this version cannot read.');
  if (!Number.isInteger(kdf.iterations) || kdf.iterations < MIN_PBKDF2_ITERATIONS || kdf.iterations > MAX_PBKDF2_ITERATIONS) throw new DiaryCryptoError('corrupt', 'Stored key-derivation settings are invalid.');
  if (fromB64(kdf.salt).length < 16) throw new DiaryCryptoError('corrupt', 'Stored key-derivation salt is invalid.');
}

export function newKdfParams(iterations: number = PBKDF2_ITERATIONS): KdfParams {
  return { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toB64(randomBytes(16)) };
}

export async function generateDek(): Promise<CryptoKey> {
  return subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function passphraseKek(passphrase: string, kdf: KdfParams): Promise<CryptoKey> {
  checkKdf(kdf);
  const material = await subtle().importKey('raw', encoder.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(kdf.salt), iterations: kdf.iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}

async function wrap(dek: CryptoKey, kek: CryptoKey, kind: 'passphrase' | 'recovery'): Promise<WrappedKey> {
  const iv = randomBytes(12);
  const data = await subtle().wrapKey('raw', dek, kek, { name: 'AES-GCM', iv, additionalData: wrapAad(kind) });
  return { iv: toB64(iv), data: toB64(new Uint8Array(data)) };
}

async function unwrap(wrapped: WrappedKey, kek: CryptoKey, kind: 'passphrase' | 'recovery', extractable: boolean): Promise<CryptoKey> {
  return subtle().unwrapKey('raw', fromB64(wrapped.data), kek, { name: 'AES-GCM', iv: fromB64(wrapped.iv), additionalData: wrapAad(kind) }, { name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt']);
}

/** The DEK must be extractable to be wrapped; it is generated that way and only used inside setup/re-wrap operations. */
export async function wrapDekWithPassphrase(dek: CryptoKey, passphrase: string, kdf: KdfParams): Promise<WrappedKey> {
  validatePassphrase(passphrase);
  return wrap(dek, await passphraseKek(passphrase, kdf), 'passphrase');
}

/** `extractable` should be false for the in-memory working key; true only for an immediate re-wrap. */
export async function unwrapDekWithPassphrase(wrapped: WrappedKey, passphrase: string, kdf: KdfParams, extractable = false): Promise<CryptoKey> {
  const kek = await passphraseKek(passphrase, kdf);
  try { return await unwrap(wrapped, kek, 'passphrase', extractable); }
  catch { throw new DiaryCryptoError('bad-passphrase', 'That passphrase is incorrect, or the stored key data is damaged.'); }
}

// --- recovery key -------------------------------------------------------------------------------------------------

const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function base32Encode(bytes: Uint8Array): string {
  let bits = 0; let value = 0; let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(text: string): Uint8Array {
  const output: number[] = []; let bits = 0; let value = 0;
  for (const char of text) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new DiaryCryptoError('bad-recovery-key', 'The recovery key contains a character that is not allowed.');
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { output.push((value >>> (bits - 8)) & 255); bits -= 8; }
    value &= (1 << bits) - 1;
  }
  return Uint8Array.from(output);
}

async function recoveryCheck(versionAndSecret: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', versionAndSecret.slice())).slice(0, 2);
}

export function generateRecoverySecret(): Uint8Array { return randomBytes(32); }

export async function encodeRecoveryKey(secret: Uint8Array): Promise<string> {
  if (secret.length !== 32) throw new DiaryCryptoError('bad-recovery-key', 'A recovery secret must be 32 bytes.');
  const body = new Uint8Array(33); body[0] = 1; body.set(secret, 1);
  const full = new Uint8Array(35); full.set(body); full.set(await recoveryCheck(body), 33);
  return base32Encode(full).match(/.{1,4}/g)!.join('-');
}

export async function decodeRecoveryKey(text: string): Promise<Uint8Array> {
  const cleaned = text.toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (cleaned.length !== 56) throw new DiaryCryptoError('bad-recovery-key', 'The recovery key should be 56 characters (14 groups of 4). Check for a missing or extra character.');
  const bytes = base32Decode(cleaned);
  if (bytes.length !== 35) throw new DiaryCryptoError('bad-recovery-key', 'The recovery key is malformed.');
  if (bytes[0] !== 1) throw new DiaryCryptoError('unsupported-format', 'This recovery key is from a version this app cannot read.');
  const body = bytes.slice(0, 33); const check = await recoveryCheck(body);
  if (check[0] !== bytes[33] || check[1] !== bytes[34]) throw new DiaryCryptoError('bad-recovery-key', 'The recovery key does not match its check code. Look for a mistyped character.');
  return bytes.slice(1, 33);
}

async function recoveryKek(secret: Uint8Array, hkdfSalt: Uint8Array): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', secret.slice(), 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt.slice(), info: encoder.encode(`sadhana-diary|v${CRYPTO_FORMAT_VERSION}|recovery-kek`) }, material, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}

export async function wrapDekWithRecovery(dek: CryptoKey, secret: Uint8Array): Promise<RecoveryWrap> {
  const hkdfSalt = randomBytes(16);
  const wrapped = await wrap(dek, await recoveryKek(secret, hkdfSalt), 'recovery');
  return { ...wrapped, hkdfSalt: toB64(hkdfSalt) };
}

export async function unwrapDekWithRecovery(wrapped: RecoveryWrap, secret: Uint8Array, extractable = false): Promise<CryptoKey> {
  const kek = await recoveryKek(secret, fromB64(wrapped.hkdfSalt));
  try { return await unwrap(wrapped, kek, 'recovery', extractable); }
  catch { throw new DiaryCryptoError('bad-recovery-key', 'That recovery key does not unlock this diary.'); }
}

/** Proves two unwrapped keys are the same key without ever exporting either: one encrypts a random challenge, the other decrypts it. */
export async function keysMatch(first: CryptoKey, second: CryptoKey): Promise<boolean> {
  const challenge = randomBytes(32); const iv = randomBytes(12);
  try {
    const sealed = await subtle().encrypt({ name: 'AES-GCM', iv }, first, challenge);
    const opened = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv }, second, sealed));
    return opened.length === challenge.length && opened.every((byte, index) => byte === challenge[index]);
  } catch { return false; }
}

// --- private payloads ---------------------------------------------------------------------------------------------

export async function encryptText(dek: CryptoKey, text: string, kind: string, refId: string): Promise<EncryptedPayload> {
  const iv = randomBytes(12);
  const plaintext = encoder.encode(JSON.stringify({ v: PAYLOAD_VERSION, text }));
  const sealed = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: payloadAad(kind, refId, PAYLOAD_VERSION) }, dek, plaintext);
  return { formatVersion: CRYPTO_FORMAT_VERSION, payloadVersion: PAYLOAD_VERSION, iv: toB64(iv), ciphertext: toB64(new Uint8Array(sealed)) };
}

export async function decryptText(dek: CryptoKey, payload: EncryptedPayload, kind: string, refId: string): Promise<string> {
  if (!payload || payload.formatVersion !== CRYPTO_FORMAT_VERSION || payload.payloadVersion !== PAYLOAD_VERSION) throw new DiaryCryptoError('unsupported-format', 'This entry was saved with a newer version of the app and cannot be read yet.');
  let opened: ArrayBuffer;
  try { opened = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(payload.iv), additionalData: payloadAad(kind, refId, payload.payloadVersion) }, dek, fromB64(payload.ciphertext)); }
  catch (error) {
    if (error instanceof DiaryCryptoError) throw error;
    throw new DiaryCryptoError('auth-failed', 'This entry could not be verified. It may be damaged or belong to a different diary. It has not been changed.');
  }
  try {
    const parsed: unknown = JSON.parse(decoder.decode(opened));
    if (!parsed || typeof parsed !== 'object' || (parsed as { v?: unknown }).v !== PAYLOAD_VERSION || typeof (parsed as { text?: unknown }).text !== 'string') throw new Error('shape');
    return (parsed as { text: string }).text;
  } catch { throw new DiaryCryptoError('corrupt', 'This entry decrypted but its contents are not in a readable format. It has not been changed.'); }
}
