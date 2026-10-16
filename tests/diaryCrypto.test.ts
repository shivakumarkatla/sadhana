import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DiaryCryptoError, PBKDF2_ITERATIONS, decodeRecoveryKey, decryptText, encodeRecoveryKey, encryptText, fromB64, generateDek, generateRecoverySecret,
  keysMatch, newKdfParams, toB64, unwrapDekWithPassphrase, unwrapDekWithRecovery, wrapDekWithPassphrase, wrapDekWithRecovery,
} from '../src/lib/diaryCrypto.ts';

const FAST = 100_000; // the minimum the code accepts; the default is exercised once below
const PASS = 'correct horse battery staple';

async function code(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) { return error instanceof DiaryCryptoError ? error.code : `other:${String(error)}`; }
  return 'no-error';
}

test('encrypt/decrypt round trips exact text: unicode, whitespace, empty, large', async () => {
  const key = await generateDek();
  const samples = ['', ' ', '  leading and trailing  \n\n', 'Śrī Kṛṣṇa — सत्यं शिवं सुन्दरम् — 🙏🏽 é vs é', 'line1\r\nline2\ttabbed', 'lone \ud800 surrogate', 'x'.repeat(2_000_000)];
  for (const text of samples) {
    const sealed = await encryptText(key, text, 'reflection', '2026-10-16');
    assert.equal(await decryptText(key, sealed, 'reflection', '2026-10-16'), text);
  }
});

test('every encryption uses a fresh 96-bit IV', async () => {
  const key = await generateDek();
  const seen = new Set<string>();
  for (let index = 0; index < 500; index += 1) {
    const sealed = await encryptText(key, 'same text', 'reflection', 'd');
    assert.equal(fromB64(sealed.iv).length, 12);
    assert.equal(seen.has(sealed.iv), false);
    seen.add(sealed.iv);
  }
});

test('payloads carry format and payload versions, and unknown versions are refused', async () => {
  const key = await generateDek();
  const sealed = await encryptText(key, 'hello', 'reflection', 'd');
  assert.equal(sealed.formatVersion, 1);
  assert.equal(sealed.payloadVersion, 1);
  assert.equal(await code(decryptText(key, { ...sealed, formatVersion: 2 }, 'reflection', 'd')), 'unsupported-format');
  assert.equal(await code(decryptText(key, { ...sealed, payloadVersion: 9 }, 'reflection', 'd')), 'unsupported-format');
});

test('tampering, wrong key and wrong binding fail loudly, never as empty text', async () => {
  const key = await generateDek();
  const other = await generateDek();
  const sealed = await encryptText(key, 'private words', 'reflection', '2026-10-16');
  const bytes = fromB64(sealed.ciphertext); bytes[0] ^= 1;
  assert.equal(await code(decryptText(key, { ...sealed, ciphertext: toB64(bytes) }, 'reflection', '2026-10-16')), 'auth-failed');
  assert.equal(await code(decryptText(other, sealed, 'reflection', '2026-10-16')), 'auth-failed');
  assert.equal(await code(decryptText(key, sealed, 'reflection', '2026-10-17')), 'auth-failed'); // moved to another record
  assert.equal(await code(decryptText(key, sealed, 'sadachara', '2026-10-16')), 'auth-failed'); // other content type
  assert.equal(await code(decryptText(key, { ...sealed, iv: toB64(new Uint8Array(12)) }, 'reflection', '2026-10-16')), 'auth-failed');
  assert.equal(await code(decryptText(key, { ...sealed, ciphertext: '***' }, 'reflection', '2026-10-16')), 'corrupt');
});

test('passphrase wrap: correct, wrong, weak, normalisation, parameter bounds, default iterations', async () => {
  const dek = await generateDek();
  const kdf = newKdfParams(FAST);
  const wrapped = await wrapDekWithPassphrase(dek, PASS, kdf);
  const again = await unwrapDekWithPassphrase(wrapped, PASS, kdf);
  assert.equal(await keysMatch(dek, again), true);
  assert.equal(await code(unwrapDekWithPassphrase(wrapped, 'wrong passphrase here', kdf)), 'bad-passphrase');
  assert.equal(await code(wrapDekWithPassphrase(dek, 'short', kdf)), 'weak-passphrase');
  // NFKC: a composed and a decomposed spelling of the same passphrase unlock the same diary.
  const composed = 'café au lait 12345'; const decomposed = 'café au lait 12345';
  const wrapC = await wrapDekWithPassphrase(dek, composed, kdf);
  assert.equal(await keysMatch(dek, await unwrapDekWithPassphrase(wrapC, decomposed, kdf)), true);
  assert.equal(await code(unwrapDekWithPassphrase(wrapped, PASS, { ...kdf, iterations: 1 })), 'corrupt');
  assert.equal(await code(unwrapDekWithPassphrase(wrapped, PASS, { ...kdf, iterations: 1e12 })), 'corrupt');
  assert.equal(await code(unwrapDekWithPassphrase(wrapped, PASS, { ...kdf, hash: 'SHA-1' as never })), 'unsupported-format');
  assert.equal(newKdfParams().iterations, PBKDF2_ITERATIONS);
  assert.ok(PBKDF2_ITERATIONS >= 600_000);
});

test('the unwrapped working key is not extractable', async () => {
  const dek = await generateDek(); const kdf = newKdfParams(FAST);
  const working = await unwrapDekWithPassphrase(await wrapDekWithPassphrase(dek, PASS, kdf), PASS, kdf, false);
  await assert.rejects(crypto.subtle.exportKey('raw', working));
});

test('recovery key: format, checksum, normalisation and bad input', async () => {
  const secret = generateRecoverySecret();
  const text = await encodeRecoveryKey(secret);
  assert.match(text, /^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.deepEqual(Array.from(await decodeRecoveryKey(text)), Array.from(secret));
  assert.deepEqual(Array.from(await decodeRecoveryKey(text.toLowerCase().replace(/-/g, ' '))), Array.from(secret));
  const flip = (char: string) => (char === '2' ? '3' : '2');
  const typo = text.slice(0, 20) + flip(text[20]) + text.slice(21); // index 20 is a data character, not a hyphen
  assert.equal(await code(decodeRecoveryKey(typo)), 'bad-recovery-key');
  const wrongVersion = (text[0] === '0' ? '1' : '0') + text.slice(1); // first character carries the version byte
  assert.equal(await code(decodeRecoveryKey(wrongVersion)), 'unsupported-format');
  assert.equal(await code(decodeRecoveryKey(text.slice(0, -1))), 'bad-recovery-key');
  assert.equal(await code(decodeRecoveryKey('U'.repeat(56))), 'bad-recovery-key');
  assert.equal(await code(decodeRecoveryKey('')), 'bad-recovery-key');
  assert.equal(await code(encodeRecoveryKey(new Uint8Array(5))), 'bad-recovery-key');
});

test('recovery path unwraps the same key; a different secret does not', async () => {
  const dek = await generateDek();
  const secret = generateRecoverySecret();
  const wrapped = await wrapDekWithRecovery(dek, secret);
  const recovered = await unwrapDekWithRecovery(wrapped, await decodeRecoveryKey(await encodeRecoveryKey(secret)));
  assert.equal(await keysMatch(dek, recovered), true);
  assert.equal(await code(unwrapDekWithRecovery(wrapped, generateRecoverySecret())), 'bad-recovery-key');
  assert.equal(await keysMatch(dek, await generateDek()), false);
});

test('passphrase change and recovery-key replacement never re-encrypt entries', async () => {
  const dek = await generateDek();
  const kdf = newKdfParams(FAST);
  const entry = await encryptText(dek, 'unchanged entry', 'reflection', '2026-10-16');
  const first = await wrapDekWithPassphrase(dek, PASS, kdf);
  // change passphrase: unwrap extractable, wrap again under a new salt and passphrase
  const extractable = await unwrapDekWithPassphrase(first, PASS, kdf, true);
  const kdf2 = newKdfParams(FAST);
  const second = await wrapDekWithPassphrase(extractable, 'a brand new passphrase', kdf2);
  const reopened = await unwrapDekWithPassphrase(second, 'a brand new passphrase', kdf2);
  assert.equal(await decryptText(reopened, entry, 'reflection', '2026-10-16'), 'unchanged entry');
  assert.equal(await code(unwrapDekWithPassphrase(second, PASS, kdf2)), 'bad-passphrase');
  // replace recovery key: new wrap opens the same key, old secret cannot open the new wrap
  const oldSecret = generateRecoverySecret(); const newSecret = generateRecoverySecret();
  const oldWrap = await wrapDekWithRecovery(extractable, oldSecret); const newWrap = await wrapDekWithRecovery(extractable, newSecret);
  assert.equal(await keysMatch(reopened, await unwrapDekWithRecovery(newWrap, newSecret)), true);
  assert.equal(await code(unwrapDekWithRecovery(newWrap, oldSecret)), 'bad-recovery-key');
  assert.equal(await keysMatch(reopened, await unwrapDekWithRecovery(oldWrap, oldSecret)), true); // still valid until the new record replaces it
});

test('stored metadata contains no raw key or secret material', async () => {
  const dek = await generateDek(); const kdf = newKdfParams(FAST); const secret = generateRecoverySecret();
  const stored = JSON.stringify({ kdf, passphraseWrap: await wrapDekWithPassphrase(dek, PASS, kdf), recoveryWrap: await wrapDekWithRecovery(dek, secret) });
  const rawDek = toB64(new Uint8Array(await crypto.subtle.exportKey('raw', dek)));
  assert.equal(stored.includes(rawDek), false);
  assert.equal(stored.includes(toB64(secret)), false);
  assert.equal(stored.includes(await encodeRecoveryKey(secret)), false);
  assert.equal(stored.includes(PASS), false);
});
