import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REGULAR_TARGET, FORM_FIELD_ORDER, clock12, emptyForm, formFromVow, groupVows, knownSeasonNames, regularTargetFor, targetDifference, validateVowForm, vowFormToInput,
  type VowFormValues,
} from '../src/lib/seasonalView.ts';
import { createVow, validateConfig, validateVowFields, type SeasonalVow, type VowType } from '../src/lib/seasonal.ts';

const ctx = { today: '2026-10-20', now: '2026-10-20T08:00:00.000Z' };
const valid = (over: Partial<VowFormValues> = {}): VowFormValues => ({ ...emptyForm('japa', 'Test season'), name: 'Extra Japa', startDate: '2026-10-10', endDate: '2026-11-10', targetRounds: '20', ...over });

test('a new form assumes no dates, names or targets, and defaults only the 7:00 AM cutoff', () => {
  const form = emptyForm();
  assert.equal(form.startDate, ''); assert.equal(form.endDate, ''); assert.equal(form.seasonName, ''); assert.equal(form.name, ''); assert.equal(form.targetRounds, '');
  assert.equal(form.morningCutoff, '07:00');
  assert.equal(form.type, 'japa');
  assert.equal(emptyForm('study', 'Any season').seasonName, 'Any season');
});

test('an empty form reports every required field, in the order the screen focuses them', () => {
  const errors = validateVowForm(emptyForm('japa'));
  assert.deepEqual(Object.keys(errors).sort(), ['endDate', 'name', 'seasonName', 'startDate', 'targetRounds']);
  assert.deepEqual(FORM_FIELD_ORDER.filter((field) => errors[field]), ['seasonName', 'name', 'startDate', 'endDate', 'targetRounds']);
  assert.deepEqual(Object.keys(validateVowForm(emptyForm('study'))).sort(), ['endDate', 'minutesPerDay', 'name', 'seasonName', 'startDate']);
  assert.deepEqual(Object.keys(validateVowForm(emptyForm('lamps'))).sort(), ['endDate', 'name', 'seasonName', 'startDate']);
  assert.deepEqual(validateVowForm(valid()), {});
});

test('text fields: trimmed, required, with length limits', () => {
  assert.equal(validateVowForm(valid({ seasonName: '   ' })).seasonName, 'Give this season a name.');
  assert.equal(validateVowForm(valid({ name: '' })).name, 'Give this commitment a name.');
  assert.match(validateVowForm(valid({ seasonName: 'x'.repeat(81) })).seasonName ?? '', /80/);
  assert.match(validateVowForm(valid({ name: 'x'.repeat(121) })).name ?? '', /120/);
  assert.equal(validateVowForm(valid({ seasonName: 'x'.repeat(80), name: 'y'.repeat(120) })).seasonName, undefined);
});

test('dates: required, real, and the end never before the start (same day is fine)', () => {
  assert.equal(validateVowForm(valid({ startDate: '' })).startDate, 'Enter the start date.');
  assert.equal(validateVowForm(valid({ endDate: '' })).endDate, 'Enter the end date.');
  assert.equal(validateVowForm(valid({ startDate: '2026-02-30' })).startDate, 'That is not a real calendar date.');
  assert.equal(validateVowForm(valid({ endDate: '2026-13-01' })).endDate, 'That is not a real calendar date.');
  assert.equal(validateVowForm(valid({ startDate: '2026-11-10', endDate: '2026-10-10' })).endDate, 'The end date cannot be before the start date.');
  assert.deepEqual(validateVowForm(valid({ startDate: '2026-10-10', endDate: '2026-10-10' })), {});
  assert.deepEqual(validateVowForm(valid({ startDate: '2028-02-29', endDate: '2028-03-01' })), {}); // leap day
  assert.equal(validateVowForm(valid({ startDate: '2027-02-29' })).startDate, 'That is not a real calendar date.');
  assert.equal(validateVowForm(valid({ startDate: '2026-02-30', endDate: '2026-01-01' })).endDate, undefined, 'an unreadable start does not produce a misleading end-date message');
});

test('Japa target and cutoff: whole numbers 1-64, a real HH:MM time', () => {
  for (const good of ['1', '16', '20', '64', ' 20 ']) assert.equal(validateVowForm(valid({ targetRounds: good })).targetRounds, undefined, good);
  for (const bad of ['', '0', '65', '-3', '1.5', 'abc', '2e1', '١٦', '1000000000']) assert.match(validateVowForm(valid({ targetRounds: bad })).targetRounds ?? '', /whole number from 1 to 64/, bad);
  for (const good of ['07:00', '00:00', '23:59', '12:30']) assert.equal(validateVowForm(valid({ morningCutoff: good })).morningCutoff, undefined, good);
  for (const bad of ['', '7:00', '24:00', '07:60', '07:00 AM', 'noon']) assert.match(validateVowForm(valid({ morningCutoff: bad })).morningCutoff ?? '', /time such as 07:00/, bad);
  assert.equal(validateVowForm(valid({ type: 'study', targetRounds: '', minutesPerDay: '30' })).targetRounds, undefined, 'Japa fields are ignored for other types');
});

test('study: minutes 1-1440, scripture optional and bounded', () => {
  const study = (over: Partial<VowFormValues>) => valid({ type: 'study', targetRounds: '', minutesPerDay: '30', ...over });
  assert.deepEqual(validateVowForm(study({})), {});
  for (const bad of ['', '0', '1441', '-5', '2.5', 'many']) assert.match(validateVowForm(study({ minutesPerDay: bad })).minutesPerDay ?? '', /whole minutes from 1 to 1440/, bad);
  assert.equal(validateVowForm(study({ minutesPerDay: '1440' })).minutesPerDay, undefined);
  assert.match(validateVowForm(study({ scripture: 'x'.repeat(121) })).scripture ?? '', /120/);
  assert.equal(validateVowForm(study({ scripture: '' })).scripture, undefined);
});

test('a valid form converts to exactly the model input, which the model itself accepts', () => {
  const japa = vowFormToInput(valid({ seasonName: '  Season ', name: ' Extra Japa ', targetRounds: ' 20 ', morningCutoff: '06:30' }));
  assert.deepEqual(japa, { type: 'japa', seasonName: 'Season', name: 'Extra Japa', startDate: '2026-10-10', endDate: '2026-11-10', config: { targetRounds: 20, morningCutoff: '06:30' } });
  assert.deepEqual(validateVowFields(japa), []);
  assert.deepEqual(vowFormToInput(valid({ type: 'study', minutesPerDay: '45', scripture: ' Bhāgavatam ' })).config, { minutesPerDay: 45, scripture: 'Bhāgavatam' });
  assert.deepEqual(vowFormToInput(valid({ type: 'study', minutesPerDay: '45', scripture: '  ' })).config, { minutesPerDay: 45 });
  for (const type of ['lamps', 'damodarastaka', 'evening-sravanam', 'abstinence'] as VowType[]) {
    const input = vowFormToInput(valid({ type, targetRounds: '99', minutesPerDay: '99', scripture: 'leftover' }));
    assert.deepEqual(input.config, {}, `${type}: values typed for another type are never carried over`);
    assert.deepEqual(validateVowFields(input), []);
  }
});

test('the model accepts and validates the morning cutoff, and still refuses unknown Japa details', () => {
  assert.deepEqual(validateConfig('japa', { targetRounds: 20, morningCutoff: '07:00' }), []);
  assert.deepEqual(validateConfig('japa', { targetRounds: 20 }), [], 'vows saved before the cutoff existed remain valid');
  assert.match(validateConfig('japa', { targetRounds: 20, morningCutoff: '7am' }).join(' '), /morning cutoff/);
  assert.match(validateConfig('japa', { targetRounds: 20, surprise: 1 }).join(' '), /Unknown Japa detail/);
});

test('editing a saved commitment fills the form back exactly', () => {
  const japa = createVow('v1', { type: 'japa', seasonName: 'S', name: 'N', startDate: '2026-10-10', endDate: '2026-10-20', config: { targetRounds: 22, morningCutoff: '06:15' } }, ctx);
  assert.deepEqual(formFromVow(japa), { type: 'japa', seasonName: 'S', name: 'N', startDate: '2026-10-10', endDate: '2026-10-20', targetRounds: '22', morningCutoff: '06:15', minutesPerDay: '', scripture: '' });
  assert.deepEqual(validateVowForm(formFromVow(japa)), {});
  const old = { ...japa, config: { targetRounds: 22 } } as SeasonalVow; // saved before the cutoff existed
  assert.equal(formFromVow(old).morningCutoff, '07:00');
  const study = createVow('v2', { type: 'study', seasonName: 'S', name: 'N', startDate: '2026-10-10', endDate: '2026-10-20', config: { minutesPerDay: 30, scripture: 'Gītā' } }, ctx);
  assert.deepEqual(vowFormToInput(formFromVow(study)).config, study.config);
});

test('regular target lookup mirrors the Sādhana screen: that day, else the latest earlier day, else 16', () => {
  const rows = [{ date: '2026-10-05', targetRounds: 14 }, { date: '2026-10-10', targetRounds: 18 }];
  assert.equal(regularTargetFor('2026-10-10', rows), 18);
  assert.equal(regularTargetFor('2026-10-12', rows), 18);
  assert.equal(regularTargetFor('2026-10-07', rows), 14);
  assert.equal(regularTargetFor('2026-10-01', rows), DEFAULT_REGULAR_TARGET);
  assert.equal(regularTargetFor('2026-10-01', []), 16);
});

test('plain-language helpers: clock, target difference, grouping, season names', () => {
  assert.deepEqual(['07:00', '00:05', '12:00', '19:30', 'bad'].map(clock12), ['7:00 AM', '12:05 AM', '12:00 PM', '7:30 PM', 'bad']);
  assert.equal(targetDifference(20, 16), '4 rounds above your regular target');
  assert.equal(targetDifference(17, 16), '1 round above your regular target');
  assert.equal(targetDifference(12, 16), '4 rounds below your regular target');
  assert.equal(targetDifference(16, 16), 'the same as your regular target');
  const make = (id: string, name: string, status: SeasonalVow['status'], start: string, end: string, season = 'A'): SeasonalVow => ({ ...createVow(id, { type: 'lamps', seasonName: season, name, startDate: start, endDate: end, config: {} }, ctx), status });
  const groups = groupVows([
    make('1', 'Late', 'active', '2026-11-01', '2026-11-30'), make('2', 'Early', 'active', '2026-10-01', '2026-10-31', 'B'), make('3', 'Draft', 'draft', '2026-10-01', '2026-10-31'),
    make('4', 'Paused', 'paused', '2026-10-01', '2026-10-31'), make('5', 'Old', 'archived', '2026-01-01', '2026-01-31'), make('6', 'Done', 'completed', '2026-09-01', '2026-09-30'),
  ]);
  assert.deepEqual(groups.active.map((vow) => vow.name), ['Early', 'Late']);
  assert.deepEqual([groups.drafts.length, groups.paused.length], [1, 1]);
  assert.deepEqual(groups.history.map((vow) => vow.name), ['Done', 'Old'], 'history is newest first and keeps completed and archived commitments');
  assert.deepEqual(knownSeasonNames([make('1', 'x', 'active', '2026-10-01', '2026-10-02', 'Zeta'), make('2', 'y', 'active', '2026-10-01', '2026-10-02', 'Alpha'), make('3', 'z', 'draft', '2026-10-01', '2026-10-02', 'Alpha')]), ['Alpha', 'Zeta']);
});
