import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SeasonalError, buildVowLog, createVow, daysWithRecordedActivity, datesBetween, editVow, effectiveEnd, effectiveTargetFor, isValidDate, japaConflicts, japaProgress,
  logIdFor, resolveJapaTarget, studyProgress, targetSnapshotForSave, transitionVow, validateConfig, validateVowFields, vowPhase,
  type SeasonalVow, type TargetSnapshot, type VowInput, type VowType,
} from '../src/lib/seasonal.ts';

const NOW = '2026-10-01T08:00:00.000Z';
const ctx = (today: string) => ({ today, now: NOW });
const japaInput = (start: string, end: string, rounds: number, name = 'Extra Japa'): VowInput => ({ type: 'japa', seasonName: 'Test season', name, startDate: start, endDate: end, config: { targetRounds: rounds } });
let counter = 0;
function make(input: VowInput, status: SeasonalVow['status'] = 'active', created = NOW): SeasonalVow {
  counter += 1;
  return { ...createVow(`vow-${counter}`, input, ctx('2026-10-01')), status, createdAt: created };
}
const failure = (run: () => unknown): string => { try { run(); } catch (error) { if (error instanceof SeasonalError) return error.message; throw error; } return 'no-error'; };

test('dates: only real calendar dates, leap days, inclusive ranges, no time-zone drift', () => {
  assert.equal(isValidDate('2026-10-16'), true);
  assert.equal(isValidDate('2028-02-29'), true);
  for (const bad of ['2027-02-29', '2026-02-30', '2026-13-01', '2026-00-10', '2026-10-32', '26-10-16', '2026/10/16', '2026-10-16T00:00', '', null, 20261016]) assert.equal(isValidDate(bad), false, String(bad));
  assert.deepEqual(datesBetween('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.deepEqual(datesBetween('2026-10-16', '2026-10-16'), ['2026-10-16']); // first and last date are the same day
  assert.deepEqual(datesBetween('2026-10-17', '2026-10-16'), []);
  assert.equal(datesBetween('2026-03-28', '2026-03-30').length, 3); // a daylight-saving change must not add or drop a day
});

test('validation: fields, config per type, date order, no invented limits on season length', () => {
  assert.deepEqual(validateVowFields(japaInput('2026-10-01', '2026-10-31', 20)), []);
  assert.deepEqual(validateVowFields(japaInput('2026-10-01', '2026-10-01', 20)), []); // one-day season is fine
  assert.deepEqual(validateVowFields(japaInput('2026-01-01', '2027-12-31', 20)), []); // the app does not decide how long a season is
  assert.match(validateVowFields(japaInput('2026-10-31', '2026-10-01', 20)).join(' '), /end date cannot be before/);
  assert.match(validateVowFields(japaInput('2026-02-30', '2026-03-10', 20)).join(' '), /start date is not a real/);
  assert.match(validateVowFields({ ...japaInput('2026-10-01', '2026-10-31', 20), name: '  ' }).join(' '), /name/);
  assert.match(validateVowFields({ ...japaInput('2026-10-01', '2026-10-31', 20), seasonName: '' }).join(' '), /season/);
  for (const bad of [0, 65, 1.5, -3, '20', null, undefined]) assert.ok(validateConfig('japa', { targetRounds: bad }).length > 0, `japa ${String(bad)}`);
  assert.deepEqual(validateConfig('japa', { targetRounds: 64 }), []);
  assert.deepEqual(validateConfig('japa', { targetRounds: 1 }), []);
  assert.ok(validateConfig('japa', { targetRounds: 16, extra: 1 }).length > 0);
  assert.deepEqual(validateConfig('study', { minutesPerDay: 30 }), []);
  assert.deepEqual(validateConfig('study', { minutesPerDay: 30, scripture: 'Śrīmad-Bhāgavatam' }), []);
  assert.ok(validateConfig('study', { minutesPerDay: 0 }).length > 0);
  for (const type of ['lamps', 'damodarastaka', 'evening-sravanam', 'abstinence'] as VowType[]) { assert.deepEqual(validateConfig(type, {}), []); assert.ok(validateConfig(type, { anything: 1 }).length > 0); }
  assert.ok(validateConfig('japa', null).length > 0);
  assert.ok(validateVowFields({ ...japaInput('2026-10-01', '2026-10-31', 20), type: 'nonsense' as never }).length > 0);
});

test('new commitments start as drafts, with trimmed text and normalised config', () => {
  const vow = createVow('v', { type: 'study', seasonName: '  Season ', name: ' Bhāgavatam ', startDate: '2026-10-01', endDate: '2026-10-31', config: { minutesPerDay: 30, scripture: '  ' } }, ctx('2026-10-01'));
  assert.equal(vow.status, 'draft'); assert.equal(vow.name, 'Bhāgavatam'); assert.equal(vow.seasonName, 'Season');
  assert.deepEqual(vow.config, { minutesPerDay: 30 });
  assert.equal(failure(() => createVow('v', japaInput('2026-10-31', '2026-10-01', 20), ctx('2026-10-01'))).includes('end date'), true);
});

test('Japa precedence: seasonal only inside an active vow’s dates, regular target untouched everywhere else', () => {
  const vow = make(japaInput('2026-10-10', '2026-10-20', 20));
  const regular = 16;
  assert.deepEqual(resolveJapaTarget('2026-10-09', regular, [vow]), { source: 'regular', rounds: 16 }); // the day before
  assert.deepEqual(resolveJapaTarget('2026-10-10', regular, [vow]), { source: 'seasonal', rounds: 20, vowId: vow.id, vowName: 'Extra Japa' }); // first date
  assert.equal(resolveJapaTarget('2026-10-15', regular, [vow]).rounds, 20);
  assert.equal(resolveJapaTarget('2026-10-20', regular, [vow]).rounds, 20); // last date, inclusive
  assert.deepEqual(resolveJapaTarget('2026-10-21', regular, [vow]), { source: 'regular', rounds: 16 }); // the day after: expired with no stored change
  assert.equal(vow.status, 'active');
  assert.equal(vowPhase(vow, '2026-10-21'), 'ended'); assert.equal(vowPhase(vow, '2026-10-09'), 'upcoming'); assert.equal(vowPhase(vow, '2026-10-12'), 'in-season');
  assert.equal(resolveJapaTarget('2026-10-15', 12, [vow]).source, 'seasonal');
  assert.equal(resolveJapaTarget('2026-10-15', 12, []).rounds, 12); // no vows: whatever the regular target is
});

test('draft, paused, completed and archived vows never override the target; completion cuts a vow short', () => {
  for (const status of ['draft', 'paused', 'completed', 'archived'] as const) assert.equal(resolveJapaTarget('2026-10-15', 16, [make(japaInput('2026-10-10', '2026-10-20', 20), status)]).source, 'regular', status);
  const active = make(japaInput('2026-10-10', '2026-10-31', 20));
  const completed = transitionVow(active, 'complete', [active], ctx('2026-10-15'));
  assert.equal(completed.endedOn, '2026-10-15'); assert.equal(effectiveEnd(completed), '2026-10-15');
  assert.equal(resolveJapaTarget('2026-10-14', 16, [completed]).source, 'regular'); // completed vows are no longer "active"
  const late = transitionVow(make(japaInput('2026-10-10', '2026-10-20', 20)), 'complete', [], ctx('2026-11-30'));
  assert.equal(late.endedOn, '2026-10-20'); // completing after the season clamps to the season’s own end
  assert.equal(resolveJapaTarget('2026-10-15', 16, [make({ ...japaInput('2026-10-10', '2026-10-20', 20), type: 'study', config: { minutesPerDay: 30 } })]).source, 'regular'); // other vow types never touch Japa
});

test('conflicting active Japa vows are rejected with an explanation; compatible ones are allowed', () => {
  const base = make(japaInput('2026-10-10', '2026-10-20', 20, 'Base'));
  const clash = make(japaInput('2026-10-20', '2026-10-25', 24, 'Clash'), 'draft'); // shares exactly one day
  assert.equal(japaConflicts(base, [clash]).length, 0, 'a DRAFT elsewhere never blocks anything');
  const activeClash = { ...clash, status: 'active' as const };
  assert.equal(japaConflicts(activeClash, [base]).length, 1);
  assert.equal(japaConflicts(clash, [base]).length, 1, 'the candidate’s own status is irrelevant: activation sets it active and then checks');
  const message = failure(() => transitionVow(clash, 'activate', [base], ctx('2026-10-01')));
  assert.match(message, /"Clash" asks for 24 rounds/); assert.match(message, /"Base" \(20 rounds/); assert.match(message, /Only one seasonal Japa target/);
  assert.equal(failure(() => transitionVow(make(japaInput('2026-10-21', '2026-10-25', 24), 'draft'), 'activate', [base], ctx('2026-10-01'))), 'no-error'); // adjacent, not overlapping
  assert.equal(failure(() => transitionVow(make(japaInput('2026-10-15', '2026-10-18', 20), 'draft'), 'activate', [base], ctx('2026-10-01'))), 'no-error'); // overlapping with the SAME target is not a conflict
  const paused = { ...base, status: 'paused' as const };
  assert.equal(failure(() => transitionVow(clash, 'activate', [paused], ctx('2026-10-01'))), 'no-error'); // a paused vow does not conflict
  assert.match(failure(() => transitionVow(paused, 'resume', [activeClash], ctx('2026-10-01'))), /Only one seasonal Japa target/); // resuming re-checks
  assert.match(failure(() => editVow(base, { endDate: '2026-10-22' }, [activeClash], ctx('2026-10-01'))), /overlaps/); // editing into a clash is refused
  assert.equal(failure(() => editVow({ ...clash, status: 'draft' }, { endDate: '2026-10-22' }, [base], ctx('2026-10-01'))), 'no-error'); // a draft can be arranged freely
  // Imported or corrupted data: never choose silently.
  const result = resolveJapaTarget('2026-10-20', 16, [base, activeClash]);
  assert.equal(result.source, 'regular'); assert.equal(result.rounds, 16);
  assert.deepEqual('conflict' in result && result.conflict.targets.sort(), [20, 24]);
  assert.equal('conflict' in resolveJapaTarget('2026-10-12', 16, [base, activeClash]), false, 'no conflict on a day only one vow covers');
  const twin = make(japaInput('2026-10-10', '2026-10-20', 20, 'Twin'), 'active', '2026-09-30T00:00:00.000Z');
  assert.equal((resolveJapaTarget('2026-10-12', 16, [base, twin]) as { vowName: string }).vowName, 'Twin'); // same target: attributed to the earliest-created, deterministically
});

test('lifecycle: pausing and completing keep everything; archived is read-only; nothing deletes', () => {
  const draft = make(japaInput('2026-10-10', '2026-10-20', 20), 'draft');
  assert.match(failure(() => transitionVow(draft, 'pause', [], ctx('2026-10-12'))), /Only an active/);
  const active = transitionVow(draft, 'activate', [], ctx('2026-10-01'));
  assert.equal(active.status, 'active');
  assert.match(failure(() => transitionVow(active, 'activate', [], ctx('2026-10-01'))), /Only a draft/);
  assert.match(failure(() => transitionVow(active, 'archive', [], ctx('2026-10-12'))), /Pause or complete/);
  const paused = transitionVow(active, 'pause', [], ctx('2026-10-12'));
  assert.deepEqual({ ...paused, status: 'active', updatedAt: active.updatedAt }, active); // only the status moved
  const resumed = transitionVow(paused, 'resume', [], ctx('2026-10-13'));
  assert.equal(resumed.status, 'active');
  const done = transitionVow(resumed, 'complete', [], ctx('2026-10-15'));
  const archived = transitionVow(done, 'archive', [], ctx('2026-10-16'));
  assert.equal(archived.status, 'archived'); assert.equal(archived.endedOn, '2026-10-15'); assert.equal(archived.name, active.name); assert.deepEqual(archived.config, active.config);
  assert.match(failure(() => editVow(archived, { name: 'x' }, [], ctx('2026-10-17'))), /kept as history/);
  assert.match(failure(() => editVow(done, { name: 'x' }, [], ctx('2026-10-17'))), /kept as history/);
  assert.match(failure(() => transitionVow(make(japaInput('2026-10-10', '2026-10-20', 20)), 'complete', [], ctx('2026-10-05'))), /not started yet/);
  const edited = editVow(active, { name: 'Renamed', config: { targetRounds: 22 } }, [], ctx('2026-10-14'));
  assert.equal(edited.id, active.id); assert.equal(edited.type, 'japa'); assert.equal(edited.createdAt, active.createdAt); assert.equal(edited.status, 'active'); assert.equal(edited.updatedAt, NOW);
  assert.equal(failure(() => editVow(active, { startDate: '2026-11-01' }, [], ctx('2026-10-14'))).includes('end date cannot be before'), true);
});

test('target snapshots: open days follow the rule, closed days freeze, legacy rows are never guessed or rewritten', () => {
  const today = '2026-10-15';
  const vow = make(japaInput('2026-10-10', '2026-10-31', 20));
  const seasonal = (date: string, regular = 16) => resolveJapaTarget(date, regular, [vow]);
  const snap = (over: Partial<Parameters<typeof targetSnapshotForSave>[0]>) => targetSnapshotForSave({ isNewRow: true, date: today, today, regularTarget: 16, resolution: seasonal(today), ...over });
  assert.deepEqual(snap({}), { rounds: 20, source: 'seasonal', vowId: vow.id, vowName: 'Extra Japa' }); // today, new row
  assert.deepEqual(snap({ existing: { rounds: 16, source: 'regular' } }), { rounds: 20, source: 'seasonal', vowId: vow.id, vowName: 'Extra Japa' }); // open day refreshes
  assert.deepEqual(snap({ date: '2026-10-16', resolution: seasonal('2026-10-16') })?.rounds, 20); // a future day, same rule
  assert.deepEqual(snap({ resolution: resolveJapaTarget(today, 16, []) }), { rounds: 16, source: 'regular' });
  const frozen: TargetSnapshot = { rounds: 20, source: 'seasonal', vowId: vow.id, vowName: 'Extra Japa' };
  const past = (over: Partial<Parameters<typeof targetSnapshotForSave>[0]>) => targetSnapshotForSave({ isNewRow: false, date: '2026-10-12', today, regularTarget: 16, resolution: resolveJapaTarget('2026-10-12', 16, []), ...over });
  assert.deepEqual(past({ existing: frozen }), frozen, 'a closed day keeps its snapshot even if the vow has since been paused or removed');
  assert.equal(past({}), undefined, 'a past row saved before this feature gets no snapshot: not rewritten, not guessed');
  assert.deepEqual(past({ isNewRow: true, resolution: seasonal('2026-10-12') })?.rounds, 20, 'filling in a missed past day now uses the rule in force while entering it');
  // The history guarantee end to end: edit, pause, complete and archive the vow after a day was recorded.
  const recorded = snap({ date: '2026-10-12', today: '2026-10-12', resolution: seasonal('2026-10-12') }) as TargetSnapshot;
  let changed = editVow(vow, { config: { targetRounds: 30 } }, [], ctx(today));
  changed = transitionVow(transitionVow(changed, 'pause', [], ctx(today)), 'resume', [], ctx(today));
  changed = transitionVow(transitionVow(changed, 'complete', [], ctx(today)), 'archive', [], ctx(today));
  const after = targetSnapshotForSave({ existing: recorded, isNewRow: false, date: '2026-10-12', today: '2026-10-20', regularTarget: 16, resolution: resolveJapaTarget('2026-10-12', 16, [changed]) });
  assert.deepEqual(after, recorded);
  assert.equal(recorded.rounds, 20);
});

test('effective target for display: snapshot first, stored regular target for past legacy rows, live rule otherwise', () => {
  const today = '2026-10-15';
  const vow = make(japaInput('2026-10-10', '2026-10-31', 20));
  const row = (date: string, extra: Partial<{ targetRounds: number; targetSnapshot: TargetSnapshot }> = {}) => ({ date, targetRounds: 16, ...extra });
  assert.equal(effectiveTargetFor(row('2026-10-12', { targetSnapshot: { rounds: 18, source: 'seasonal', vowId: 'x', vowName: 'Old' } }), '2026-10-12', today, 16, [vow]).rounds, 18);
  assert.deepEqual(effectiveTargetFor(row('2026-10-12'), '2026-10-12', today, 16, [vow]), { rounds: 16, source: 'regular-unrecorded' }, 'past legacy row: the regular target it was saved with');
  assert.equal(effectiveTargetFor(null, '2026-10-12', today, 16, [vow]).source, 'seasonal', 'no row yet: the live rule');
  assert.equal(effectiveTargetFor(row(today), today, today, 16, [vow]).rounds, 20, 'today’s legacy row follows the live rule');
  assert.equal(effectiveTargetFor(row('2026-10-05'), '2026-10-05', today, 16, [vow]).rounds, 16);
  const stale: TargetSnapshot = { rounds: 20, source: 'seasonal', vowId: vow.id, vowName: 'Extra Japa' };
  assert.equal(effectiveTargetFor(row(today, { targetSnapshot: stale }), today, today, 16, []).rounds, 16, 'an open day ignores a stale snapshot once the commitment is gone or paused');
  assert.equal(effectiveTargetFor(row(today, { targetSnapshot: stale }), today, today, 16, [{ ...vow, status: 'paused' }]).source, 'regular');
  assert.equal(effectiveTargetFor(row('2026-10-12', { targetSnapshot: stale }), '2026-10-12', today, 16, []).rounds, 20, 'while a closed day keeps its snapshot no matter what happened to the commitment');
  assert.equal(effectiveTargetFor(null, '2026-11-02', today, 14, [vow]).rounds, 14, 'regular target unchanged after the season');
});

test('daily logs: one per vow per date, neutral abstinence wording, frozen snapshot, strict blocking rules', () => {
  const lamps = make({ type: 'lamps', seasonName: 'S', name: 'Evening lamp', startDate: '2026-10-10', endDate: '2026-10-20', config: {} });
  const base = { vow: lamps, date: '2026-10-12', ctx: ctx('2026-10-15') };
  const first = buildVowLog({ ...base, entry: { completed: true } });
  assert.equal(first.id, logIdFor(lamps.id, '2026-10-12')); assert.equal(first.id, `${lamps.id}|2026-10-12`);
  assert.equal(first.completed, true); assert.deepEqual(first.snapshot, { name: 'Evening lamp', seasonName: 'S', config: {} });
  const renamed = { ...lamps, name: 'Renamed later' };
  const again = buildVowLog({ vow: renamed, date: '2026-10-12', entry: { completed: false }, existing: first, ctx: { today: '2026-10-15', now: '2026-10-15T09:00:00.000Z' } });
  assert.equal(again.id, first.id, 'logging twice addresses the same row (duplicate prevention by key)');
  assert.equal(again.completed, false); assert.equal(again.createdAt, first.createdAt); assert.equal(again.updatedAt, '2026-10-15T09:00:00.000Z');
  assert.equal(again.snapshot.name, 'Evening lamp', 'the snapshot never follows later edits');
  const abst = make({ type: 'abstinence', seasonName: 'S', name: 'Quiet from sweets', startDate: '2026-10-10', endDate: '2026-10-20', config: {} });
  for (const status of ['observed', 'not-today', 'unrecorded'] as const) assert.equal(buildVowLog({ vow: abst, date: '2026-10-12', entry: { abstinence: status }, ctx: ctx('2026-10-15') }).abstinence, status);
  assert.match(failure(() => buildVowLog({ vow: abst, date: '2026-10-12', entry: { abstinence: 'failed' as never }, ctx: ctx('2026-10-15') })), /Observed, Not today or Unrecorded/);
  assert.match(failure(() => buildVowLog({ vow: lamps, date: '2026-10-12', entry: { abstinence: 'observed' } as never, ctx: ctx('2026-10-15') })), /whether this was done/);
  const block = (vow: SeasonalVow, date: string, today = '2026-10-15') => failure(() => buildVowLog({ vow, date, entry: { completed: true }, ctx: ctx(today) }));
  assert.match(block({ ...lamps, status: 'paused' }, '2026-10-12'), /paused/);
  assert.match(block({ ...lamps, status: 'draft' }, '2026-10-12'), /Activate/);
  assert.match(block({ ...lamps, status: 'archived' }, '2026-10-12'), /review only/);
  assert.match(block(lamps, '2026-10-09'), /outside/);
  assert.match(block(lamps, '2026-10-21'), /outside/);
  assert.match(block(lamps, '2026-10-18'), /Future days/);
  assert.match(block(lamps, '2026-02-30'), /real calendar date/);
  assert.equal(block(lamps, '2026-10-10'), 'no-error'); assert.equal(block(lamps, '2026-10-20', '2026-10-25'), 'no-error'); // first and last dates
  const completed = transitionVow(lamps, 'complete', [], ctx('2026-10-15'));
  assert.equal(block(completed, '2026-10-14'), 'no-error'); assert.match(block(completed, '2026-10-16', '2026-10-20'), /outside/);
  for (const type of ['japa', 'study'] as const) assert.match(failure(() => buildVowLog({ vow: make(type === 'japa' ? japaInput('2026-10-10', '2026-10-20', 20) : { type, seasonName: 'S', name: 'x', startDate: '2026-10-10', endDate: '2026-10-20', config: { minutesPerDay: 20 } }), date: '2026-10-12', entry: { completed: true }, ctx: ctx('2026-10-15') })), /nothing to log/);
});

test('study progress comes from saved Study sessions and never double-counts', () => {
  const vow = make({ type: 'study', seasonName: 'S', name: 'Bhāgavatam', startDate: '2026-10-10', endDate: '2026-10-20', config: { minutesPerDay: 30, scripture: 'bhāgavatam' } });
  const sessions = [
    { id: 1, date: '2026-10-12', kind: 'Study', title: 'Śrīmad-Bhāgavatam Canto 10', minutes: 20 },
    { id: 1, date: '2026-10-12', kind: 'Study', title: 'Śrīmad-Bhāgavatam Canto 10', minutes: 20 }, // same session id twice
    { id: 2, date: '2026-10-12', kind: 'Study', title: 'Other book', topic: 'about the Bhāgavatam', minutes: 15 },
    { id: 3, date: '2026-10-12', kind: 'Study', title: 'Bhagavad-gītā', minutes: 40 }, // different scripture
    { id: 4, date: '2026-10-12', kind: 'Hearing', title: 'Bhāgavatam lecture', minutes: 60 }, // hearing is not study
    { id: 5, date: '2026-10-13', kind: 'Study', title: 'Bhāgavatam', minutes: 99 }, // another day
  ];
  assert.deepEqual(studyProgress(vow, '2026-10-12', sessions), { minutes: 35, target: 30, sessionCount: 2 });
  const any = { ...vow, config: { minutesPerDay: 30 } };
  assert.equal(studyProgress(any, '2026-10-12', sessions).minutes, 75);
  assert.equal(studyProgress(vow, '2026-10-11', sessions).minutes, 0);
});

test('Japa progress and "days with recorded activity" are neutral counts, with missing days left blank', () => {
  assert.equal(japaProgress(null), null);
  assert.deepEqual(japaProgress({ rounds: 12, targetRounds: 16, targetSnapshot: { rounds: 20, source: 'seasonal' } }), { rounds: 12, target: 20, source: 'seasonal' });
  assert.deepEqual(japaProgress({ rounds: 12, targetRounds: 16 }), { rounds: 12, target: 16, source: 'regular' });
  const lamps = make({ type: 'lamps', seasonName: 'S', name: 'Lamp', startDate: '2026-10-10', endDate: '2026-10-20', config: {} });
  const logs = [buildVowLog({ vow: lamps, date: '2026-10-10', entry: { completed: true }, ctx: ctx('2026-10-12') }), buildVowLog({ vow: lamps, date: '2026-10-11', entry: { completed: false }, ctx: ctx('2026-10-12') })];
  assert.deepEqual(daysWithRecordedActivity({ vow: lamps, today: '2026-10-12', logs, sessions: [], sadhana: [] }), ['2026-10-10']);
  const japa = make(japaInput('2026-10-10', '2026-10-20', 20));
  assert.deepEqual(daysWithRecordedActivity({ vow: japa, today: '2026-10-15', logs: [], sessions: [], sadhana: [{ date: '2026-10-11', rounds: 5 }, { date: '2026-10-12', rounds: 0 }, { date: '2026-10-25', rounds: 9 }] }), ['2026-10-11']);
  assert.deepEqual(daysWithRecordedActivity({ vow: lamps, today: '2026-10-12', logs: [], sessions: [], sadhana: [] }), [], 'nothing recorded is simply empty, not a failure');
});
