import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVow, editVow, transitionVow, type SeasonalVow, type TargetSnapshot, type VowInput } from '../src/lib/seasonal.ts';
import { japaInsights, type InsightsJapaInput } from '../src/lib/seasonalView.ts';

const TODAY = '2026-10-17';
const ctx = () => ({ today: TODAY, now: '2026-10-01T08:00:00.000Z' });
let counter = 0;
function japa(start: string, end: string, rounds: number, cutoff?: string, status: SeasonalVow['status'] = 'active', name = 'Extra Japa', created = '2026-10-01T08:00:00.000Z'): SeasonalVow {
  counter += 1;
  const input: VowInput = { type: 'japa', seasonName: 'Season', name, startDate: start, endDate: end, config: cutoff ? { targetRounds: rounds, morningCutoff: cutoff } : { targetRounds: rounds } };
  return { ...createVow(`i${counter}`, input, ctx()), status, createdAt: created };
}
const snap = (rounds: number, cutoff?: string): TargetSnapshot => ({ rounds, source: 'seasonal', vowId: 'old', vowName: 'Old', ...(cutoff ? { morningCutoff: cutoff } : {}) });
const day = (date: string, rounds: number, extra: Partial<InsightsJapaInput> = {}): InsightsJapaInput => ({ date, rounds, earlyRounds: 4, targetRounds: 16, ...extra });

test('1. historical days are measured against their stored snapshot, never today’s active commitment', () => {
  const live = japa('2026-10-01', '2026-10-31', 30, '05:00'); // a different commitment is active now
  const result = japaInsights([day('2026-10-10', 18, { targetSnapshot: snap(20, '06:30') }), day('2026-10-11', 22, { targetSnapshot: snap(20, '06:30') }), day('2026-10-12', 16)], TODAY, [live]);
  assert.deepEqual(result.days.map((entry) => [entry.target, entry.source, entry.cutoff]), [[20, 'seasonal', '06:30'], [20, 'seasonal', '06:30'], [16, 'regular-unrecorded', '07:00']]);
  assert.equal(result.targetMet, 2, '22 met 20 and 16 met 16; 18 did NOT meet its recorded 20 even though it beats the regular 16');
  assert.deepEqual([result.targetMin, result.targetMax, result.targetVaries, result.targetLine], [16, 20, true, undefined]);
  assert.equal(result.seasonalDays, 2);
});

test('2. a seasonal target applies to the right dates only (today follows the live rule; the dates are inclusive)', () => {
  const vow = japa('2026-10-17', '2026-10-17', 20, '06:30'); // exactly today
  assert.deepEqual(japaInsights([day(TODAY, 12)], TODAY, [vow]).days[0], { date: TODAY, rounds: 12, earlyRounds: 4, target: 20, source: 'seasonal', cutoff: '06:30', olderSeasonalDay: false });
  assert.equal(japaInsights([day(TODAY, 12)], TODAY, [japa('2026-10-01', '2026-10-16', 20, '06:30')]).days[0].target, 16, 'the day after the end date: regular');
  assert.equal(japaInsights([day(TODAY, 12)], TODAY, [japa('2026-10-18', '2026-10-30', 20, '06:30')]).days[0].target, 16, 'before the start date: regular');
  for (const status of ['draft', 'paused', 'completed', 'archived'] as const) assert.equal(japaInsights([day(TODAY, 12)], TODAY, [japa('2026-10-01', '2026-10-31', 20, '06:30', status)]).days[0].target, 16, status);
  const reached = japaInsights([day(TODAY, 18)], TODAY, [japa('2026-10-01', '2026-10-31', 20, '06:30')]);
  assert.deepEqual([reached.targetMet, reached.targetLine, reached.cutoffLabel], [0, 20, '6:30 AM'], 'today is measured against the live seasonal target');
});

test('3. conflicting active commitments: the regular target, the conflict reported, no commitment chosen', () => {
  const a = japa('2026-10-10', '2026-10-31', 20, '06:30', 'active', 'Alpha');
  const b = japa('2026-10-15', '2026-10-20', 24, '05:30', 'active', 'Beta', '2026-10-02T08:00:00.000Z');
  const result = japaInsights([day(TODAY, 17)], TODAY, [a, b]);
  assert.deepEqual([result.days[0].target, result.days[0].source, result.days[0].cutoff, result.targetMet], [16, 'regular', '07:00', 1]);
  assert.deepEqual(result.conflict?.conflict?.targets.sort(), [20, 24]); assert.equal(result.conflict?.vowName, undefined);
  assert.equal(result.seasonalDays, 0);
  assert.equal(japaInsights([day('2026-10-12', 17, { targetSnapshot: snap(20, '06:30') })], TODAY, [a, b]).conflict, null, 'a closed day keeps its recorded snapshot, so a later conflict does not touch it');
});

test('4. historical cutoffs and targets never change when a commitment is edited, paused, completed, archived or removed', () => {
  const recorded = [day('2026-10-10', 18, { targetSnapshot: snap(20, '06:30') }), day('2026-10-11', 22, { targetSnapshot: snap(20, '06:30') })];
  let vow = japa('2026-10-01', '2026-10-31', 20, '06:30');
  const before = JSON.stringify(japaInsights(recorded, TODAY, [vow]));
  vow = editVow(vow, { config: { targetRounds: 30, morningCutoff: '05:00' } }, [vow], ctx()); assert.equal(JSON.stringify(japaInsights(recorded, TODAY, [vow])), before, 'edited');
  vow = transitionVow(vow, 'pause', [vow], ctx()); assert.equal(JSON.stringify(japaInsights(recorded, TODAY, [vow])), before, 'paused');
  vow = transitionVow(vow, 'resume', [vow], ctx()); vow = transitionVow(vow, 'complete', [vow], ctx()); assert.equal(JSON.stringify(japaInsights(recorded, TODAY, [vow])), before, 'completed');
  vow = transitionVow(vow, 'archive', [vow], ctx()); assert.equal(JSON.stringify(japaInsights(recorded, TODAY, [vow])), before, 'archived');
  assert.equal(JSON.stringify(japaInsights(recorded, TODAY, [])), before, 'deleted');
});

test('5. legacy recorded days keep the 7:00 AM fallback and are flagged for the explanatory note', () => {
  const noCutoff = day('2026-10-10', 17, { targetSnapshot: snap(20) });
  const unreadable = day('2026-10-11', 17, { targetSnapshot: snap(20, 'not-a-time') });
  const legacyRow = day('2026-10-12', 16); // saved before snapshots existed
  const result = japaInsights([noCutoff, unreadable, legacyRow], TODAY, [japa('2026-10-01', '2026-10-31', 20, '05:00')]);
  assert.deepEqual(result.days.map((entry) => [entry.target, entry.cutoff, entry.olderSeasonalDay]), [[20, '07:00', true], [20, '07:00', true], [16, '07:00', false]], 'the live 05:00 never leaks into a recorded day, and a legacy regular row needs no note');
  assert.equal(result.olderSeasonalDays, 2);
  assert.equal(result.cutoffLabel, '7:00 AM');
});

test('6. cutoffs are reported per day: one label when they agree, none when they differ', () => {
  const same = japaInsights([day('2026-10-10', 10, { targetSnapshot: snap(20, '06:30') }), day('2026-10-11', 10, { targetSnapshot: snap(20, '06:30') })], TODAY, []);
  assert.deepEqual([same.cutoffs, same.cutoffLabel, same.targetLine, same.targetVaries], [['06:30'], '6:30 AM', 20, false]);
  const mixed = japaInsights([day('2026-10-10', 10, { targetSnapshot: snap(20, '06:30') }), day('2026-10-11', 10, { targetSnapshot: { rounds: 16, source: 'regular', morningCutoff: '07:00' } })], TODAY, []);
  assert.deepEqual([mixed.cutoffs, mixed.cutoffLabel], [['06:30', '07:00'], null], 'no single wording is invented for days that used different cutoffs');
});

test('7. missing data stays missing: only the days passed in appear, and nothing is estimated or turned into zero', () => {
  const none = japaInsights([], TODAY, [japa('2026-10-01', '2026-10-31', 20, '06:30')]);
  assert.deepEqual([none.days, none.targetMet, none.seasonalDays, none.targetMin, none.targetMax, none.targetLine, none.cutoffs, none.cutoffLabel, none.conflict], [[], 0, 0, null, null, undefined, [], null, null]);
  const some = japaInsights([day('2026-10-10', 10, { targetSnapshot: snap(20, '06:30') }), day('2026-10-14', 10, { targetSnapshot: snap(20, '06:30') })], TODAY, []);
  assert.deepEqual(some.days.map((entry) => entry.date), ['2026-10-10', '2026-10-14'], 'the days between are not invented');
});

test('8. no private text can come out of the Insights helper', () => {
  const sentinel = 'TESTSECRET reflection words';
  const withReflection = { ...day('2026-10-10', 10, { targetSnapshot: snap(20, '06:30') }), reflection: sentinel } as InsightsJapaInput;
  const result = japaInsights([withReflection], TODAY, []);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
  assert.deepEqual(Object.keys(result.days[0]).sort(), ['cutoff', 'date', 'earlyRounds', 'olderSeasonalDay', 'rounds', 'source', 'target']);
});
