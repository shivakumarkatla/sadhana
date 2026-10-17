/**
 * Sādācāra storage for the NUMERIC part only. Written answers are never handled here: they go through the private diary
 * (diaryService writePrivateText), so nothing in this file can see or store text. Used by src/components/Sadachara.tsx.
 */
import { db } from './db';
import { buildAssessment, isValidMonth, type Rating, type SadacharaAssessment } from './sadachara';

export const listAssessments = (): Promise<SadacharaAssessment[]> => db.sadacharaAssessments.toArray();
export const getAssessment = (month: string): Promise<SadacharaAssessment | undefined> => db.sadacharaAssessments.get(month);

let chain: Promise<unknown> = Promise.resolve();

/** Creates or replaces the ONE assessment for `month` (its id is the month). Saves are serialised so a slower older save cannot overwrite a newer one. */
export function saveAssessmentRatings(month: string, ratings: Record<string, Rating>): Promise<SadacharaAssessment> {
  if (!isValidMonth(month)) return Promise.reject(new Error('That is not a valid month.'));
  const run = () => db.transaction('rw', db.sadacharaAssessments, async () => {
    const next = buildAssessment(month, ratings, await db.sadacharaAssessments.get(month), new Date().toISOString());
    await db.sadacharaAssessments.put(next);
    return next;
  });
  const result = chain.then(run, run);
  chain = result.catch(() => undefined);
  return result;
}
