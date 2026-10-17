import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOSED_DAY_CUTOFF_NOTE, createVow, editVow, japaDayContext, transitionVow, type SeasonalVow, type TargetSnapshot, type VowInput } from '../src/lib/seasonal.ts';
import { japaConflictMessage, todayJapaText } from '../src/lib/seasonalView.ts';

const TODAY = '2026-10-17';
const ctx = () => ({ today: TODAY, now: '2026-10-01T08:00:00.000Z' });
let counter = 0;
function japa(start: string, end: string, rounds: number, cutoff?: string, status: SeasonalVow['status'] = 'active', name = 'Extra Japa', created = '2026-10-01T08:00:00.000Z'): SeasonalVow {
  counter += 1;
  const input: VowInput = { type: 'japa', seasonName: 'Season', name, startDate: start, endDate: end, config: cutoff ? { targetRounds: rounds, morningCutoff: cutoff } : { targetRounds: rounds } };
  return { ...createVow(`t${counter}`, input, ctx()), status, createdAt: created };
}
/** Exactly how the Today screen asks: an open day (date === today), the row's regular target only, no snapshot. */
const today = (vows: SeasonalVow[], regular = 16, hasRow = true) => {
  const context = japaDayContext(hasRow ? { date: TODAY, targetRounds: regular } : null, TODAY, TODAY, regular, vows);
  return { context, text: todayJapaText(context) };
};

test('1. Today without a seasonal commitment: the plain regular target and the 7:00 AM cutoff', () => {
  for (const vows of [[], [japa('2026-11-01', '2026-11-30', 25, '06:15')]]) {
    const { context, text } = today(vows);
    assert.deepEqual([text.badge, text.note, text.conflict, text.cutoffLabel], ['Target 16 rounds', null, null, '7:00 AM'], 'nothing seasonal is mentioned');
    assert.deepEqual([context.rounds, context.regularRounds, context.source], [16, 16, 'regular']);
  }
  assert.equal(today([], 14).text.badge, 'Target 14 rounds', 'the user’s own regular target, whatever it is');
  assert.equal(today([], 16, false).text.badge, 'Target 16 rounds', 'an unrecorded day has no row yet and reads the same');
});

test('2. Today with an applicable seasonal target and cutoff: both shown, the regular target kept distinct and unchanged', () => {
  const { context, text } = today([japa('2026-10-10', '2026-10-31', 25, '06:15', 'active', 'Kārtika vows')]);
  assert.equal(text.badge, 'Saṅkalpa target 25 rounds');
  assert.equal(text.note, 'Set by your Saṅkalpa, “Kārtika vows”. Your regular target of 16 rounds is unchanged.');
  assert.deepEqual([text.cutoffLabel, text.conflict, context.regularRounds, context.rounds], ['6:15 AM', null, 16, 25]);
  assert.equal(today([japa('2026-10-10', '2026-10-31', 25)]).text.cutoffLabel, '7:00 AM', 'a commitment with no cutoff keeps the default');
  for (const day of ['2026-10-17']) assert.equal(japaDayContext(null, day, TODAY, 16, [japa('2026-10-17', '2026-10-17', 25, '06:15')]).rounds, 25, 'first and last date are inclusive');
  assert.equal(japaDayContext(null, TODAY, TODAY, 16, [japa('2026-10-10', '2026-10-16', 25, '06:15')]).rounds, 16, 'the day after the end date is regular');
});

test('3. a conflict falls back to the regular target and default cutoff, with a clear message and no commitment chosen', () => {
  const a = japa('2026-10-10', '2026-10-31', 20, '06:30', 'active', 'Alpha');
  const b = japa('2026-10-15', '2026-10-20', 24, '05:30', 'active', 'Beta', '2026-10-02T08:00:00.000Z');
  const { context, text } = today([a, b]);
  assert.deepEqual([text.badge, text.note, text.cutoffLabel], ['Target 16 rounds', null, '7:00 AM']);
  assert.match(String(text.conflict), /different targets \((20 and 24|24 and 20) rounds\)/);
  assert.match(String(text.conflict), /your regular target of 16 rounds is used/);
  assert.doesNotMatch(String(text.conflict), /Alpha|Beta/, 'neither is presented as the answer');
  assert.deepEqual([context.vowName, context.rounds, context.source], [undefined, 16, 'regular']);
  const sadhana = japaConflictMessage(context, 'sadhana'); const onToday = japaConflictMessage(context, 'today');
  assert.equal(sadhana.replace(/ Open Seasonal.*$/, ''), onToday.replace(/ Open Seasonal.*$/, ''), 'one shared wording for the explanation');
  assert.match(sadhana, /from Today to pause or change one\.$/); assert.match(onToday, /below to pause or change one\.$/);
});

test('4. a paused, completed, archived, draft or expired commitment no longer applies; resuming restores it', () => {
  for (const status of ['paused', 'completed', 'archived', 'draft'] as const) assert.equal(today([japa('2026-10-10', '2026-10-31', 25, '06:15', status)]).text.badge, 'Target 16 rounds', status);
  const active = japa('2026-10-10', '2026-10-31', 25, '06:15');
  const paused = transitionVow(active, 'pause', [active], ctx());
  assert.equal(today([paused]).text.note, null);
  const resumed = transitionVow(paused, 'resume', [paused], ctx());
  assert.deepEqual([today([resumed]).text.badge, today([resumed]).text.cutoffLabel], ['Saṅkalpa target 25 rounds', '6:15 AM']);
  const completed = transitionVow(resumed, 'complete', [resumed], ctx());
  assert.equal(completed.endedOn, TODAY);
  assert.equal(today([{ ...completed, endedOn: '2026-10-16' }]).text.badge, 'Target 16 rounds', 'a commitment completed yesterday does not reach today');
  assert.equal(today([japa('2026-09-01', '2026-10-16', 25, '06:15')]).text.badge, 'Target 16 rounds', 'a commitment whose dates have passed does not apply');
  const edited = editVow(active, { config: { targetRounds: 30, morningCutoff: '05:00' } }, [active], ctx());
  assert.deepEqual([today([edited]).text.badge, today([edited]).text.cutoffLabel], ['Saṅkalpa target 30 rounds', '5:00 AM'], 'today follows an edit live');
});

test('5. Today always uses the live rule: a stale stored snapshot cannot override it', () => {
  const stale: TargetSnapshot = { rounds: 20, source: 'seasonal', vowId: 'gone', vowName: 'Old', morningCutoff: '06:30' };
  const result = japaDayContext({ date: TODAY, targetRounds: 16, targetSnapshot: stale }, TODAY, TODAY, 16, []);
  assert.deepEqual([result.rounds, result.source, result.morningCutoff, result.cutoffNote], [16, 'regular', '07:00', null]);
});

test('6-7. the historical cases Today cannot display stay correct in the shared helper it relies on', () => {
  const vow = japa('2026-10-01', '2026-10-31', 20, '06:30');
  const past = '2026-10-12';
  const older: TargetSnapshot = { rounds: 20, source: 'seasonal', vowId: vow.id, vowName: 'Extra Japa' }; // saved before cutoffs were stored
  const legacy = japaDayContext({ date: past, targetRounds: 16, targetSnapshot: older }, past, TODAY, 16, [vow]);
  assert.deepEqual([legacy.rounds, legacy.morningCutoff, legacy.cutoffNote], [20, '07:00', CLOSED_DAY_CUTOFF_NOTE], 'an older recorded day: stored target, 7:00 AM fallback and the explanatory note');
  const recorded = japaDayContext({ date: past, targetRounds: 16, targetSnapshot: { ...older, morningCutoff: '05:15' } }, past, TODAY, 16, [vow]);
  assert.deepEqual([recorded.morningCutoff, recorded.cutoffNote], ['05:15', null], 'a recorded day keeps its own stored cutoff');
  const unrecorded = japaDayContext(null, past, TODAY, 16, [vow]);
  assert.deepEqual([unrecorded.rounds, unrecorded.morningCutoff, unrecorded.cutoffNote], [20, '06:30', null], 'an unrecorded past day: live target and cutoff, never the note');
  assert.equal('cutoffNote' in todayJapaText(unrecorded), false, 'the Today wording has no place for that note: it only ever shows an open day');
});

test('8. the Today wording never mentions private data and never produces a seasonal write', () => {
  const { text } = today([japa('2026-10-10', '2026-10-31', 25, '06:15')]);
  assert.deepEqual(Object.keys(text).sort(), ['badge', 'conflict', 'cutoffLabel', 'note'], 'only display strings; no records, no snapshots');
  assert.doesNotMatch(JSON.stringify(text), /reflection|diary|passphrase/i);
});
