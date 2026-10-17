import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_FORMAT_VERSION, STORE_NAMES, V1_STORE_NAMES, buildBackup, checksumStores, differingStores, serializeBackup, validateBackup, type BackupStores } from '../src/lib/backupFormat.ts';
import { buildVowLog, createVow, transitionVow, type SeasonalVow, type VowLog } from '../src/lib/seasonal.ts';
import { encryptText, generateDek, generateRecoverySecret, newKdfParams, wrapDekWithPassphrase, wrapDekWithRecovery } from '../src/lib/diaryCrypto.ts';

const ctx = { today: '2026-10-20', now: '2026-10-20T08:00:00.000Z' };
const SECRET = 'TESTSECRET private diary words';

function vow(id: string, input: Parameters<typeof createVow>[1], status: SeasonalVow['status'] = 'active'): SeasonalVow { return { ...createVow(id, input, ctx), status }; }
function seasonalStores(): { vows: SeasonalVow[]; logs: VowLog[] } {
  const japa = vow('vow-japa', { type: 'japa', seasonName: 'Test season', name: 'Extra Japa', startDate: '2026-10-10', endDate: '2026-11-10', config: { targetRounds: 20 } });
  const study = vow('vow-study', { type: 'study', seasonName: 'Test season', name: 'Study', startDate: '2026-10-10', endDate: '2026-11-10', config: { minutesPerDay: 30, scripture: 'Bhāgavatam' } });
  const lamp = vow('vow-lamp', { type: 'lamps', seasonName: 'Test season', name: 'Evening lamp', startDate: '2026-10-10', endDate: '2026-11-10', config: {} });
  const paused = transitionVow(vow('vow-abst', { type: 'abstinence', seasonName: 'Test season', name: 'Quiet from sweets', startDate: '2026-10-10', endDate: '2026-11-10', config: {} }), 'pause', [], ctx);
  const logs = [buildVowLog({ vow: lamp, date: '2026-10-12', entry: { completed: true }, ctx })];
  return { vows: [japa, study, lamp, paused], logs };
}
async function stores(options: { encrypted?: boolean; seasonal?: boolean } = {}): Promise<BackupStores> {
  const { vows, logs } = options.seasonal === false ? { vows: [], logs: [] } : seasonalStores();
  const base: BackupStores = {
    sessions: [{ id: 1, date: '2026-10-15', kind: 'Study', title: 'SB', minutes: 45 }],
    offerings: [{ id: 1, date: '2026-10-15', kind: 'Calling Service', minutes: 30, description: 'calls' }],
    sadhana: [{ id: 1, date: '2026-10-15', rounds: 16, targetRounds: 16, earlyRounds: 8, sixteenthRoundTime: '', wakeUp: '4:15 AM', bedtime: '10 PM', sleepOnset: '', mangalaArati: 'Attended', reflection: SECRET, targetSnapshot: { rounds: 20, source: 'seasonal', vowId: 'vow-japa', vowName: 'Extra Japa' } }],
    encryptionMeta: [], privateContent: [],
    seasonalVows: vows as unknown as Record<string, unknown>[], vowLogs: logs as unknown as Record<string, unknown>[], sadacharaAssessments: [],
  };
  if (options.encrypted) {
    const dek = await generateDek(); const kdf = newKdfParams(100_000);
    base.sadhana[0].reflection = '';
    base.encryptionMeta = [{ id: 'diary', formatVersion: 1, state: 'enabled', lockTimeoutMinutes: 5, kdf, passphraseWrap: await wrapDekWithPassphrase(dek, 'twelve chars minimum', kdf), recoveryWrap: await wrapDekWithRecovery(dek, generateRecoverySecret()), createdAt: 'a', updatedAt: 'b' }];
    base.privateContent = [{ id: 'reflection:2026-10-15', kind: 'reflection', refId: '2026-10-15', ...(await encryptText(dek, SECRET, 'reflection', '2026-10-15')), updatedAt: 'a', rev: 1 }];
  }
  return base;
}
const fileOf = async (data: BackupStores) => JSON.parse(serializeBackup(await buildBackup(data, 5))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- tests corrupt arbitrary fields
const errorsOf = async (raw: unknown) => { const result = await validateBackup(raw); return result.ok ? [] : result.errors; };

test('format 2 backups include every store, and seasonal commitments and logs survive a round trip exactly', async () => {
  const data = await stores({ encrypted: true });
  const backup = await buildBackup(data, 5);
  assert.equal(backup.backupFormat, BACKUP_FORMAT_VERSION); assert.equal(BACKUP_FORMAT_VERSION, 3);
  assert.deepEqual(Object.keys(backup.stores).sort(), [...STORE_NAMES].sort());
  assert.deepEqual(backup.counts, { sessions: 1, offerings: 1, sadhana: 1, encryptionMeta: 1, privateContent: 1, seasonalVows: 4, vowLogs: 1, sadacharaAssessments: 0 });
  const result = await validateBackup(JSON.parse(serializeBackup(backup)));
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(differingStores(result.backup.stores, data), [], 'nothing differs after export and validation');
    assert.deepEqual(result.backup.stores.seasonalVows, data.seasonalVows);
    assert.deepEqual(result.backup.stores.vowLogs, data.vowLogs);
    assert.deepEqual((result.backup.stores.sadhana[0] as { targetSnapshot: unknown }).targetSnapshot, { rounds: 20, source: 'seasonal', vowId: 'vow-japa', vowName: 'Extra Japa' }, 'per-day snapshots travel with the Sādhana rows');
  }
});

test('adding seasonal stores leaves encryption key records and ciphertext byte-for-byte unchanged, and never exposes private text', async () => {
  const withSeasonal = await stores({ encrypted: true });
  const without = { ...withSeasonal, seasonalVows: [], vowLogs: [] };
  const a = await buildBackup(withSeasonal, 5); const b = await buildBackup(without, 5);
  assert.equal(JSON.stringify(a.stores.encryptionMeta), JSON.stringify(b.stores.encryptionMeta));
  assert.equal(JSON.stringify(a.stores.privateContent), JSON.stringify(b.stores.privateContent));
  assert.equal(serializeBackup(a).includes(SECRET), false);
  assert.doesNotMatch(serializeBackup(a), /"(passphrase|recoverySecret|recoveryKey|rawDek|rawKey)"/i);
  assert.equal(a.diaryState, 'enabled'); assert.equal(a.containsPlaintextReflections, false);
});

test('a format 1 backup (made before Seasonal Saṅkalpa) is still accepted, read as having empty seasonal stores, and clearly warned about', async () => {
  const data = await stores({ encrypted: true, seasonal: false });
  const five = Object.fromEntries(V1_STORE_NAMES.map((name) => [name, data[name]])) as unknown as BackupStores;
  const v1 = { app: 'sadhana-devotional-companion', backupFormat: 1, dbSchemaVersion: 4, exportedAt: 'x', diaryState: 'enabled', containsPlaintextReflections: false, counts: Object.fromEntries(V1_STORE_NAMES.map((name) => [name, data[name].length])), checksum: await checksumStores(five), stores: five };
  const result = await validateBackup(JSON.parse(JSON.stringify(v1)));
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.backup.stores.seasonalVows, []); assert.deepEqual(result.backup.stores.vowLogs, []);
    assert.equal(result.backup.backupFormat, 3); assert.equal(result.backup.counts.seasonalVows, 0);
    assert.equal(result.backup.checksum, await checksumStores(result.backup.stores));
    assert.ok(result.warnings.some((warning) => /before Seasonal Saṅkalpa and Sādācāra existed/.test(warning)));
    assert.equal(JSON.stringify(result.backup.stores.encryptionMeta), JSON.stringify(data.encryptionMeta));
  }
  const tampered = JSON.parse(JSON.stringify(v1)); tampered.stores.sessions[0].minutes = 999;
  assert.match((await errorsOf(tampered)).join(' '), /checksum/);
  const dropped = JSON.parse(JSON.stringify(v1)); delete dropped.stores.sadhana;
  assert.match((await errorsOf(dropped)).join(' '), /missing the sadhana/);
});

test('unsupported or damaged seasonal backups fail safely with clear errors that never echo private text', async () => {
  const good = await fileOf(await stores({ encrypted: true }));
  const mutate = (change: (copy: any) => void) => { const copy = JSON.parse(JSON.stringify(good)); change(copy); return copy; }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const cases: [string, unknown, RegExp][] = [
    ['newer format', mutate((b) => { b.backupFormat = 4; }), /newer version/],
    ['format zero', mutate((b) => { b.backupFormat = 0; }), /not supported/],
    ['missing seasonal store', mutate((b) => { delete b.stores.seasonalVows; }), /missing the seasonalVows/],
    ['missing log store', mutate((b) => { delete b.stores.vowLogs; }), /missing the vowLogs/],
    ['count mismatch', mutate((b) => { b.counts.seasonalVows = 9; }), /seasonalVows record count/],
    ['tampered vow', mutate((b) => { b.stores.seasonalVows[0].name = 'edited'; }), /checksum does not match/],
    ['bad vow dates', mutate((b) => { b.stores.seasonalVows[0].endDate = '2026-02-30'; }), /invalid dates/],
    ['end before start', mutate((b) => { b.stores.seasonalVows[0].endDate = '2026-10-01'; }), /invalid dates/],
    ['unknown type', mutate((b) => { b.stores.seasonalVows[0].type = 'mystery'; }), /unknown type/],
    ['unknown status', mutate((b) => { b.stores.seasonalVows[0].status = 'weird'; }), /unknown status/],
    ['bad japa target', mutate((b) => { b.stores.seasonalVows[0].config.targetRounds = 500; }), /invalid commitment details/],
    ['bad early end', mutate((b) => { b.stores.seasonalVows[0].endedOn = '2027-01-01'; }), /early end date/],
    ['repeated vow id', mutate((b) => { b.stores.seasonalVows[1].id = b.stores.seasonalVows[0].id; }), /repeats id|repeats a commitment id/],
    ['dangling log', mutate((b) => { b.stores.vowLogs[0].vowId = 'vow-gone'; b.stores.vowLogs[0].id = 'vow-gone|2026-10-12'; }), /not in the backup/],
    ['inconsistent log id', mutate((b) => { b.stores.vowLogs[0].id = 'nonsense'; }), /inconsistent id/],
    ['log type mismatch', mutate((b) => { b.stores.vowLogs[0].type = 'abstinence'; }), /commitment type|invalid entry/],
    ['bad log entry', mutate((b) => { b.stores.vowLogs[0].completed = 'yes'; }), /invalid entry/],
    ['bad snapshot', mutate((b) => { b.stores.sadhana[0].targetSnapshot = { rounds: 'x', source: 'nope' }; }), /invalid target snapshot/],
    ['forbidden secret field', mutate((b) => { b.stores.seasonalVows[0].config.passphrase = 'oops'; }), /never has/],
  ];
  for (const [name, input, expected] of cases) {
    const errors = await errorsOf(input);
    assert.ok(errors.length > 0 && errors.some((error) => expected.test(error)), `${name}: ${errors.join(' | ') || 'accepted'}`);
    assert.equal(errors.join(' ').includes(SECRET), false);
  }
});

test('conflicting active Japa commitments in a backup produce a warning (the resolver then uses the regular target), not a corrupt-file error', async () => {
  const data = await stores();
  const clash = vow('vow-clash', { type: 'japa', seasonName: 'Test season', name: 'Clash', startDate: '2026-10-20', endDate: '2026-10-25', config: { targetRounds: 24 } });
  const result = await validateBackup(await fileOf({ ...data, seasonalVows: [...data.seasonalVows, clash as unknown as Record<string, unknown>] }));
  assert.ok(result.ok);
  if (result.ok) assert.ok(result.warnings.some((warning) => /different daily targets/.test(warning)));
});

test('a backup with no seasonal data validates cleanly, and logs may legitimately fall outside later-edited dates', async () => {
  assert.ok((await validateBackup(await fileOf(await stores({ seasonal: false })))).ok);
  const data = await stores();
  (data.seasonalVows[2] as { startDate: string }).startDate = '2026-10-20'; // the vow was later edited to start after an old log
  assert.ok((await validateBackup(await fileOf(data))).ok, 'history is kept even if the vow’s dates were edited afterwards');
});
