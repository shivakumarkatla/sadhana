/**
 * Seasonal Saṅkalpa business rules. Pure (no Dexie, no DOM, no imports) so every rule is unit-tested with `node --test`.
 * Erasable TypeScript only.
 *
 * Principles
 *  - The user supplies every date. Nothing here knows about festivals or calendars, and nothing infers that a season "is" anything.
 *  - Seasonal vows SUPPLEMENT the daily routine. Only an active seasonal Japa vow overrides the daily target, and only on dates inside its range.
 *  - The regular target (`SadhanaRecord.targetRounds`) is never written with a seasonal value.
 *  - History is preserved: each Sādhana row can carry a target snapshot; open days follow the live rule, closed days are frozen,
 *    and rows saved before this feature (no snapshot) are never rewritten or guessed.
 *  - Neutral wording only: no streaks, scores or achievements.
 */

export const VOW_TYPES = ['japa', 'study', 'lamps', 'damodarastaka', 'evening-sravanam', 'abstinence'] as const;
export type VowType = (typeof VOW_TYPES)[number];
export const VOW_TYPE_LABELS: Record<VowType, string> = {
  japa: 'Japa Rounds', study: 'Scriptural Study', lamps: 'Sacred Lamps', damodarastaka: 'Dāmodarāṣṭaka',
  'evening-sravanam': 'Evening Śravaṇam', abstinence: 'Specific Abstinence',
};
/** draft: being configured; active: in force during its dates; paused: on hold (nothing applies, nothing can be logged); completed: ended by the user; archived: kept for review only. */
export const VOW_STATUSES = ['draft', 'active', 'paused', 'completed', 'archived'] as const;
export type VowStatus = (typeof VOW_STATUSES)[number];
export const MIN_JAPA_TARGET = 1;
export const MAX_JAPA_TARGET = 64; // same ceiling the Sādhana screen already uses
export const SEASONAL_FORMAT_VERSION = 1;
const DAILY_LOG_TYPES: VowType[] = ['lamps', 'damodarastaka', 'evening-sravanam', 'abstinence'];

/** `morningCutoff` ("HH:MM", 24-hour) is the time by which the commitment's rounds are meant to be done, e.g. "07:00". The form defaults it to 07:00. It is stored and shown; it does not yet change how the Sādhana screen counts early rounds. */
export interface JapaConfig { targetRounds: number; morningCutoff?: string }
export const DEFAULT_MORNING_CUTOFF = '07:00';
export const isClockTime = (value: unknown): value is string => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
export interface StudyConfig { minutesPerDay: number; scripture?: string }
export type NoConfig = Record<string, never>;
export type VowConfig = JapaConfig | StudyConfig | NoConfig;

export interface SeasonalVow {
  id: string;
  type: VowType;
  /** User-entered label shared by the vows of one season, e.g. a season name the user chooses. Free text; never interpreted. */
  seasonName: string;
  name: string;
  startDate: string; // local calendar date, YYYY-MM-DD, entered by the user
  endDate: string;   // inclusive
  status: VowStatus;
  /** Set when the user completes a vow early; the vow no longer applies after this date. */
  endedOn?: string;
  config: VowConfig;
  configVersion: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * What applied to a Sādhana day when it was recorded. `morningCutoff` ("HH:MM") is optional: snapshots saved before it existed have none,
 * and a missing or unreadable value always means "show the 07:00 default, and never guess".
 */
export interface TargetSnapshot { rounds: number; source: 'regular' | 'seasonal'; vowId?: string; vowName?: string; morningCutoff?: string }

export type AbstinenceStatus = 'observed' | 'not-today' | 'unrecorded';
export interface VowLog {
  /** Deterministic `${vowId}|${date}`: the primary key itself makes a second log for the same vow and date impossible. */
  id: string;
  vowId: string;
  date: string;
  type: VowType;
  completed?: boolean;
  abstinence?: AbstinenceStatus;
  /** Copy of what the vow asked for when this day was first logged; later edits to the vow never change it. */
  snapshot: { name: string; seasonName: string; config: VowConfig };
  createdAt: string;
  updatedAt: string;
}

export class SeasonalError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(issues.join(' '));
    this.name = 'SeasonalError';
    this.issues = issues;
  }
}

// --- dates -------------------------------------------------------------------------------------------------------------

/** True only for real calendar dates in YYYY-MM-DD form ("2026-02-30" is rejected). Pure string/UTC arithmetic, so time zones can never shift it. */
export function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}
export function localDateString(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
/** Last date the vow can apply to: the user's early end if there is one, otherwise the configured end. Both ends are inclusive. */
export function effectiveEnd(vow: Pick<SeasonalVow, 'endDate' | 'endedOn'>): string {
  return vow.endedOn && vow.endedOn < vow.endDate ? vow.endedOn : vow.endDate;
}
export function dateInRange(vow: Pick<SeasonalVow, 'startDate' | 'endDate' | 'endedOn'>, date: string): boolean {
  return date >= vow.startDate && date <= effectiveEnd(vow);
}
function rangesOverlap(a: SeasonalVow, b: SeasonalVow): boolean {
  return a.startDate <= effectiveEnd(b) && b.startDate <= effectiveEnd(a);
}
export function datesBetween(start: string, end: string): string[] {
  const dates: string[] = [];
  if (!isValidDate(start) || !isValidDate(end) || start > end) return dates;
  const [year, month, day] = start.split('-').map(Number);
  for (let cursor = new Date(Date.UTC(year, month - 1, day)); cursor.toISOString().slice(0, 10) <= end; cursor = new Date(cursor.getTime() + 86_400_000)) {
    dates.push(cursor.toISOString().slice(0, 10));
    if (dates.length > 4000) break; // safety net against absurd ranges
  }
  return dates;
}

// --- validation ----------------------------------------------------------------------------------------------------------

export interface VowInput {
  type: VowType; seasonName: string; name: string; startDate: string; endDate: string; config: VowConfig;
}

export function validateConfig(type: VowType, config: unknown): string[] {
  const issues: string[] = [];
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return ['The commitment details are missing.'];
  const values = config as Record<string, unknown>;
  if (type === 'japa') {
    const target = values.targetRounds;
    if (!Number.isInteger(target) || (target as number) < MIN_JAPA_TARGET || (target as number) > MAX_JAPA_TARGET) issues.push(`The seasonal Japa target must be a whole number from ${MIN_JAPA_TARGET} to ${MAX_JAPA_TARGET} rounds.`);
    if (values.morningCutoff !== undefined && !isClockTime(values.morningCutoff)) issues.push('The morning cutoff must be a time such as 07:00.');
    for (const key of Object.keys(values)) if (key !== 'targetRounds' && key !== 'morningCutoff') issues.push(`Unknown Japa detail "${key}".`);
  } else if (type === 'study') {
    const minutes = values.minutesPerDay;
    if (!Number.isInteger(minutes) || (minutes as number) < 1 || (minutes as number) > 1440) issues.push('Daily study time must be a whole number of minutes from 1 to 1440.');
    if (values.scripture !== undefined && (typeof values.scripture !== 'string' || values.scripture.length > 120)) issues.push('The scripture name must be text of at most 120 characters.');
    for (const key of Object.keys(values)) if (key !== 'minutesPerDay' && key !== 'scripture') issues.push(`Unknown study detail "${key}".`);
  } else if (Object.keys(values).length > 0) issues.push(`${VOW_TYPE_LABELS[type]} has no extra details.`);
  return issues;
}

/** Checks fields only. Cross-vow rules (Japa conflicts) are in `japaConflicts`. */
export function validateVowFields(input: VowInput): string[] {
  const issues: string[] = [];
  if (!(VOW_TYPES as readonly string[]).includes(input.type)) issues.push('Choose one of the six seasonal vow types.');
  if (typeof input.seasonName !== 'string' || !input.seasonName.trim() || input.seasonName.length > 80) issues.push('Give the season a name of up to 80 characters.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) issues.push('Give the commitment a name of up to 120 characters.');
  if (!isValidDate(input.startDate)) issues.push('The start date is not a real calendar date.');
  if (!isValidDate(input.endDate)) issues.push('The end date is not a real calendar date.');
  if (isValidDate(input.startDate) && isValidDate(input.endDate) && input.startDate > input.endDate) issues.push('The end date cannot be before the start date.');
  if ((VOW_TYPES as readonly string[]).includes(input.type)) issues.push(...validateConfig(input.type, input.config));
  return issues;
}

export function japaTargetOf(vow: SeasonalVow): number | null {
  return vow.type === 'japa' && typeof (vow.config as JapaConfig).targetRounds === 'number' ? (vow.config as JapaConfig).targetRounds : null;
}

/** Active Japa vows that overlap `vow` in time and ask for a DIFFERENT daily target. Identical targets are not a conflict. */
export function japaConflicts(vow: SeasonalVow, others: SeasonalVow[]): SeasonalVow[] {
  if (vow.type !== 'japa') return [];
  const mine = japaTargetOf(vow);
  return others.filter((other) => other.id !== vow.id && other.type === 'japa' && other.status === 'active' && rangesOverlap(vow, other) && japaTargetOf(other) !== mine);
}
export function describeConflict(vow: SeasonalVow, conflicts: SeasonalVow[]): string {
  const list = conflicts.map((other) => `"${other.name}" (${japaTargetOf(other)} rounds, ${other.startDate} to ${effectiveEnd(other)})`).join(', ');
  return `"${vow.name}" asks for ${japaTargetOf(vow)} rounds from ${vow.startDate} to ${effectiveEnd(vow)}, which overlaps ${list} with a different daily target. Only one seasonal Japa target can apply on a day, so change the dates or pause the other commitment first.`;
}

// --- building and changing vows ------------------------------------------------------------------------------------------

export interface Context { today: string; now: string }

/** New vows start as drafts; activating is a separate, checked step. */
export function createVow(id: string, input: VowInput, ctx: Context): SeasonalVow {
  const issues = validateVowFields(input);
  if (issues.length) throw new SeasonalError(issues);
  return {
    id, type: input.type, seasonName: input.seasonName.trim(), name: input.name.trim(), startDate: input.startDate, endDate: input.endDate,
    status: 'draft', config: normaliseConfig(input.type, input.config), configVersion: SEASONAL_FORMAT_VERSION, createdAt: ctx.now, updatedAt: ctx.now,
  };
}
function normaliseConfig(type: VowType, config: VowConfig): VowConfig {
  if (type === 'japa') { const japa = config as JapaConfig; return japa.morningCutoff ? { targetRounds: japa.targetRounds, morningCutoff: japa.morningCutoff } : { targetRounds: japa.targetRounds }; }
  if (type === 'study') { const study = config as StudyConfig; return study.scripture?.trim() ? { minutesPerDay: study.minutesPerDay, scripture: study.scripture.trim() } : { minutesPerDay: study.minutesPerDay }; }
  return {};
}

/** Draft, active and paused vows can be edited; the type, id and creation time never change. Completed and archived vows are read-only history. */
export function editVow(vow: SeasonalVow, patch: Partial<Omit<VowInput, 'type'>>, others: SeasonalVow[], ctx: Context): SeasonalVow {
  if (vow.status === 'completed' || vow.status === 'archived') throw new SeasonalError([`A ${vow.status} commitment is kept as history and cannot be edited.`]);
  const merged: VowInput = { type: vow.type, seasonName: patch.seasonName ?? vow.seasonName, name: patch.name ?? vow.name, startDate: patch.startDate ?? vow.startDate, endDate: patch.endDate ?? vow.endDate, config: patch.config ?? vow.config };
  const issues = validateVowFields(merged);
  if (issues.length) throw new SeasonalError(issues);
  const next: SeasonalVow = { ...vow, seasonName: merged.seasonName.trim(), name: merged.name.trim(), startDate: merged.startDate, endDate: merged.endDate, config: normaliseConfig(vow.type, merged.config), updatedAt: ctx.now };
  if (next.endedOn && next.endedOn > next.endDate) delete next.endedOn;
  if (next.status === 'active') { const conflicts = japaConflicts(next, others); if (conflicts.length) throw new SeasonalError([describeConflict(next, conflicts)]); }
  return next;
}

export type VowAction = 'activate' | 'pause' | 'resume' | 'complete' | 'archive';
/** Lifecycle. None of these deletes anything; permanent deletion is a separate confirmed operation. */
export function transitionVow(vow: SeasonalVow, action: VowAction, others: SeasonalVow[], ctx: Context): SeasonalVow {
  const fail = (message: string): never => { throw new SeasonalError([message]); };
  const next: SeasonalVow = { ...vow, updatedAt: ctx.now };
  switch (action) {
    case 'activate':
    case 'resume': {
      if (action === 'activate' && vow.status !== 'draft') fail('Only a draft can be activated.');
      if (action === 'resume' && vow.status !== 'paused') fail('Only a paused commitment can be resumed.');
      if (validateVowFields({ type: vow.type, seasonName: vow.seasonName, name: vow.name, startDate: vow.startDate, endDate: vow.endDate, config: vow.config }).length) fail('Fix the commitment details before activating it.');
      next.status = 'active';
      const conflicts = japaConflicts(next, others);
      if (conflicts.length) fail(describeConflict(next, conflicts));
      return next;
    }
    case 'pause':
      if (vow.status !== 'active') fail('Only an active commitment can be paused.');
      next.status = 'paused'; return next;
    case 'complete': {
      if (vow.status !== 'active' && vow.status !== 'paused') fail('Only an active or paused commitment can be completed.');
      if (ctx.today < vow.startDate) fail('This commitment has not started yet. Archive it instead, or delete it if it was a mistake.');
      next.status = 'completed';
      next.endedOn = ctx.today < vow.endDate ? ctx.today : vow.endDate;
      return next;
    }
    case 'archive':
      if (vow.status === 'active') fail('Pause or complete an active commitment before archiving it.');
      if (vow.status === 'archived') fail('This commitment is already archived.');
      next.status = 'archived'; return next;
  }
}

/** The phase shown to the user, derived from dates and status. Active vows whose dates have passed read as "ended" without any stored change. */
export type VowPhase = 'draft' | 'upcoming' | 'in-season' | 'ended' | 'paused' | 'completed' | 'archived';
export function vowPhase(vow: SeasonalVow, today: string): VowPhase {
  if (vow.status !== 'active') return vow.status;
  if (today < vow.startDate) return 'upcoming';
  return today > effectiveEnd(vow) ? 'ended' : 'in-season';
}

// --- Japa precedence and history -------------------------------------------------------------------------------------------

export function isJapaInForce(vow: SeasonalVow, date: string): boolean {
  return vow.type === 'japa' && vow.status === 'active' && japaTargetOf(vow) !== null && dateInRange(vow, date);
}

export type JapaResolution =
  | { source: 'regular'; rounds: number }
  | { source: 'seasonal'; rounds: number; vowId: string; vowName: string }
  | { source: 'regular'; rounds: number; conflict: { vowIds: string[]; targets: number[] } };

/**
 * The target that applies on `date`. Regular unless exactly one seasonal Japa target is in force. If active vows disagree
 * (possible only through bad imported data, since creating or activating one is refused) the regular target stays and the
 * conflict is reported: one is never silently chosen. Vows with the same target resolve to that target, attributed to the earliest-created.
 */
export function resolveJapaTarget(date: string, regularTarget: number, vows: SeasonalVow[]): JapaResolution {
  const inForce = vows.filter((vow) => isJapaInForce(vow, date)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (inForce.length === 0) return { source: 'regular', rounds: regularTarget };
  const targets = [...new Set(inForce.map((vow) => japaTargetOf(vow) as number))];
  if (targets.length > 1) return { source: 'regular', rounds: regularTarget, conflict: { vowIds: inForce.map((vow) => vow.id), targets } };
  return { source: 'seasonal', rounds: targets[0], vowId: inForce[0].id, vowName: inForce[0].name };
}

/**
 * The morning cutoff that goes with a resolved target: the in-force seasonal commitment's own cutoff when it is a valid time, otherwise the
 * 07:00 default. Regular days, conflicting commitments (which fall back to the regular target) and commitments with a missing or unreadable
 * cutoff all use the default, so the result is always a valid "HH:MM".
 */
export function resolveJapaCutoff(resolution: JapaResolution, vows: SeasonalVow[]): string {
  if (resolution.source !== 'seasonal') return DEFAULT_MORNING_CUTOFF;
  const vow = vows.find((candidate) => candidate.id === resolution.vowId);
  const cutoff = vow ? (vow.config as JapaConfig).morningCutoff : undefined;
  return isClockTime(cutoff) ? cutoff : DEFAULT_MORNING_CUTOFF;
}

/**
 * What to store on a Sādhana row as its target snapshot when saving.
 *  - Open day (today or later): follows the live rule, so editing a season today is reflected today.
 *  - Closed day with a snapshot: unchanged forever, whatever happens to the vow later (including a missing cutoff, which is never back-filled).
 *  - Closed day, brand-new row (the user is filling in a past day now): the live rule at the moment of entry, target and cutoff alike.
 *  - Closed day, row saved before this feature (no snapshot): `undefined`. It is never rewritten or guessed.
 */
export function targetSnapshotForSave(args: { existing?: TargetSnapshot; isNewRow: boolean; date: string; today: string; regularTarget: number; resolution: JapaResolution; cutoff?: string }): TargetSnapshot | undefined {
  const { existing, isNewRow, date, today, regularTarget, resolution, cutoff } = args;
  // The applicable cutoff is stored with every NEW or refreshed (open-day) snapshot when the caller supplies it; an unreadable one is stored as the default.
  // Closed days with a snapshot return `existing` untouched below, so an older snapshot is never rewritten just to add this field.
  const withCutoff = (): { morningCutoff?: string } => cutoff === undefined ? {} : { morningCutoff: isClockTime(cutoff) ? cutoff : DEFAULT_MORNING_CUTOFF };
  const live = (): TargetSnapshot => resolution.source === 'seasonal' ? { rounds: resolution.rounds, source: 'seasonal', vowId: resolution.vowId, vowName: resolution.vowName, ...withCutoff() } : { rounds: regularTarget, source: 'regular', ...withCutoff() };
  if (date >= today) return live();
  if (existing) return existing;
  return isNewRow ? live() : undefined;
}

/**
 * The target to show for a day. On a CLOSED day (before today) its snapshot wins, and a past row without one keeps the regular target it was saved with (never guessed).
 * A day with no row yet, and every OPEN day (today or later), uses the live rule.
 */
export function effectiveTargetFor(record: { date: string; targetRounds: number; targetSnapshot?: TargetSnapshot } | null, date: string, today: string, regularTarget: number, vows: SeasonalVow[]): { rounds: number; source: 'regular' | 'seasonal' | 'regular-unrecorded'; vowId?: string; vowName?: string; morningCutoff?: string; conflict?: { vowIds: string[]; targets: number[] } } {
  // Only a CLOSED day is frozen. An open day (today or later) follows the live rule, exactly as targetSnapshotForSave refreshes it on save,
  // so pausing or deleting a commitment today is reflected today instead of a stale snapshot lingering.
  if (record?.targetSnapshot && date < today) return { ...record.targetSnapshot };
  if (record && date < today) return { rounds: record.targetRounds, source: 'regular-unrecorded' };
  const live = resolveJapaTarget(date, record?.targetRounds ?? regularTarget, vows);
  return live.source === 'seasonal' ? { rounds: live.rounds, source: 'seasonal', vowId: live.vowId, vowName: live.vowName } : { rounds: live.rounds, source: 'regular', ...('conflict' in live ? { conflict: live.conflict } : {}) };
}

export interface JapaDayContext {
  /** The regular target for the day (the Sādhana row's own `targetRounds`; never changed by a season). */
  regularRounds: number;
  /** The target to show and measure against for the day. */
  rounds: number;
  source: 'regular' | 'seasonal' | 'regular-unrecorded';
  vowId?: string;
  vowName?: string;
  conflict?: { vowIds: string[]; targets: number[] };
  /** "HH:MM". The time the day's "early rounds" are counted against. */
  morningCutoff: string;
  cutoffSource: 'seasonal' | 'default';
  /** Set when a seasonal commitment applied to a day that has already ended but its cutoff was not saved with the day (an older record), so the default is shown. */
  cutoffNote: string | null;
}

export const CLOSED_DAY_CUTOFF_NOTE = 'A seasonal commitment applied on this day, but the morning cutoff it used was not saved with the day, so 7:00 AM is shown. Nothing is guessed.';

/**
 * Everything the Sādhana screen needs to know about the Japa target for one day, from the same rules the overview uses.
 *
 * Target: exactly `effectiveTargetFor` (closed days show their snapshot, open days follow the live rule, conflicts fall back to the regular target).
 *
 * Morning cutoff:
 *  - TODAY, FUTURE days, and a PAST day that has not been recorded yet (no row): the applicable seasonal Japa commitment's `morningCutoff` while that
 *    commitment applies; the default (07:00) otherwise. For the unrecorded past day this is exactly what saving it will store, so there is no flip and no note.
 *  - RECORDED past days (a row exists): the cutoff stored in the day's own snapshot when it is a valid time, so later edits, pauses, completion or
 *    deletion of the commitment can never change it. A snapshot saved before cutoffs were stored (or holding an unreadable value) shows the default,
 *    with a note when a seasonal commitment applied. Nothing is guessed or back-filled.
 */
export function japaDayContext(record: { date: string; targetRounds: number; targetSnapshot?: TargetSnapshot } | null, date: string, today: string, regularTarget: number, vows: SeasonalVow[]): JapaDayContext {
  const target = effectiveTargetFor(record, date, today, regularTarget, vows);
  const context: JapaDayContext = {
    regularRounds: record?.targetRounds ?? regularTarget, rounds: target.rounds, source: target.source, vowId: target.vowId, vowName: target.vowName, conflict: target.conflict,
    morningCutoff: DEFAULT_MORNING_CUTOFF, cutoffSource: 'default', cutoffNote: null,
  };
  if (date < today && record) {
    // A RECORDED past day is frozen: its own stored cutoff, never a live value.
    const stored = record.targetSnapshot?.morningCutoff;
    if (record.targetSnapshot && isClockTime(stored)) return { ...context, morningCutoff: stored, cutoffSource: target.source === 'seasonal' ? 'seasonal' : 'default' };
    return target.source === 'seasonal' ? { ...context, cutoffNote: CLOSED_DAY_CUTOFF_NOTE } : context;
  }
  // From here: today, future days, and a past day that has NOT been recorded yet (no row). The last one is what saving will store, so it uses the
  // live rule and shows no "not saved" note: nothing has been saved to be missing anything.
  if (target.source !== 'seasonal') return context;
  const vow = vows.find((candidate) => candidate.id === target.vowId);
  const cutoff = vow ? (vow.config as JapaConfig).morningCutoff : undefined;
  return isClockTime(cutoff) ? { ...context, morningCutoff: cutoff, cutoffSource: 'seasonal' } : context;
}

// --- daily activity -----------------------------------------------------------------------------------------------------------

export const logIdFor = (vowId: string, date: string): string => `${vowId}|${date}`;
export const needsExplicitLog = (type: VowType): boolean => DAILY_LOG_TYPES.includes(type);

export type LogEntry = { completed: boolean } | { abstinence: AbstinenceStatus };

/** Whether a day can be logged: inside the vow's dates, and the vow is active (or was completed by the user, up to its end). Paused, draft and archived vows take no new logs. */
export function loggingBlockedReason(vow: SeasonalVow, date: string, today: string): string | null {
  if (!needsExplicitLog(vow.type)) return `${VOW_TYPE_LABELS[vow.type]} progress comes from your saved ${vow.type === 'japa' ? 'Sādhana record' : 'Study sessions'}, so there is nothing to log here.`;
  if (!isValidDate(date)) return 'That is not a real calendar date.';
  if (vow.status === 'paused') return 'This commitment is paused. Resume it to log activity.';
  if (vow.status === 'draft') return 'Activate this commitment before logging activity.';
  if (vow.status === 'archived') return 'Archived commitments are kept for review only.';
  if (!dateInRange(vow, date)) return 'That date is outside this commitment’s dates.';
  if (date > today) return 'Future days cannot be logged yet.';
  return null;
}

/** Creates or updates the single log for (vow, date). The snapshot is taken once, when the day is first logged, and never changes afterwards. */
export function buildVowLog(args: { vow: SeasonalVow; date: string; entry: LogEntry; existing?: VowLog; ctx: Context }): VowLog {
  const { vow, date, entry, existing, ctx } = args;
  const blocked = loggingBlockedReason(vow, date, ctx.today);
  if (blocked) throw new SeasonalError([blocked]);
  if (vow.type === 'abstinence') {
    const status = (entry as { abstinence?: AbstinenceStatus }).abstinence;
    if (status !== 'observed' && status !== 'not-today' && status !== 'unrecorded') throw new SeasonalError(['Choose Observed, Not today or Unrecorded.']);
  } else if (typeof (entry as { completed?: unknown }).completed !== 'boolean') throw new SeasonalError(['Record whether this was done.']);
  const base = { id: logIdFor(vow.id, date), vowId: vow.id, date, type: vow.type };
  const snapshot = existing?.snapshot ?? { name: vow.name, seasonName: vow.seasonName, config: { ...vow.config } as VowConfig };
  const log: VowLog = vow.type === 'abstinence'
    ? { ...base, abstinence: (entry as { abstinence: AbstinenceStatus }).abstinence, snapshot, createdAt: existing?.createdAt ?? ctx.now, updatedAt: ctx.now }
    : { ...base, completed: (entry as { completed: boolean }).completed, snapshot, createdAt: existing?.createdAt ?? ctx.now, updatedAt: ctx.now };
  return log;
}

interface SessionLike { id?: number; date: string; kind: string; title: string; topic?: string; minutes: number }
/** Minutes from saved Study sessions on `date`, each session counted once (by id). With a scripture set, only sessions whose title or topic mentions it count. */
export function studyProgress(vow: SeasonalVow, date: string, sessions: SessionLike[]): { minutes: number; target: number; sessionCount: number } {
  const target = vow.type === 'study' ? (vow.config as StudyConfig).minutesPerDay : 0;
  const scripture = vow.type === 'study' ? (vow.config as StudyConfig).scripture?.toLowerCase() : undefined;
  const seen = new Set<string>(); let minutes = 0;
  for (const [index, session] of sessions.entries()) {
    if (session.date !== date || session.kind !== 'Study') continue;
    if (scripture && !`${session.title} ${session.topic ?? ''}`.toLowerCase().includes(scripture)) continue;
    const key = session.id !== undefined ? `id:${session.id}` : `idx:${index}`;
    if (seen.has(key)) continue;
    seen.add(key); minutes += session.minutes;
  }
  return { minutes, target, sessionCount: seen.size };
}

/** Rounds recorded for the day against the target that applied to that day (its snapshot, else the stored regular target). */
export function japaProgress(record: { rounds: number; targetRounds: number; targetSnapshot?: TargetSnapshot } | null): { rounds: number; target: number; source: 'regular' | 'seasonal' } | null {
  if (!record) return null;
  return { rounds: record.rounds, target: record.targetSnapshot?.rounds ?? record.targetRounds, source: record.targetSnapshot?.source ?? 'regular' };
}

/** Dates (up to today and the vow's end) with any recorded activity for this vow. Neutral: missing days are not failures and there is no streak. */
export function daysWithRecordedActivity(args: { vow: SeasonalVow; today: string; logs: VowLog[]; sessions: SessionLike[]; sadhana: { date: string; rounds: number }[] }): string[] {
  const { vow, today, logs, sessions, sadhana } = args;
  const last = today < effectiveEnd(vow) ? today : effectiveEnd(vow);
  const mine = new Map(logs.filter((log) => log.vowId === vow.id).map((log) => [log.date, log]));
  return datesBetween(vow.startDate, last).filter((date) => {
    if (vow.type === 'japa') return sadhana.some((row) => row.date === date && row.rounds > 0);
    if (vow.type === 'study') return studyProgress(vow, date, sessions).minutes > 0;
    const log = mine.get(date);
    return vow.type === 'abstinence' ? log?.abstinence === 'observed' : log?.completed === true;
  });
}
