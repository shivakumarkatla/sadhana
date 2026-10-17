import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_TEXT_FIELDS, AREA_IDS, SADACHARA_AREAS, SADACHARA_KIND, SADACHARA_PROMPTS, answeredCount, averageRating, blankRatings, buildAssessment, buildShareReport,
  currentMonth, draftSlotFor, isComplete, isValidMonth, monthLabel, refIdFor, shiftMonth, textFieldFor, validateAssessmentRecord, withRating,
} from '../src/lib/sadachara.ts';
import { BACKUP_FORMAT_VERSION, STORE_NAMES, V1_STORE_NAMES, V2_STORE_NAMES, buildBackup, checksumStores, differingStores, serializeBackup, validateBackup, type BackupStores } from '../src/lib/backupFormat.ts';
import { decryptText, encryptText, generateDek, generateRecoverySecret, newKdfParams, wrapDekWithPassphrase, wrapDekWithRecovery } from '../src/lib/diaryCrypto.ts';

const SECRET = 'TESTSECRET-sadachara struggles with my family';

test('the six agreed areas and four prompts are present, and sleep is not an area', () => {
  assert.equal(SADACHARA_AREAS.length, 6); assert.equal(SADACHARA_PROMPTS.length, 4);
  assert.deepEqual(SADACHARA_AREAS.map((area) => area.title), ['Relationship with Equals', 'Relationship with Seniors', 'Relationship with Juniors', 'Avoidance of Inappropriate Interaction', 'Health', 'Service Attitude']);
  assert.equal(SADACHARA_AREAS.some((area) => /sleep/i.test(area.title + area.description)), false);
  assert.deepEqual(SADACHARA_PROMPTS.map((prompt) => prompt.title), ['Struggles in Kṛṣṇa consciousness', 'Difficulties with parents or relatives', 'What I want to improve next month', 'What support or guidance would help me?']);
  assert.equal(ALL_TEXT_FIELDS.length, 10);
});

test('1. one assessment per month: the id is the month, a second save replaces the first, creation time is kept', () => {
  const first = buildAssessment('2026-10', withRating(blankRatings(), 'equals', 7), undefined, '2026-10-20T08:00:00.000Z');
  assert.equal(first.id, '2026-10'); assert.equal(first.month, '2026-10'); assert.equal(first.status, 'in-progress');
  const second = buildAssessment('2026-10', withRating(first.ratings, 'seniors', 9), first, '2026-10-21T08:00:00.000Z');
  assert.equal(second.id, first.id); assert.equal(second.createdAt, first.createdAt); assert.equal(second.updatedAt, '2026-10-21T08:00:00.000Z');
  assert.equal(second.ratings.equals, 7); assert.equal(second.ratings.seniors, 9);
  assert.throws(() => buildAssessment('2026-13', blankRatings(), undefined, 'x'), /valid month/);
  const done = buildAssessment('2026-10', Object.fromEntries(AREA_IDS.map((id) => [id, 5])), second, 'later');
  assert.equal(done.status, 'complete'); assert.equal(isComplete(done.ratings), true);
});

test('2. unanswered is different from zero, and the average skips unanswered areas', () => {
  const blank = blankRatings();
  assert.ok(AREA_IDS.every((id) => blank[id] === null));
  assert.equal(averageRating(blank), null);
  const zero = withRating(blank, 'health', 0);
  assert.equal(zero.health, 0); assert.equal(answeredCount(zero), 1); assert.equal(averageRating(zero), 0, 'a real zero counts');
  assert.equal(averageRating(withRating(zero, 'equals', 10)), 5);
  assert.equal(withRating(zero, 'health', undefined).health, null, 'clearing returns to unanswered, never 0');
  for (const bad of [-1, 11, 3.5, '7', NaN, Infinity]) assert.equal(withRating(blank, 'equals', bad).equals, null);
  assert.throws(() => withRating(blank, 'sleep', 5), /Unknown area/);
  assert.equal(averageRating(Object.fromEntries(AREA_IDS.map((id, index) => [id, [7, 8, 6, 10, 5, 7][index]]))), 7.2);
});

test('7. months: validation, navigation across year ends, labels', () => {
  assert.ok(isValidMonth('2026-10')); for (const bad of ['2026-1', '2026-13', '2026-00', '26-10', '', 5]) assert.equal(isValidMonth(bad), false);
  assert.equal(shiftMonth('2026-01', -1), '2025-12'); assert.equal(shiftMonth('2025-12', 1), '2026-01'); assert.equal(shiftMonth('2026-10', -13), '2025-09');
  assert.equal(monthLabel('2026-10'), 'October 2026'); assert.equal(currentMonth(new Date(2026, 9, 31)), '2026-10');
});

test('written answers use the private-content id scheme, one slot per month and field', () => {
  assert.equal(refIdFor('2026-10', textFieldFor('prompt', 'family')), '2026-10:prompt:family');
  assert.equal(draftSlotFor('2026-10', 'area:equals'), `${SADACHARA_KIND}:2026-10:area:equals`);
  assert.equal(new Set(ALL_TEXT_FIELDS.map((field) => draftSlotFor('2026-10', field))).size, 10);
});

test('3. a written answer is stored only as ciphertext bound to its month and field', async () => {
  const dek = await generateDek(); const refId = refIdFor('2026-10', 'prompt:struggles');
  const payload = await encryptText(dek, SECRET, SADACHARA_KIND, refId);
  assert.equal(JSON.stringify(payload).includes('TESTSECRET'), false);
  assert.equal(await decryptText(dek, payload, SADACHARA_KIND, refId), SECRET);
  await assert.rejects(decryptText(dek, payload, SADACHARA_KIND, refIdFor('2026-11', 'prompt:struggles')), 'cannot be moved to another month');
  await assert.rejects(decryptText(dek, payload, SADACHARA_KIND, refIdFor('2026-10', 'prompt:family')), 'cannot be moved to another field');
  await assert.rejects(decryptText(dek, payload, 'reflection', refId), 'cannot be read as a Daily Reflection');
});

test('6. the share report cannot contain written text and includes nothing until sections are chosen', () => {
  const ratings = withRating(withRating(blankRatings(), 'equals', 7), 'health', 0);
  const none = buildShareReport('2026-10', ratings, []);
  assert.equal(none, 'Sādācāra summary: October 2026');
  const scores = buildShareReport('2026-10', ratings, ['scores']);
  assert.match(scores, /Relationship with Equals: 7\/10/); assert.match(scores, /Health: 0\/10/); assert.match(scores, /Relationship with Seniors: not answered/);
  assert.doesNotMatch(scores, /average/i);
  const average = buildShareReport('2026-10', ratings, ['average']);
  assert.match(average, /Overall average: 3\.5\/10 \(answered areas only\)/); assert.doesNotMatch(average, /Relationship with/);
  assert.match(buildShareReport('2026-10', blankRatings(), ['scores', 'average']), /not available/);
  assert.equal(buildShareReport.length, 3, 'only month, ratings and sections go in');
  for (const text of [scores, average, none]) assert.doesNotMatch(text, /TESTSECRET|struggle|famil|relatives|support or guidance|improve/i);
});

function baseStores(): BackupStores {
  return {
    sessions: [], offerings: [], sadhana: [], encryptionMeta: [], privateContent: [], seasonalVows: [], vowLogs: [],
    sadacharaAssessments: [buildAssessment('2026-10', withRating(blankRatings(), 'equals', 0), undefined, '2026-10-20T08:00:00.000Z') as unknown as Record<string, unknown>],
  };
}
async function encryptedStores(): Promise<BackupStores> {
  const base = baseStores(); const dek = await generateDek(); const kdf = newKdfParams(100_000);
  base.encryptionMeta = [{ id: 'diary', formatVersion: 1, state: 'enabled', lockTimeoutMinutes: 5, kdf, passphraseWrap: await wrapDekWithPassphrase(dek, 'twelve chars minimum', kdf), recoveryWrap: await wrapDekWithRecovery(dek, generateRecoverySecret()), createdAt: 'a', updatedAt: 'a' }];
  const refId = refIdFor('2026-10', 'prompt:family');
  base.privateContent = [{ id: `${SADACHARA_KIND}:${refId}`, kind: SADACHARA_KIND, refId, ...(await encryptText(dek, SECRET, SADACHARA_KIND, refId)), updatedAt: 'a', rev: 1 }];
  return base;
}
const fileOf = async (data: BackupStores) => JSON.parse(serializeBackup(await buildBackup(data, 6))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- tests corrupt arbitrary fields

test('8. format 3 backups carry assessments and encrypted answers, never readable text, and round-trip exactly', async () => {
  assert.equal(BACKUP_FORMAT_VERSION, 3);
  const data = await encryptedStores();
  const backup = await buildBackup(data, 6);
  assert.equal(backup.counts.sadacharaAssessments, 1); assert.equal(backup.counts.privateContent, 1);
  const text = serializeBackup(backup);
  assert.equal(text.includes('TESTSECRET'), false, 'the written answer is ciphertext in the file');
  const result = await validateBackup(JSON.parse(text));
  assert.ok(result.ok);
  if (result.ok) { assert.deepEqual(differingStores(result.backup.stores, data), []); assert.deepEqual(result.warnings, []); }
});

test('8. older backups (format 1 and 2) are still accepted with empty Sādācāra data and a plain warning', async () => {
  const data = await encryptedStores();
  for (const [format, names] of [[1, V1_STORE_NAMES], [2, V2_STORE_NAMES]] as const) {
    const subset = Object.fromEntries(names.map((name) => [name, name === 'privateContent' || name === 'encryptionMeta' ? data[name] : []])) as unknown as BackupStores;
    const file = { app: 'sadhana-devotional-companion', backupFormat: format, dbSchemaVersion: 5, exportedAt: 'x', diaryState: 'enabled', containsPlaintextReflections: false, counts: Object.fromEntries(names.map((name) => [name, subset[name].length])), checksum: await checksumStores(subset), stores: subset };
    const result = await validateBackup(JSON.parse(JSON.stringify(file)));
    assert.ok(result.ok, `format ${format}`);
    if (result.ok) {
      assert.deepEqual(result.backup.stores.sadacharaAssessments, []); assert.equal(result.backup.backupFormat, 3);
      assert.deepEqual(Object.keys(result.backup.stores).sort(), [...STORE_NAMES].sort());
      assert.equal(result.backup.checksum, await checksumStores(result.backup.stores));
      assert.ok(result.warnings.some((warning) => /before .*Sādācāra existed/.test(warning)));
    }
  }
});

test('8. damaged Sādācāra records are rejected without echoing any text', async () => {
  const bad = async (mutate: (file: Record<string, any>) => void) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const file = await fileOf(await encryptedStores()); mutate(file); file.checksum = await checksumStores(file.stores);
    const result = await validateBackup(file); return result.ok ? [] : result.errors;
  };
  const cases: [string, (file: Record<string, any>) => void, RegExp][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ['rating out of range', (f) => { f.stores.sadacharaAssessments[0].ratings.equals = 11; }, /invalid rating/],
    ['rating as text', (f) => { f.stores.sadacharaAssessments[0].ratings.equals = '7'; }, /invalid rating/],
    ['missing area', (f) => { delete f.stores.sadacharaAssessments[0].ratings.health; }, /unexpected areas/],
    ['extra area (sleep)', (f) => { f.stores.sadacharaAssessments[0].ratings.sleep = 5; }, /unexpected areas/],
    ['id and month disagree', (f) => { f.stores.sadacharaAssessments[0].month = '2026-09'; }, /invalid month/],
    ['bad month', (f) => { f.stores.sadacharaAssessments[0].id = '2026-13'; f.stores.sadacharaAssessments[0].month = '2026-13'; }, /invalid month/],
    ['wrong status', (f) => { f.stores.sadacharaAssessments[0].status = 'complete'; }, /inconsistent status/],
    ['missing store', (f) => { delete f.stores.sadacharaAssessments; }, /missing the sadacharaAssessments/],
  ];
  for (const [label, mutate, pattern] of cases) { const errors = await bad(mutate); assert.ok(errors.some((e) => pattern.test(e)), `${label}: ${errors.join(' | ')}`); assert.doesNotMatch(errors.join(' '), /TESTSECRET/); }
  const dup = await fileOf(await encryptedStores()); dup.stores.sadacharaAssessments.push({ ...dup.stores.sadacharaAssessments[0] }); dup.counts.sadacharaAssessments = 2; dup.checksum = await checksumStores(dup.stores);
  const result = await validateBackup(dup); assert.equal(result.ok, false, 'two records for one month are refused'); if (!result.ok) assert.ok(result.errors.some((e) => /repeats id/.test(e)));
  assert.deepEqual(validateAssessmentRecord(baseStores().sadacharaAssessments[0]), []);
});

test('9. a backup made before Sādācāra keeps encryption records byte-for-byte when Sādācāra data is added', async () => {
  const withData = await encryptedStores(); const without = { ...withData, sadacharaAssessments: [] };
  const a = await buildBackup(withData, 6); const b = await buildBackup(without, 6);
  assert.equal(JSON.stringify(a.stores.encryptionMeta), JSON.stringify(b.stores.encryptionMeta));
  assert.equal(JSON.stringify(a.stores.privateContent), JSON.stringify(b.stores.privateContent));
});
