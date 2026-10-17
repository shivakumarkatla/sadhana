import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOSED_DAY_CUTOFF_NOTE, DEFAULT_MORNING_CUTOFF, createVow, editVow, effectiveTargetFor, isClockTime, japaDayContext, resolveJapaCutoff, resolveJapaTarget, targetSnapshotForSave, transitionVow,
  type SeasonalVow, type TargetSnapshot, type VowInput,
} from '../src/lib/seasonal.ts';
import { buildBackup, serializeBackup, validateBackup, type BackupStores } from '../src/lib/backupFormat.ts';

const NOW = '2026-10-01T08:00:00.000Z';
const ctx = (today: string) => ({ today, now: NOW });
let counter = 0;
function japa(start: string, end: string, rounds: number, cutoff?: string, status: SeasonalVow['status'] = 'active', name = 'Extra Japa'): SeasonalVow {
  counter += 1;
  const input: VowInput = { type: 'japa', seasonName: 'Season', name, startDate: start, endDate: end, config: cutoff === undefined ? { targetRounds: rounds } : { targetRounds: rounds, morningCutoff: cutoff } };
  return { ...createVow(`vow-${counter}`, input, ctx('2026-10-01')), status };
}

/** The same chain saveSadhanaForDate runs: resolve the target, resolve its cutoff, build the snapshot. */
function saved(args: { vows: SeasonalVow[]; date: string; today: string; regular?: number; existing?: TargetSnapshot; isNewRow?: boolean }): TargetSnapshot | undefined {
  const regular = args.regular ?? 16;
  const resolution = resolveJapaTarget(args.date, regular, args.vows);
  return targetSnapshotForSave({ existing: args.existing, isNewRow: args.isNewRow ?? args.existing === undefined, date: args.date, today: args.today, regularTarget: regular, resolution, cutoff: resolveJapaCutoff(resolution, args.vows) });
}
const row = (date: string, targetSnapshot?: TargetSnapshot, targetRounds = 16) => ({ date, targetRounds, ...(targetSnapshot ? { targetSnapshot } : {}) });
const dayOf = (record: ReturnType<typeof row> | null, date: string, today: string, vows: SeasonalVow[], regular = 16) => japaDayContext(record, date, today, regular, vows);

const OPEN = '2026-10-16';   // the day being recorded
const LATER = '2026-10-18';  // by then OPEN has closed

test('1. a new snapshot stores the applicable target and the applicable cutoff', () => {
  const vow = japa('2026-10-10', '2026-10-31', 20, '06:30');
  assert.deepEqual(saved({ vows: [vow], date: OPEN, today: OPEN }), { rounds: 20, source: 'seasonal', vowId: vow.id, vowName: 'Extra Japa', morningCutoff: '06:30' });
  assert.deepEqual(saved({ vows: [vow], date: '2026-10-20', today: OPEN }), { rounds: 20, source: 'seasonal', vowId: vow.id, vowName: 'Extra Japa', morningCutoff: '06:30' }, 'a future day uses the live rule');
  assert.equal(saved({ vows: [japa('2026-10-10', '2026-10-31', 20)], date: OPEN, today: OPEN })?.morningCutoff, DEFAULT_MORNING_CUTOFF, 'a commitment with no cutoff stores the 7:00 default');
  assert.deepEqual(saved({ vows: [vow], date: '2026-11-05', today: '2026-11-05', regular: 14 }), { rounds: 14, source: 'regular', morningCutoff: '07:00' }, 'outside the season: the regular target and the default cutoff');
  assert.deepEqual(saved({ vows: [], date: OPEN, today: OPEN }), { rounds: 16, source: 'regular', morningCutoff: '07:00' });
});

test('1b. conflicting active commitments and unusable cutoffs fall back to the regular target and the default cutoff', () => {
  const a = japa('2026-10-10', '2026-10-31', 20, '06:30', 'active', 'A'); const b = japa('2026-10-10', '2026-10-31', 24, '05:15', 'active', 'B');
  assert.deepEqual(saved({ vows: [a, b], date: OPEN, today: OPEN }), { rounds: 16, source: 'regular', morningCutoff: '07:00' }, 'no cutoff is picked from either side of a conflict');
  const tampered = japa('2026-10-10', '2026-10-31', 20, '06:30'); (tampered.config as Record<string, unknown>).morningCutoff = '25:99';
  assert.equal(resolveJapaCutoff(resolveJapaTarget(OPEN, 16, [tampered]), [tampered]), '07:00', 'an unreadable stored cutoff resolves to the default');
  assert.equal(resolveJapaCutoff({ source: 'seasonal', rounds: 20, vowId: 'gone', vowName: 'x' }, []), '07:00', 'a commitment that cannot be found resolves to the default');
  assert.equal(resolveJapaCutoff(resolveJapaTarget(OPEN, 16, [japa('2026-10-10', '2026-10-31', 20, '06:30', 'paused')]), []), '07:00');
});

test('1c. a caller that supplies no cutoff, or an unreadable one, never produces an unreadable snapshot', () => {
  const vow = japa('2026-10-10', '2026-10-31', 20, '06:30');
  const resolution = resolveJapaTarget(OPEN, 16, [vow]);
  const without = targetSnapshotForSave({ isNewRow: true, date: OPEN, today: OPEN, regularTarget: 16, resolution });
  assert.equal('morningCutoff' in (without as object), false, 'no cutoff supplied: none stored (the pre-existing shape)');
  for (const bad of ['', '7:00', '24:00', '06:30pm', 'noon']) assert.equal(targetSnapshotForSave({ isNewRow: true, date: OPEN, today: OPEN, regularTarget: 16, resolution, cutoff: bad })?.morningCutoff, '07:00', `"${bad}"`);
});

test('2. a closed day keeps the cutoff it was recorded with after the commitment is edited', () => {
  let vow = japa('2026-10-10', '2026-10-31', 20, '06:30');
  const recorded = saved({ vows: [vow], date: OPEN, today: OPEN })!; // saved while the day was open
  assert.equal(recorded.morningCutoff, '06:30');
  vow = editVow(vow, { config: { targetRounds: 30, morningCutoff: '05:00' } }, [vow], ctx(LATER));
  const closed = dayOf(row(OPEN, recorded), OPEN, LATER, [vow]);
  assert.deepEqual([closed.rounds, closed.source, closed.vowName, closed.morningCutoff, closed.cutoffSource, closed.cutoffNote], [20, 'seasonal', 'Extra Japa', '06:30', 'seasonal', null]);
  assert.equal(saved({ vows: [vow], date: OPEN, today: LATER, existing: recorded }), recorded, 'saving the closed day again returns the stored snapshot unchanged');
  assert.deepEqual(effectiveTargetFor(row(OPEN, recorded), OPEN, LATER, 16, [vow]).morningCutoff, '06:30');
});

test('3. pausing, resuming, completing, archiving or deleting a commitment never changes a closed day', () => {
  let vow = japa('2026-10-10', '2026-10-31', 20, '06:30');
  const recorded = saved({ vows: [vow], date: OPEN, today: OPEN })!;
  const closedRow = row(OPEN, recorded);
  const view = (vows: SeasonalVow[]) => JSON.stringify(dayOf(closedRow, OPEN, LATER, vows));
  const before = view([vow]);
  vow = editVow(vow, { config: { targetRounds: 22, morningCutoff: '04:45' } }, [vow], ctx(LATER)); assert.equal(view([vow]), before, 'edited');
  for (const action of ['pause', 'resume', 'complete', 'archive'] as const) { vow = transitionVow(vow, action, [vow], ctx(LATER)); assert.equal(view([vow]), before, action); }
  assert.equal(view([]), before, 'deleted (no commitment left at all)');
  assert.deepEqual(recorded, { rounds: 20, source: 'seasonal', vowId: recorded.vowId, vowName: 'Extra Japa', morningCutoff: '06:30' }, 'and the snapshot itself was never mutated');
});

test('4. older snapshots without a cutoff keep the safe 7:00 AM fallback and are never rewritten to add one', () => {
  const vow = japa('2026-10-10', '2026-10-31', 20, '06:30');
  const oldSeasonal: TargetSnapshot = { rounds: 20, source: 'seasonal', vowId: vow.id, vowName: 'Extra Japa' };
  const closed = dayOf(row(OPEN, oldSeasonal), OPEN, LATER, [vow]);
  assert.deepEqual([closed.rounds, closed.morningCutoff, closed.cutoffSource, closed.cutoffNote], [20, '07:00', 'default', CLOSED_DAY_CUTOFF_NOTE], 'the live 06:30 is not borrowed for a day recorded before cutoffs were stored');
  const oldRegular: TargetSnapshot = { rounds: 16, source: 'regular' };
  assert.deepEqual([dayOf(row(OPEN, oldRegular), OPEN, LATER, [vow]).morningCutoff, dayOf(row(OPEN, oldRegular), OPEN, LATER, [vow]).cutoffNote], ['07:00', null], 'no seasonal commitment was involved, so no note');
  assert.deepEqual([dayOf(row(OPEN), OPEN, LATER, [vow]).source, dayOf(row(OPEN), OPEN, LATER, [vow]).morningCutoff], ['regular-unrecorded', '07:00'], 'a closed row with no snapshot at all');
  const resaved = saved({ vows: [vow], date: OPEN, today: LATER, existing: oldSeasonal });
  assert.equal(resaved, oldSeasonal, 'saving a closed day returns the very same older snapshot');
  assert.equal('morningCutoff' in (resaved as object), false, 'and no cutoff was added to it');
  assert.equal(saved({ vows: [vow], date: OPEN, today: LATER, isNewRow: false }), undefined, 'a closed row saved before snapshots existed stays without one');
  assert.equal(saved({ vows: [vow], date: OPEN, today: OPEN, existing: oldSeasonal })?.morningCutoff, '06:30', 'only a still-open day is refreshed (which it always was), and then it does gain the cutoff');
});

test('5. unreadable cutoff values are treated as missing: the default is shown and nothing throws', () => {
  const vow = japa('2026-10-10', '2026-10-31', 20, '06:30');
  const bad: unknown[] = ['', ' 06:30', '6:30', '06:3', '06:30:00', '24:00', '23:60', '-1:00', 'noon', '06:30 AM', null, 630, 6.5, true, {}, [], ['06:30']];
  for (const value of bad) {
    const seasonal = { rounds: 20, source: 'seasonal', vowId: vow.id, vowName: 'Extra Japa', morningCutoff: value } as unknown as TargetSnapshot;
    const context = dayOf(row(OPEN, seasonal), OPEN, LATER, [vow]);
    assert.deepEqual([context.rounds, context.morningCutoff, context.cutoffSource, context.cutoffNote], [20, '07:00', 'default', CLOSED_DAY_CUTOFF_NOTE], JSON.stringify(value));
    const regular = { rounds: 16, source: 'regular', morningCutoff: value } as unknown as TargetSnapshot;
    const regularContext = dayOf(row(OPEN, regular), OPEN, LATER, []);
    assert.deepEqual([regularContext.morningCutoff, regularContext.cutoffNote], ['07:00', null], JSON.stringify(value));
  }
  for (const good of ['00:00', '06:30', '07:00', '12:05', '23:59']) assert.equal(isClockTime(good), true, good);
});

test('6. today and future days still follow the live rule, whatever a snapshot says', () => {
  let vow = japa('2026-10-10', '2026-10-31', 20, '06:30');
  const recorded = saved({ vows: [vow], date: OPEN, today: OPEN })!;
  vow = editVow(vow, { config: { targetRounds: 30, morningCutoff: '05:00' } }, [vow], ctx(OPEN));
  const today = dayOf(row(OPEN, recorded), OPEN, OPEN, [vow]);
  assert.deepEqual([today.rounds, today.morningCutoff, today.cutoffSource, today.cutoffNote], [30, '05:00', 'seasonal', null], 'today follows the edit, not its older snapshot');
  const future = dayOf(null, '2026-10-22', OPEN, [vow]);
  assert.deepEqual([future.rounds, future.morningCutoff, future.cutoffNote], [30, '05:00', null]);
  const futureWithRow = dayOf(row('2026-10-22', { rounds: 20, source: 'seasonal', vowId: vow.id, vowName: 'x', morningCutoff: '06:30' }), '2026-10-22', OPEN, [vow]);
  assert.deepEqual([futureWithRow.rounds, futureWithRow.morningCutoff], [30, '05:00'], 'a future row with a stale snapshot still follows the live rule');
  const paused = transitionVow(vow, 'pause', [vow], ctx(OPEN));
  assert.deepEqual([dayOf(row(OPEN, recorded), OPEN, OPEN, [paused]).rounds, dayOf(row(OPEN, recorded), OPEN, OPEN, [paused]).morningCutoff], [16, '07:00'], 'a paused commitment no longer applies today');
  assert.equal(dayOf(row(OPEN, recorded), OPEN, OPEN, []).morningCutoff, '07:00', 'and none left means the default');
  assert.equal(dayOf(null, '2026-11-02', OPEN, [vow]).morningCutoff, '07:00', 'after the season ends the default returns');
});

test('7. legacy backups still restore: a missing cutoff is accepted silently, a readable one round-trips, an unreadable one only warns', async () => {
  const base = (snapshot?: unknown): BackupStores => ({
    sessions: [], offerings: [], encryptionMeta: [], privateContent: [], seasonalVows: [], vowLogs: [], sadacharaAssessments: [],
    sadhana: [{ id: 1, date: '2026-10-15', rounds: 16, targetRounds: 16, earlyRounds: 4, sixteenthRoundTime: '', wakeUp: '', bedtime: '', sleepOnset: '', mangalaArati: 'Unrecorded', reflection: '', ...(snapshot === undefined ? {} : { targetSnapshot: snapshot }) }],
  });
  const fileOf = async (stores: BackupStores) => JSON.parse(serializeBackup(await buildBackup(stores, 5))) as Record<string, unknown>;
  const legacy = await validateBackup(await fileOf(base({ rounds: 20, source: 'seasonal', vowId: 'v', vowName: 'Old season' })));
  assert.equal(legacy.ok, true); assert.deepEqual(legacy.ok ? legacy.warnings.filter((w) => /cutoff/i.test(w)) : ['?'], [], 'a snapshot without a cutoff is valid and silent');
  assert.equal((await validateBackup(await fileOf(base()))).ok, true, 'and so is a record with no snapshot at all');
  const modern = base({ rounds: 20, source: 'seasonal', vowId: 'v', vowName: 'New', morningCutoff: '06:30' });
  const modernResult = await validateBackup(await fileOf(modern));
  assert.equal(modernResult.ok, true);
  if (modernResult.ok) { assert.deepEqual(modernResult.warnings.filter((w) => /cutoff/i.test(w)), []); assert.deepEqual(modernResult.backup.stores.sadhana, modern.sadhana, 'the cutoff round-trips exactly'); }
  for (const value of ['25:00', 630, null, '']) {
    const result = await validateBackup(await fileOf(base({ rounds: 20, source: 'seasonal', vowId: 'v', vowName: 'x', morningCutoff: value })));
    assert.equal(result.ok, true, `${JSON.stringify(value)}: the file is still accepted`);
    if (result.ok) { const messages = result.warnings.filter((w) => /morning cutoff/i.test(w)); assert.equal(messages.length, 1); assert.equal(messages[0].includes('25:00'), false, 'the value is not echoed'); assert.match(messages[0], /2026-10-15/); }
  }
  const broken = await validateBackup(await fileOf(base({ rounds: 'many', source: 'seasonal' })));
  assert.equal(broken.ok, false, 'a genuinely malformed snapshot is still rejected');
});

test('8. the regular targetRounds is never touched, and a recorded day still reports it separately', () => {
  const vow = japa('2026-10-10', '2026-10-31', 20, '06:30');
  const frozen = JSON.stringify(vow);
  const snapshot = saved({ vows: [vow], date: OPEN, today: OPEN, regular: 14 })!;
  assert.equal(snapshot.rounds, 20, 'the seasonal target lives in the snapshot');
  assert.equal(JSON.stringify(vow), frozen, 'resolving and saving never mutate the commitment');
  const closed = dayOf(row(OPEN, snapshot, 14), OPEN, LATER, [vow], 14);
  assert.deepEqual([closed.rounds, closed.regularRounds, closed.morningCutoff], [20, 14, '06:30'], 'the regular target is reported unchanged next to the recorded one');
  assert.deepEqual(saved({ vows: [], date: OPEN, today: OPEN, regular: 14 }), { rounds: 14, source: 'regular', morningCutoff: '07:00' }, 'on a regular day the snapshot repeats the regular target');
  assert.equal(Object.keys(snapshot).includes('targetRounds'), false, 'a snapshot never carries or replaces targetRounds');
});
