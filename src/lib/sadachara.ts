/**
 * Sādācāra monthly reflection: pure rules (no Dexie, no DOM), testable with `node --test`. Erasable TypeScript only.
 *
 * What lives where:
 *  - The numeric ratings (0–10, or unanswered) are stored in the plain `sadacharaAssessments` store, one record per month, id = `YYYY-MM`.
 *  - EVERY written answer (the six per-area notes and the four private prompts) is encrypted and stored only in `privateContent`
 *    (kind `sadachara`, refId `YYYY-MM:<field>`) through the existing private diary. Nothing written is ever part of an assessment record,
 *    a share report or a log line.
 */

export const SADACHARA_KIND = 'sadachara';

export interface SadacharaArea { id: string; title: string; subtitle: string; description: string }

/** The six agreed areas, in the wording of the design reference. Sleep is intentionally not one of them. */
export const SADACHARA_AREAS: readonly SadacharaArea[] = [
  { id: 'equals', title: 'Relationship with Equals', subtitle: 'Bhakta-saṅga', description: 'Amity, freedom from envious competition, respect, and cooperation with peers.' },
  { id: 'seniors', title: 'Relationship with Seniors', subtitle: 'Guru & Elders', description: 'Servant attitude, receptive hearing, submissiveness, and honoring their instructions.' },
  { id: 'juniors', title: 'Relationship with Juniors', subtitle: 'Juniors & Newcomers', description: 'Affection, encouragement, patience, and non-contentious dignity.' },
  { id: 'interaction', title: 'Avoidance of Inappropriate Interaction', subtitle: 'Purity & Modesty', description: 'Guardianship of the senses, respectful distance, modesty, and purity in speech and conduct.' },
  { id: 'health', title: 'Health', subtitle: 'Body as Temple of Service', description: 'Prasādam moderation, physical cleanliness, and being fit for unhampered devotional service.' },
  { id: 'service', title: 'Service Attitude', subtitle: 'Seva Bhāva', description: 'Eagerness to serve without seeking personal recognition, prestige, or convenience.' },
] as const;

export type AreaId = 'equals' | 'seniors' | 'juniors' | 'interaction' | 'health' | 'service';

export interface SadacharaPrompt { id: string; title: string; placeholder: string }
/** The four private prompts. Titles come from the design reference; the example placeholders are read from a small mockup and may differ slightly from the final design. */
export const SADACHARA_PROMPTS: readonly SadacharaPrompt[] = [
  { id: 'struggles', title: 'Struggles in Kṛṣṇa consciousness', placeholder: 'e.g., mental agitation during japa, lapses in humility, attachment to phones.' },
  { id: 'family', title: 'Difficulties with parents or relatives', placeholder: 'e.g., family friction regarding devotional standards, prasādam, or time for seva.' },
  { id: 'improve', title: 'What I want to improve next month', placeholder: 'e.g., rising at 4:00 AM, avoiding criticism, reading Śrīmad-Bhāgavatam daily.' },
  { id: 'support', title: 'What support or guidance would help me?', placeholder: 'e.g., mentorship or guidance on …' },
] as const;

export const PROMPT_IDS: readonly string[] = SADACHARA_PROMPTS.map((prompt) => prompt.id);
export const AREA_IDS: readonly string[] = SADACHARA_AREAS.map((area) => area.id);

/** Text fields: `area:<areaId>` is the optional per-area reflection, `prompt:<promptId>` is one of the four private prompts. */
export const textFieldFor = (kind: 'area' | 'prompt', id: string): string => `${kind}:${id}`;
export const isTextField = (field: string): boolean => {
  const [kind, id] = field.split(':');
  return (kind === 'area' && AREA_IDS.includes(id)) || (kind === 'prompt' && PROMPT_IDS.includes(id));
};
export const ALL_TEXT_FIELDS: readonly string[] = [...AREA_IDS.map((id) => textFieldFor('area', id)), ...PROMPT_IDS.map((id) => textFieldFor('prompt', id))];

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isValidMonth = (value: unknown): value is string => typeof value === 'string' && MONTH_PATTERN.test(value);
export const monthOf = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
export const currentMonth = (now: Date = new Date()): string => monthOf(now);
export function shiftMonth(month: string, delta: number): string {
  const [year, number] = month.split('-').map(Number);
  const index = year * 12 + (number - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthLabel = (month: string): string => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
/** Private-content ref for one written answer of one month. */
export const refIdFor = (month: string, field: string): string => `${month}:${field}`;
/** Draft slot used by the diary draft store (`kind:refId`). */
export const draftSlotFor = (month: string, field: string): string => `${SADACHARA_KIND}:${refIdFor(month, field)}`;

export type Rating = number | null;
export type SadacharaStatus = 'in-progress' | 'complete';
export interface SadacharaAssessment {
  /** The month, `YYYY-MM`. One assessment per month: the id is the month, so a second save can only replace the first. */
  id: string;
  month: string;
  /** Every area is present; `null` means "not answered", which is different from a rating of 0. */
  ratings: Record<string, Rating>;
  status: SadacharaStatus;
  createdAt: string;
  updatedAt: string;
}

export const isRating = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 10;
export const blankRatings = (): Record<string, Rating> => Object.fromEntries(AREA_IDS.map((id) => [id, null]));

/** Sets one rating. Anything that is not a whole number from 0 to 10 (including undefined) means "not answered", never 0. */
export function withRating(ratings: Record<string, Rating>, areaId: string, value: unknown): Record<string, Rating> {
  if (!AREA_IDS.includes(areaId)) throw new Error('Unknown area.');
  return { ...ratings, [areaId]: isRating(value) ? value : null };
}

export const answeredCount = (ratings: Record<string, Rating>): number => AREA_IDS.filter((id) => isRating(ratings[id])).length;
export const isComplete = (ratings: Record<string, Rating>): boolean => answeredCount(ratings) === AREA_IDS.length;

/** Average of the ANSWERED areas only (one decimal). Unanswered areas are skipped, never counted as zero. null when nothing is answered. */
export function averageRating(ratings: Record<string, Rating>): number | null {
  const answered = AREA_IDS.map((id) => ratings[id]).filter(isRating);
  if (!answered.length) return null;
  return Math.round((answered.reduce((sum, value) => sum + value, 0) / answered.length) * 10) / 10;
}

/** Descriptive band for a rating, from the design's evaluation guide (0–3 Much Room, 4–6 Average, 7–10 Excellent). */
export const ratingBand = (value: number): 'Much room' | 'Average' | 'Excellent' => (value <= 3 ? 'Much room' : value <= 6 ? 'Average' : 'Excellent');

export function buildAssessment(month: string, ratings: Record<string, Rating>, existing: SadacharaAssessment | undefined, now: string): SadacharaAssessment {
  if (!isValidMonth(month)) throw new Error('That is not a valid month.');
  const clean: Record<string, Rating> = {};
  for (const id of AREA_IDS) clean[id] = isRating(ratings[id]) ? ratings[id] : null;
  return { id: month, month, ratings: clean, status: isComplete(clean) ? 'complete' : 'in-progress', createdAt: existing?.createdAt ?? now, updatedAt: now };
}

export function validateAssessmentRecord(record: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!isValidMonth(record.id) || record.month !== record.id) errors.push('has an invalid month');
  const ratings = record.ratings;
  if (typeof ratings !== 'object' || ratings === null || Array.isArray(ratings)) errors.push('has no ratings');
  else {
    const keys = Object.keys(ratings);
    if (keys.length !== AREA_IDS.length || !AREA_IDS.every((id) => keys.includes(id))) errors.push('has unexpected areas');
    for (const id of AREA_IDS) { const value = (ratings as Record<string, unknown>)[id]; if (value !== null && !isRating(value)) errors.push('has an invalid rating'); }
    if (errors.length === 0 && record.status !== (isComplete(ratings as Record<string, Rating>) ? 'complete' : 'in-progress')) errors.push('has an inconsistent status');
  }
  if (typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') errors.push('has no timestamps');
  return errors;
}

// --- Preview & Share ---------------------------------------------------------------------------------------------------------------

/** The only sections a shared report can contain. Written answers have no section here, by design: the report builder never receives text. */
export const SHARE_SECTIONS = [
  { id: 'scores', label: 'Include the six area ratings' },
  { id: 'average', label: 'Include the overall average' },
] as const;
export type ShareSectionId = (typeof SHARE_SECTIONS)[number]['id'];
export const NO_SHARE_SECTIONS: readonly ShareSectionId[] = [];

/**
 * Plain-text report. Takes ONLY the month, numeric ratings and the chosen sections, so it cannot contain written answers, struggles or
 * family-related notes. Unanswered areas are written as "not answered", never as 0. Nothing is chosen by default.
 */
export function buildShareReport(month: string, ratings: Record<string, Rating>, sections: readonly ShareSectionId[]): string {
  const lines = [`Sādācāra summary: ${monthLabel(month)}`];
  if (sections.includes('scores')) {
    lines.push('', 'Ratings (0–10)');
    for (const area of SADACHARA_AREAS) lines.push(`- ${area.title}: ${isRating(ratings[area.id]) ? `${ratings[area.id]}/10` : 'not answered'}`);
  }
  if (sections.includes('average')) {
    const average = averageRating(ratings);
    lines.push('', average === null ? 'Overall average: not available (no area answered)' : `Overall average: ${average.toFixed(1)}/10 (answered areas only)`);
  }
  return lines.join('\n');
}
