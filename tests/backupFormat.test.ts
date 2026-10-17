import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBackup, differingStores, serializeBackup, validateBackup, STORE_NAMES, type BackupStores } from '../src/lib/backupFormat.ts';
import { encryptText, generateDek, generateRecoverySecret, newKdfParams, wrapDekWithPassphrase, wrapDekWithRecovery } from '../src/lib/diaryCrypto.ts';

const SECRET_TEXT = 'my private struggle with sleep';

function plainStores(): BackupStores {
  return {
    sessions: [{ id: 1, date: '2026-10-15', kind: 'Study', title: 'SB', minutes: 45 }],
    offerings: [{ id: 1, date: '2026-10-15', kind: 'Calling Service', minutes: 30, description: 'calls' }],
    sadhana: [{ id: 1, date: '2026-10-15', rounds: 16, targetRounds: 16, earlyRounds: 8, sixteenthRoundTime: '', wakeUp: '4:15 AM', bedtime: '10 PM', sleepOnset: '', mangalaArati: 'Attended', reflection: SECRET_TEXT, qualityTags: ['Good focus'] }],
    encryptionMeta: [], privateContent: [], seasonalVows: [], vowLogs: [], sadacharaAssessments: [],
  };
}

async function encryptedStores(): Promise<BackupStores> {
  const dek = await generateDek(); const kdf = newKdfParams(100_000);
  const sealed = await encryptText(dek, SECRET_TEXT, 'reflection', '2026-10-15');
  const stores = plainStores();
  stores.sadhana[0].reflection = '';
  stores.encryptionMeta = [{ id: 'diary', formatVersion: 1, state: 'enabled', lockTimeoutMinutes: 5, kdf, passphraseWrap: await wrapDekWithPassphrase(dek, 'twelve chars minimum', kdf), recoveryWrap: await wrapDekWithRecovery(dek, generateRecoverySecret()), createdAt: 'a', updatedAt: 'b' }];
  stores.privateContent = [{ id: 'reflection:2026-10-15', kind: 'reflection', refId: '2026-10-15', ...sealed, updatedAt: 'a', rev: 1 }];
  return stores;
}

const roundTrip = async (stores: BackupStores) => JSON.parse(serializeBackup(await buildBackup(stores, 4)));
async function errorsOf(raw: unknown): Promise<string[]> { const result = await validateBackup(raw); return result.ok ? [] : result.errors; }

test('a backup covers every store, schema version, counts and checksum', async () => {
  const backup = await buildBackup(await encryptedStores(), 6);
  assert.deepEqual(Object.keys(backup.stores).sort(), [...STORE_NAMES].sort());
  assert.equal(backup.dbSchemaVersion, 6);
  assert.equal(backup.backupFormat, 3);
  assert.deepEqual(backup.counts, { sessions: 1, offerings: 1, sadhana: 1, encryptionMeta: 1, privateContent: 1, seasonalVows: 0, vowLogs: 0, sadacharaAssessments: 0 });
  assert.equal(backup.diaryState, 'enabled');
  const result = await validateBackup(JSON.parse(serializeBackup(backup)));
  assert.equal(result.ok, true);
});

test('an encrypted backup carries wrapped keys and ciphertext but no readable private text or raw secrets', async () => {
  const text = serializeBackup(await buildBackup(await encryptedStores(), 4));
  assert.equal(text.includes(SECRET_TEXT), false);
  assert.match(text, /"passphraseWrap"/); assert.match(text, /"recoveryWrap"/); assert.match(text, /"ciphertext"/);
  assert.doesNotMatch(text, /"(passphrase|recoverySecret|recoveryKey|rawDek|rawKey)"/i);
});

test('a pre-encryption backup is flagged as containing readable reflections', async () => {
  const backup = await buildBackup(plainStores(), 4);
  assert.equal(backup.containsPlaintextReflections, true);
  const result = await validateBackup(await roundTrip(plainStores()));
  assert.ok(result.ok && result.warnings.some((warning) => /readable/.test(warning)));
});

test('invalid backups are rejected with clear errors and without echoing private text', async () => {
  const good = await roundTrip(await encryptedStores());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests deliberately corrupt arbitrary fields
  const mutate = (change: (copy: any) => void) => { const copy = JSON.parse(JSON.stringify(good)); change(copy); return copy; };
  const cases: [string, unknown, RegExp][] = [
    ['null', null, /not a Sādhana backup/], ['string', 'hello', /not a Sādhana backup/], ['array', [], /not a Sādhana backup/],
    ['legacy export', { sessions: [], offerings: [], exportedAt: 'x' }, /older, incomplete export/],
    ['other app', mutate((b) => { b.app = 'other'; }), /not created by this app/],
    ['newer format', mutate((b) => { b.backupFormat = 4; }), /newer version/],
    ['missing store', mutate((b) => { delete b.stores.sadhana; }), /missing the sadhana/],
    ['count mismatch', mutate((b) => { b.counts.sessions = 7; }), /count does not match/],
    ['tampered data', mutate((b) => { b.stores.sessions[0].minutes = 999; }), /checksum does not match/],
    ['bad date', mutate((b) => { b.stores.sessions[0].date = 'yesterday'; }), /invalid date/],
    ['forbidden key', mutate((b) => { b.stores.encryptionMeta[0].passphrase = 'oops'; }), /never has/],
    ['bad ciphertext', mutate((b) => { b.stores.privateContent[0].ciphertext = '***'; }), /malformed ciphertext/],
    ['inconsistent id', mutate((b) => { b.stores.privateContent[0].id = 'reflection:2000-01-01'; }), /inconsistent id/],
    ['plaintext while enabled', mutate((b) => { b.stores.sadhana[0].reflection = SECRET_TEXT; }), /inconsistent/],
    ['ciphertext without keys', mutate((b) => { b.stores.encryptionMeta = []; b.counts.encryptionMeta = 0; }), /no diary key record/],
  ];
  for (const [name, input, expected] of cases) {
    const errors = await errorsOf(input);
    assert.ok(errors.length > 0 && errors.some((error) => expected.test(error)), `${name}: ${errors.join(' | ')}`);
    assert.equal(errors.join(' ').includes(SECRET_TEXT), false);
  }
});

test('differingStores finds exactly the stores that changed', async () => {
  const left = plainStores(); const right = JSON.parse(JSON.stringify(left)) as BackupStores;
  assert.deepEqual(differingStores(left, right), []);
  right.sessions[0].minutes = 1; right.privateContent.push({ id: 'x' });
  assert.deepEqual(differingStores(left, right), ['sessions', 'privateContent']);
});
