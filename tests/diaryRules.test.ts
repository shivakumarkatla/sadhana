import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decryptText, encryptText, generateDek } from '../src/lib/diaryCrypto.ts';
import { MigrationIncompleteError, migrateReflections, reflectionForSave, type CommitResult, type MigrationCrypto, type MigrationStore, type PrivateRecord } from '../src/lib/diaryRules.ts';

interface Row { id: number; date: string; reflection: string; rounds: number; wakeUp: string; targetRounds: number }
interface Fake { rows: Row[]; privates: Map<string, PrivateRecord>; store: MigrationStore; commits: number }

function makeFake(rows: Row[], hooks: { beforeCommit?: (n: number, fake: Fake) => void | Promise<void> } = {}): Fake {
  const fake: Fake = {
    rows: rows.map((row) => ({ ...row })), privates: new Map(), commits: 0,
    store: {
      listRows: async () => fake.rows.map(({ id, date, reflection }) => ({ id, date, reflection })),
      commit: async ({ sadhanaId, expectedText, record }): Promise<CommitResult> => {
        fake.commits += 1;
        await hooks.beforeCommit?.(fake.commits, fake); // may throw to simulate quota/abort; nothing has been written yet
        const row = fake.rows.find((item) => item.id === sadhanaId);
        if (!row || row.reflection !== expectedText) return 'stale';
        if (fake.privates.has(record.id)) return 'conflict';
        fake.privates.set(record.id, record); row.reflection = '';
        return 'committed';
      },
    },
  };
  return fake;
}

async function realCrypto(overrides: Partial<MigrationCrypto> = {}): Promise<{ crypto: MigrationCrypto; key: CryptoKey }> {
  const key = await generateDek();
  return { key, crypto: { encrypt: (text, kind, refId) => encryptText(key, text, kind, refId), decrypt: (payload, kind, refId) => decryptText(key, payload, kind, refId), ...overrides } };
}
const row = (id: number, date: string, reflection: string): Row => ({ id, date, reflection, rounds: id * 3, wakeUp: '4:15 AM', targetRounds: 16 });

test('autosave rule: only a disabled diary may write incoming text', () => {
  assert.equal(reflectionForSave('disabled', 'new text', 'old'), 'new text');
  assert.equal(reflectionForSave('migrating', 'stale plaintext', 'original'), 'original');
  assert.equal(reflectionForSave('migrating', 'stale plaintext', undefined), '');
  assert.equal(reflectionForSave('enabled', 'stale plaintext', ''), '');
  assert.equal(reflectionForSave('enabled', 'stale plaintext', undefined), '');
});

test('a stale in-memory record cannot resurrect plaintext after migration', async () => {
  const fake = makeFake([row(1, '2026-10-16', 'secret thoughts')]);
  const stale = { ...fake.rows[0] }; // the React state captured before migration
  const { crypto } = await realCrypto();
  await migrateReflections(fake.store, crypto);
  assert.equal(fake.rows[0].reflection, '');
  // every later autosave of rounds/targets/times goes through the same rule
  stale.rounds = 14; stale.wakeUp = '4:00 AM';
  fake.rows[0] = { ...stale, reflection: reflectionForSave('enabled', stale.reflection, fake.rows[0].reflection) };
  assert.equal(fake.rows[0].reflection, '');
  assert.equal(fake.rows[0].rounds, 14);
});

test('migration preserves exact text, ids, dates and every other field', async () => {
  const texts = ['  spaced \n text  ', 'Śrī Kṛṣṇa 🙏🏽 — सत्यं', 'x'.repeat(500_000)];
  const originals = texts.map((text, index) => row(index + 1, `2026-10-1${index}`, text));
  const fake = makeFake([...originals, row(9, '2026-10-20', '')]);
  const { crypto, key } = await realCrypto();
  const result = await migrateReflections(fake.store, crypto);
  assert.equal(result.migrated, 3);
  assert.equal(result.remaining, 0);
  for (const original of originals) {
    const after = fake.rows.find((item) => item.id === original.id)!;
    assert.deepEqual({ ...after, reflection: original.reflection }, original); // all non-reflection fields identical
    assert.equal(after.reflection, '');
    const sealed = fake.privates.get(`reflection:${original.date}`)!;
    assert.equal(await decryptText(key, sealed, 'reflection', original.date), original.reflection);
  }
  assert.equal(fake.rows.find((item) => item.id === 9)!.reflection, '');
  assert.equal(fake.privates.size, 3); // the empty reflection created no entry
});

test('plaintext is not removed before the encrypted copy verifies', async () => {
  const fake = makeFake([row(1, '2026-10-16', 'precious')]);
  const { crypto } = await realCrypto({ decrypt: async () => 'something else' });
  await assert.rejects(migrateReflections(fake.store, crypto), /Encryption check failed/);
  assert.equal(fake.rows[0].reflection, 'precious');
  assert.equal(fake.privates.size, 0);
  assert.equal(fake.commits, 0);
  const broken = await realCrypto({ encrypt: async () => { throw new Error('boom'); } });
  await assert.rejects(migrateReflections(fake.store, broken.crypto));
  assert.equal(fake.rows[0].reflection, 'precious');
});

test('interrupted migration (quota error) keeps plaintext and resumes without redoing finished records', async () => {
  const fake = makeFake([row(1, '2026-10-14', 'one'), row(2, '2026-10-15', 'two'), row(3, '2026-10-16', 'three')], {
    beforeCommit: (n) => { if (n === 2) throw new DOMException('quota', 'QuotaExceededError'); },
  });
  const { crypto, key } = await realCrypto();
  await assert.rejects(migrateReflections(fake.store, crypto));
  assert.deepEqual(fake.rows.map((item) => item.reflection), ['', 'two', 'three']);
  assert.equal(fake.privates.size, 1);
  const before = fake.privates.get('reflection:2026-10-14')!.ciphertext;
  const result = await migrateReflections(fake.store, crypto);
  assert.equal(result.migrated, 2);
  assert.equal(fake.privates.get('reflection:2026-10-14')!.ciphertext, before); // already-migrated record untouched
  assert.deepEqual(fake.rows.map((item) => item.reflection), ['', '', '']);
  assert.equal(await decryptText(key, fake.privates.get('reflection:2026-10-16')!, 'reflection', '2026-10-16'), 'three');
});

test('a record edited during migration is detected as stale and picked up on the next pass', async () => {
  const fake = makeFake([row(1, '2026-10-16', 'before edit')], { beforeCommit: (n, f) => { if (n === 1) f.rows[0].reflection = 'after edit'; } });
  const { crypto, key } = await realCrypto();
  const result = await migrateReflections(fake.store, crypto);
  assert.equal(result.migrated, 1);
  assert.equal(await decryptText(key, fake.privates.get('reflection:2026-10-16')!, 'reflection', '2026-10-16'), 'after edit');
  assert.equal(fake.rows[0].reflection, '');
});

test('migration is never reported complete while any plaintext remains', async () => {
  const fake = makeFake([row(1, '2026-10-16', 'stubborn')], { beforeCommit: (_n, f) => { f.rows[0].reflection += '!'; } }); // always stale
  const { crypto } = await realCrypto();
  await assert.rejects(migrateReflections(fake.store, crypto, { maxPasses: 2 }), (error: unknown) => error instanceof MigrationIncompleteError && error.remaining === 1 && !error.message.includes('stubborn'));
  assert.notEqual(fake.rows[0].reflection, '');
});

test('duplicate rows for one date keep every text; the shown row owns the date', async () => {
  const fake = makeFake([row(1, '2026-10-16', 'shown'), row(2, '2026-10-16', 'hidden duplicate')]);
  const { crypto, key } = await realCrypto();
  await migrateReflections(fake.store, crypto);
  assert.equal(await decryptText(key, fake.privates.get('reflection:2026-10-16')!, 'reflection', '2026-10-16'), 'shown');
  assert.equal(await decryptText(key, fake.privates.get('reflection:2026-10-16#2')!, 'reflection', '2026-10-16#2'), 'hidden duplicate');
});

test('an existing private record is never overwritten by migration', async () => {
  const fake = makeFake([row(1, '2026-10-16', 'plaintext copy')]);
  const { crypto, key } = await realCrypto();
  const existing = { ...(await encryptText(key, 'earlier encrypted', 'reflection', '2026-10-16')), id: 'reflection:2026-10-16', kind: 'reflection', refId: '2026-10-16', updatedAt: 'x', rev: 4 };
  fake.privates.set(existing.id, existing);
  await migrateReflections(fake.store, crypto);
  assert.equal(fake.privates.get('reflection:2026-10-16')!.ciphertext, existing.ciphertext);
  assert.equal(await decryptText(key, fake.privates.get('reflection:2026-10-16#1')!, 'reflection', '2026-10-16#1'), 'plaintext copy');
});
