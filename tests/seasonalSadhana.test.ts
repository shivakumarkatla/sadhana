import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSED_DAY_CUTOFF_NOTE, createVow, editVow, japaDayContext, transitionVow, type SeasonalVow, type TargetSnapshot, type VowInput } from '../src/lib/seasonal.ts';

const TODAY = '2026-10-16';
const ctx = (today = TODAY) => ({ today, now: '2026-10-01T08:00:00.000Z' });
let counter = 0;
function japa(start: string, end: string, rounds: number, cutoff?: string, status: SeasonalVow['status'] = 'active', name = 'Extra Japa', created = '2026-10-01T08:00:00.000Z'): SeasonalVow {
  counter += 1;
  const input: VowInput = { type: 'japa', seasonName: 'Season', name, startDate: start, endDate: end, config: cutoff ? { targetRounds: rounds, morningCutoff: cutoff } : { targetRounds: rounds } };
  return { ...createVow(`v${counter}`, input, ctx()), status, createdAt: created };
}
const row = (date: string, extra: Partial<{ targetRounds: number; targetSnapshot: TargetSnapshot }> = {}) => ({ date, targetRounds: 16, ...extra });
const context = (date: string, vows: SeasonalVow[], record: ReturnType<typeof row> | null = null, regular = 16) => japaDayContext(record, date, TODAY, regular, vows);

test('1. no applicable commitment: the regular target and the 7:00 AM cutoff', () => {
  for (const vows of [[], [japa('2026-11-01', '2026-11-30', 20, '06:30')]]) {
    const result = context(TODAY, vows);
    assert.deepEqual([result.rounds, result.regularRounds, result.source, result.morningCutoff, result.cutoffSource, result.cutoffNote], [16, 16, 'regular', '07:00', 'default', null]);
    assert.equal(result.conflict, undefined); assert.equal(result.vowName, undefined);
  }
  assert.equal(context(TODAY, [], row(TODAY, { targetRounds: 12 })).rounds, 12, 'the day’s own regular target is used when no season applies');
});

test('2. an active seasonal Japa commitment: its target and its configured cutoff, today and on future days', () => {
  const vow = japa('2026-10-10', '2026-10-31', 20, '06:30');
  for (const date of [TODAY, '2026-10-17', '2026-10-31']) {
    const result = context(date, [vow]);
    assert.deepEqual([result.rounds, result.regularRounds, result.source, result.vowName, result.morningCutoff, result.cutoffSource, result.cutoffNote], [20, 16, 'seasonal', 'Extra Japa', '06:30', 'seasonal', null], date);
  }
  assert.equal(context(TODAY, [vow], row(TODAY)).regularRounds, 16, 'the regular target is reported separately and never replaced');
  assert.equal(context(TODAY, [vow], row(TODAY, { targetRounds: 14 })).regularRounds, 14);
});

test('2b. a commitment saved without a cutoff, or with an unusable one, safely uses 07:00', () => {
  for (const cutoff of [undefined, 'bad', '7am', '25:00', '']) {
    const vow = japa('2026-10-10', '2026-10-31', 20, undefined); (vow.config as Record<string, unknown>).morningCutoff = cutoff; if (cutoff === undefined) delete (vow.config as Record<string, unknown>).morningCutoff;
    const result = context(TODAY, [vow]);
    assert.deepEqual([result.rounds, result.source, result.morningCutoff, result.cutoffSource], [20, 'seasonal', '07:00', 'default'], String(cutoff));
  }
});

test('3. dates before and after the commitment: regular target and default cutoff; both end dates are inclusive', () => {
  const vow = japa('2026-10-20', '2026-10-25', 20, '06:30');
  const day = (date: string) => japaDayContext(null, date, '2026-10-01', 16, [vow]); // judged from a day before the season so every date is "open"
  assert.deepEqual([day('2026-10-19').source, day('2026-10-19').morningCutoff], ['regular', '07:00']);
  assert.deepEqual([day('2026-10-20').source, day('2026-10-20').morningCutoff], ['seasonal', '06:30'], 'first date');
  assert.deepEqual([day('2026-10-25').source, day('2026-10-25').morningCutoff], ['seasonal', '06:30'], 'last date');
  assert.deepEqual([day('2026-10-26').source, day('2026-10-26').morningCutoff], ['regular', '07:00']);
});

test('4. draft, paused, completed and archived commitments follow the lifecycle rules: regular target, default cutoff', () => {
  for (const status of ['draft', 'paused', 'completed', 'archived'] as const) {
    const result = context(TODAY, [japa('2026-10-10', '2026-10-31', 20, '06:30', status)]);
    assert.deepEqual([result.rounds, result.source, result.morningCutoff], [16, 'regular', '07:00'], status);
  }
  const active = japa('2026-10-10', '2026-10-31', 20, '06:30');
  const completed = transitionVow(active, 'complete', [active], ctx('2026-10-18'));
  assert.equal(completed.endedOn, '2026-10-18');
  assert.equal(context('2026-10-17', [completed]).source, 'regular', 'a completed commitment no longer applies');
  const paused = transitionVow(active, 'pause', [active], ctx());
  assert.equal(context(TODAY, [paused]).source, 'regular');
  assert.equal(context(TODAY, [transitionVow(paused, 'resume', [paused], ctx())]).morningCutoff, '06:30', 'resuming restores it');
});

test('5. conflicting active Japa commitments: the regular target, a clear conflict, and no arbitrary choice or cutoff', () => {
  const a = japa('2026-10-10', '2026-10-31', 20, '06:30', 'active', 'Alpha', '2026-10-01T08:00:00.000Z');
  const b = japa('2026-10-15', '2026-10-20', 24, '05:30', 'active', 'Beta', '2026-10-02T08:00:00.000Z');
  const result = context(TODAY, [a, b]);
  assert.deepEqual([result.rounds, result.source, result.morningCutoff, result.cutoffSource, result.vowName], [16, 'regular', '07:00', 'default', undefined]);
  assert.deepEqual(result.conflict?.targets.sort(), [20, 24]); assert.deepEqual(result.conflict?.vowIds.sort(), [a.id, b.id].sort());
  assert.equal(context('2026-10-21', [a, b]).source, 'seasonal', 'on an open day only one of them covers there is no conflict');
  assert.equal(context('2026-10-21', [a, b]).morningCutoff, '06:30');
  const same = japa('2026-10-15', '2026-10-20', 20, '05:30', 'active', 'Twin', '2026-10-03T08:00:00.000Z');
  assert.equal(context(TODAY, [a, same]).conflict, undefined, 'the same target is not a conflict');
  assert.equal(context(TODAY, [a, same]).vowName, 'Alpha', 'attributed to the earliest-created commitment, deterministically');
});

test('6. a recorded past day keeps the target it was recorded with, and its cutoff is the default (the cutoff is not saved with a day)', () => {
  const recorded: TargetSnapshot = { rounds: 20, source: 'seasonal', vowId: 'gone', vowName: 'Old season' };
  const result = context('2026-10-12', [], row('2026-10-12', { targetSnapshot: recorded }));
  assert.deepEqual([result.rounds, result.source, result.vowName], [20, 'seasonal', 'Old season'], 'even with no commitment left');
  assert.deepEqual([result.morningCutoff, result.cutoffSource, result.cutoffNote], ['07:00', 'default', CLOSED_DAY_CUTOFF_NOTE]);
  const live = japa('2026-10-01', '2026-10-31', 24, '05:45');
  const other = context('2026-10-12', [live], row('2026-10-12', { targetSnapshot: recorded }));
  assert.deepEqual([other.rounds, other.morningCutoff], [20, '07:00'], 'a different live commitment cannot rewrite the recorded day');
  assert.equal(context('2026-10-12', [], row('2026-10-12', { targetSnapshot: { rounds: 16, source: 'regular' } })).cutoffNote, null, 'no note when no seasonal commitment was involved');
});

test('7. editing, pausing, completing or archiving a commitment never changes a closed day, while today follows it', () => {
  const recorded: TargetSnapshot = { rounds: 20, source: 'seasonal', vowId: 'x', vowName: 'Extra Japa' };
  const closedRow = row('2026-10-12', { targetSnapshot: recorded });
  let vow = japa('2026-10-10', '2026-10-31', 20, '06:30');
  const snapshotOfClosed = () => JSON.stringify(context('2026-10-12', [vow], closedRow));
  const before = snapshotOfClosed();
  vow = editVow(vow, { config: { targetRounds: 30, morningCutoff: '05:00' } }, [vow], ctx());
  assert.equal(snapshotOfClosed(), before, 'edited');
  assert.deepEqual([context(TODAY, [vow]).rounds, context(TODAY, [vow]).morningCutoff], [30, '05:00'], 'today follows the edit');
  vow = transitionVow(vow, 'pause', [vow], ctx()); assert.equal(snapshotOfClosed(), before, 'paused'); assert.equal(context(TODAY, [vow]).rounds, 16);
  vow = transitionVow(vow, 'resume', [vow], ctx()); assert.equal(snapshotOfClosed(), before, 'resumed');
  vow = transitionVow(vow, 'complete', [vow], ctx()); assert.equal(snapshotOfClosed(), before, 'completed');
  vow = transitionVow(vow, 'archive', [vow], ctx()); assert.equal(snapshotOfClosed(), before, 'archived');
  assert.equal(context(TODAY, [vow]).source, 'regular');
});

test('7b. open days ignore a stale snapshot; closed rows saved before snapshots existed are never given a seasonal target or cutoff', () => {
  const stale: TargetSnapshot = { rounds: 20, source: 'seasonal', vowId: 'x', vowName: 'Extra Japa' };
  assert.equal(context(TODAY, [], row(TODAY, { targetSnapshot: stale })).rounds, 16, 'today with no commitment left: regular');
  const vow = japa('2026-10-01', '2026-10-31', 20, '06:30');
  const legacy = context('2026-10-12', [vow], row('2026-10-12'));
  assert.deepEqual([legacy.rounds, legacy.source, legacy.morningCutoff, legacy.cutoffNote], [16, 'regular-unrecorded', '07:00', null], 'a past row with no snapshot keeps the regular target it was saved with');
  const blankPast = context('2026-10-12', [vow], null);
  assert.deepEqual([blankPast.rounds, blankPast.source], [20, 'seasonal'], 'a past day with no row yet is filled in under the rule in force');
  assert.deepEqual([blankPast.morningCutoff, blankPast.cutoffSource, blankPast.cutoffNote], ['06:30', 'seasonal', null], 'and so is its cutoff: the live one, which is exactly what saving will store, with no "not saved" note because nothing has been saved');
});

test('7c. an older RECORDED day whose snapshot has no usable cutoff keeps the 7:00 AM fallback and the explanatory note, whatever the live commitment says', () => {
  const vow = japa('2026-10-01', '2026-10-31', 20, '06:30'); // the live commitment has a different cutoff; it must never leak into a recorded day
  const recordedWithoutCutoff: TargetSnapshot = { rounds: 20, source: 'seasonal', vowId: vow.id, vowName: 'Extra Japa' };
  for (const snapshot of [recordedWithoutCutoff, { ...recordedWithoutCutoff, morningCutoff: 'not-a-time' }, { ...recordedWithoutCutoff, morningCutoff: '' }]) {
    const result = context('2026-10-12', [vow], row('2026-10-12', { targetSnapshot: snapshot }));
    assert.deepEqual([result.rounds, result.source, result.morningCutoff, result.cutoffSource, result.cutoffNote], [20, 'seasonal', '07:00', 'default', CLOSED_DAY_CUTOFF_NOTE], JSON.stringify(snapshot.morningCutoff));
  }
  const recordedWithCutoff = context('2026-10-12', [vow], row('2026-10-12', { targetSnapshot: { ...recordedWithoutCutoff, morningCutoff: '05:15' } }));
  assert.deepEqual([recordedWithCutoff.morningCutoff, recordedWithCutoff.cutoffNote], ['05:15', null], 'a recorded day with a stored cutoff shows that one, not the live 06:30');
  const unrecorded = context('2026-10-12', [vow], null);
  assert.notEqual(unrecorded.cutoffNote, CLOSED_DAY_CUTOFF_NOTE, 'only recorded days ever get the note');
});
