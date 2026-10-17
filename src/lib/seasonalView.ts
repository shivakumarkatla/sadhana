/**
 * View-model helpers for the Seasonal Saṅkalpa screen: form validation, form <-> model conversion, grouping and small lookups.
 * Pure (no React, no Dexie) so the form rules are unit-tested with `node --test`. Erasable TypeScript only.
 * The authoritative rules stay in seasonal.ts; the service re-validates everything, so this only gives friendly, per-field messages.
 */
import {
  DEFAULT_MORNING_CUTOFF, MAX_JAPA_TARGET, MIN_JAPA_TARGET, effectiveEnd, isClockTime, isValidDate, japaDayContext,
  type JapaConfig, type JapaDayContext, type SeasonalVow, type StudyConfig, type TargetSnapshot, type VowConfig, type VowInput, type VowType,
} from './seasonal.ts';

export const DEFAULT_REGULAR_TARGET = 16; // same default the Sādhana screen uses

export interface VowFormValues {
  type: VowType; seasonName: string; name: string; startDate: string; endDate: string;
  targetRounds: string; morningCutoff: string; minutesPerDay: string; scripture: string;
}
export type VowFormField = Exclude<keyof VowFormValues, 'type'>;
export type VowFormErrors = Partial<Record<VowFormField, string>>;
export const FORM_FIELD_ORDER: VowFormField[] = ['seasonName', 'name', 'startDate', 'endDate', 'targetRounds', 'morningCutoff', 'minutesPerDay', 'scripture'];

/** Dates are deliberately left empty: the user supplies every date, nothing is assumed or prefilled. */
export function emptyForm(type: VowType = 'japa', seasonName = ''): VowFormValues {
  return { type, seasonName, name: '', startDate: '', endDate: '', targetRounds: '', morningCutoff: DEFAULT_MORNING_CUTOFF, minutesPerDay: '', scripture: '' };
}

export function formFromVow(vow: SeasonalVow): VowFormValues {
  const japa = vow.type === 'japa' ? (vow.config as JapaConfig) : null;
  const study = vow.type === 'study' ? (vow.config as StudyConfig) : null;
  return {
    type: vow.type, seasonName: vow.seasonName, name: vow.name, startDate: vow.startDate, endDate: vow.endDate,
    targetRounds: japa ? String(japa.targetRounds) : '', morningCutoff: japa?.morningCutoff ?? DEFAULT_MORNING_CUTOFF,
    minutesPerDay: study ? String(study.minutesPerDay) : '', scripture: study?.scripture ?? '',
  };
}

const WHOLE_NUMBER = /^\d{1,6}$/;

export function validateVowForm(values: VowFormValues): VowFormErrors {
  const errors: VowFormErrors = {};
  const season = values.seasonName.trim(); const name = values.name.trim();
  if (!season) errors.seasonName = 'Give this season a name.'; else if (season.length > 80) errors.seasonName = 'Use 80 characters or fewer.';
  if (!name) errors.name = 'Give this commitment a name.'; else if (name.length > 120) errors.name = 'Use 120 characters or fewer.';
  if (!values.startDate) errors.startDate = 'Enter the start date.'; else if (!isValidDate(values.startDate)) errors.startDate = 'That is not a real calendar date.';
  if (!values.endDate) errors.endDate = 'Enter the end date.'; else if (!isValidDate(values.endDate)) errors.endDate = 'That is not a real calendar date.';
  else if (isValidDate(values.startDate) && values.endDate < values.startDate) errors.endDate = 'The end date cannot be before the start date.';
  if (values.type === 'japa') {
    const target = values.targetRounds.trim();
    if (!WHOLE_NUMBER.test(target) || Number(target) < MIN_JAPA_TARGET || Number(target) > MAX_JAPA_TARGET) errors.targetRounds = `Enter a whole number from ${MIN_JAPA_TARGET} to ${MAX_JAPA_TARGET}.`;
    if (!isClockTime(values.morningCutoff)) errors.morningCutoff = 'Enter a time such as 07:00.';
  }
  if (values.type === 'study') {
    const minutes = values.minutesPerDay.trim();
    if (!WHOLE_NUMBER.test(minutes) || Number(minutes) < 1 || Number(minutes) > 1440) errors.minutesPerDay = 'Enter whole minutes from 1 to 1440.';
    if (values.scripture.trim().length > 120) errors.scripture = 'Use 120 characters or fewer.';
  }
  return errors;
}

/** Call only after `validateVowForm` returned no errors. */
export function vowFormToInput(values: VowFormValues): VowInput {
  let config: VowConfig = {};
  if (values.type === 'japa') config = { targetRounds: Number(values.targetRounds.trim()), morningCutoff: values.morningCutoff };
  else if (values.type === 'study') config = values.scripture.trim() ? { minutesPerDay: Number(values.minutesPerDay.trim()), scripture: values.scripture.trim() } : { minutesPerDay: Number(values.minutesPerDay.trim()) };
  return { type: values.type, seasonName: values.seasonName.trim(), name: values.name.trim(), startDate: values.startDate, endDate: values.endDate, config };
}

/** The regular daily target for a date, found the same way the Sādhana screen finds it: that day's row, else the latest earlier row, else the default. */
export function regularTargetFor(date: string, rows: { date: string; targetRounds: number }[]): number {
  const exact = rows.find((row) => row.date === date);
  if (exact) return exact.targetRounds;
  const earlier = rows.filter((row) => row.date < date).sort((a, b) => b.date.localeCompare(a.date))[0];
  return earlier?.targetRounds || DEFAULT_REGULAR_TARGET;
}

/** "07:00" -> "7:00 AM", "19:30" -> "7:30 PM". */
export function clock12(value: string): string {
  if (!isClockTime(value)) return value;
  const [hour, minute] = value.split(':').map(Number);
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

export interface VowGroups { active: SeasonalVow[]; drafts: SeasonalVow[]; paused: SeasonalVow[]; history: SeasonalVow[] }
export function groupVows(vows: SeasonalVow[]): VowGroups {
  const byStart = (a: SeasonalVow, b: SeasonalVow) => a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name);
  return {
    active: vows.filter((vow) => vow.status === 'active').sort(byStart),
    drafts: vows.filter((vow) => vow.status === 'draft').sort(byStart),
    paused: vows.filter((vow) => vow.status === 'paused').sort(byStart),
    history: vows.filter((vow) => vow.status === 'completed' || vow.status === 'archived').sort((a, b) => effectiveEnd(b).localeCompare(effectiveEnd(a)) || a.name.localeCompare(b.name)),
  };
}

/** Season names the user has already used, for the form's suggestions. */
export function knownSeasonNames(vows: SeasonalVow[]): string[] {
  return [...new Set(vows.map((vow) => vow.seasonName))].sort((a, b) => a.localeCompare(b));
}

/** Plain-language difference between a seasonal and the regular target, with no judgement attached. */
export function targetDifference(seasonal: number, regular: number): string {
  if (seasonal === regular) return 'the same as your regular target';
  const gap = Math.abs(seasonal - regular);
  return `${gap} ${gap === 1 ? 'round' : 'rounds'} ${seasonal > regular ? 'above' : 'below'} your regular target`;
}

/**
 * The wording shown when active seasonal Japa commitments disagree about a day's target. The regular target is used and neither commitment is
 * chosen. Shared by the Sādhana and Today screens so the two can never describe a conflict differently.
 */
export function japaConflictMessage(context: Pick<JapaDayContext, 'conflict' | 'regularRounds'>, where: 'sadhana' | 'today' | 'insights'): string {
  const targets = context.conflict ? context.conflict.targets.join(' and ') : '';
  const open = where === 'today' ? 'Open Seasonal Saṅkalpa below to pause or change one.' : 'Open Seasonal Saṅkalpa from Today to pause or change one.';
  return `More than one active seasonal Japa commitment covers this day with different targets (${targets} rounds), so your regular target of ${context.regularRounds} rounds is used. ${open}`;
}

export interface TodayJapaText {
  /** Text of the small badge beside the Japa heading. */
  badge: string;
  /** Short explanation when a seasonal target applies; null otherwise. */
  note: string | null;
  /** Conflict explanation; null when there is no conflict. */
  conflict: string | null;
  /** "7:00 AM"-style label for the early-rounds line. */
  cutoffLabel: string;
}

/**
 * What the Today dashboard says about the Japa target and cutoff, derived purely from the shared day context (`japaDayContext`).
 * Today is always an open day, so the context is the live rule: it never reads a stored snapshot and never carries the older-record cutoff note.
 */
export function todayJapaText(context: JapaDayContext): TodayJapaText {
  const seasonal = context.source === 'seasonal';
  return {
    badge: `${seasonal ? 'Saṅkalpa target' : 'Target'} ${context.rounds} rounds`,
    note: seasonal ? `Set by your Saṅkalpa, “${context.vowName}”. Your regular target of ${context.regularRounds} rounds is unchanged.` : null,
    conflict: context.conflict ? japaConflictMessage(context, 'today') : null,
    cutoffLabel: clock12(context.morningCutoff),
  };
}

export interface InsightsJapaInput { date: string; rounds: number; earlyRounds: number; targetRounds: number; targetSnapshot?: TargetSnapshot }
export interface InsightsJapaDay { date: string; rounds: number; earlyRounds: number; target: number; source: JapaDayContext['source']; cutoff: string; olderSeasonalDay: boolean }
export interface InsightsJapa {
  days: InsightsJapaDay[];
  /** Recorded days whose rounds reached THAT DAY'S target (its stored snapshot for closed days, the live rule for today). */
  targetMet: number;
  /** Recorded days measured against a seasonal target. */
  seasonalDays: number;
  targetMin: number | null; targetMax: number | null; targetVaries: boolean;
  /** The single target when every recorded day shares one; undefined when targets differ or there are no days. */
  targetLine: number | undefined;
  /** Distinct "HH:MM" cutoffs across the recorded days, sorted. */
  cutoffs: string[];
  /** "6:30 AM" when every recorded day shares one cutoff; null when they differ or there are no days. */
  cutoffLabel: string | null;
  /** Recorded days that used a seasonal commitment before its cutoff was saved: shown with the 7:00 AM fallback and an explanatory note. */
  olderSeasonalDays: number;
  /** The first day (today) whose seasonal Japa commitments conflict, if any; the regular target was used for it. */
  conflict: JapaDayContext | null;
}

/**
 * Per-day targets and cutoffs for the days Insights counts as recorded (rounds > 0), from the same `japaDayContext` the Sādhana screen and Today use:
 * closed days report their own stored snapshot, today follows the live rule, legacy rows keep their saved regular target and the 7:00 AM fallback.
 * Days that are not recorded are never passed in, so a missing day stays missing: nothing is estimated or turned into zero.
 */
export function japaInsights(recorded: InsightsJapaInput[], today: string, vows: SeasonalVow[]): InsightsJapa {
  const days: InsightsJapaDay[] = []; let conflict: JapaDayContext | null = null; let olderSeasonalDays = 0;
  for (const row of recorded) {
    const context = japaDayContext({ date: row.date, targetRounds: row.targetRounds, targetSnapshot: row.targetSnapshot }, row.date, today, row.targetRounds, vows);
    if (context.conflict && !conflict) conflict = context;
    if (context.cutoffNote) olderSeasonalDays += 1;
    days.push({ date: row.date, rounds: row.rounds, earlyRounds: row.earlyRounds, target: context.rounds, source: context.source, cutoff: context.morningCutoff, olderSeasonalDay: context.cutoffNote !== null });
  }
  const targets = [...new Set(days.map((day) => day.target))].sort((a, b) => a - b);
  const cutoffs = [...new Set(days.map((day) => day.cutoff))].sort();
  return {
    days, targetMet: days.filter((day) => day.rounds >= day.target).length, seasonalDays: days.filter((day) => day.source === 'seasonal').length,
    targetMin: targets.length ? targets[0] : null, targetMax: targets.length ? targets[targets.length - 1] : null, targetVaries: targets.length > 1,
    targetLine: targets.length === 1 ? targets[0] : undefined, cutoffs, cutoffLabel: cutoffs.length === 1 ? clock12(cutoffs[0]) : null, olderSeasonalDays, conflict,
  };
}
