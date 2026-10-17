/**
 * Seasonal Saṅkalpa storage operations. Every rule lives in seasonal.ts; this file only reads and writes IndexedDB, and runs each
 * change inside one transaction so a validation check and its write can never be separated by another change.
 * Used by the Seasonal Saṅkalpa screen (src/components/SeasonalSankalpa.tsx).
 */
import { db, type SadhanaRecord } from './db';
import {
  SeasonalError, buildVowLog, createVow, editVow, effectiveTargetFor, localDateString, logIdFor, transitionVow,
  type LogEntry, type SeasonalVow, type VowAction, type VowInput, type VowLog,
} from './seasonal';

const context = () => ({ today: localDateString(), now: new Date().toISOString() });
export function newVowId(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `vow-${random}`;
}

export const listVows = (): Promise<SeasonalVow[]> => db.seasonalVows.toArray();
export const listVowLogs = (vowId?: string): Promise<VowLog[]> => vowId ? db.vowLogs.where('vowId').equals(vowId).toArray() : db.vowLogs.toArray();

export function createSeasonalVow(input: VowInput): Promise<SeasonalVow> {
  return db.transaction('rw', db.seasonalVows, async () => {
    const vow = createVow(newVowId(), input, context());
    await db.seasonalVows.add(vow);
    return vow;
  });
}

async function load(id: string): Promise<SeasonalVow> {
  const vow = await db.seasonalVows.get(id);
  if (!vow) throw new SeasonalError(['That commitment no longer exists.']);
  return vow;
}

export function editSeasonalVow(id: string, patch: Partial<Omit<VowInput, 'type'>>): Promise<SeasonalVow> {
  return db.transaction('rw', db.seasonalVows, async () => {
    const next = editVow(await load(id), patch, await db.seasonalVows.toArray(), context());
    await db.seasonalVows.put(next);
    return next;
  });
}

/** Activate, pause, resume, complete or archive. Nothing is deleted; every log and every day's snapshot is kept. */
export function changeVowStatus(id: string, action: VowAction): Promise<SeasonalVow> {
  return db.transaction('rw', db.seasonalVows, async () => {
    const next = transitionVow(await load(id), action, await db.seasonalVows.toArray(), context());
    await db.seasonalVows.put(next);
    return next;
  });
}

/**
 * Permanent deletion of one commitment and its logs. Needs an explicit `{ confirmed: true }` so it can never happen as a side effect.
 * Sādhana rows keep their own target snapshots, so past days still show what target applied.
 */
export function deleteSeasonalVow(id: string, confirmation: { confirmed: boolean }): Promise<void> {
  if (confirmation?.confirmed !== true) return Promise.reject(new SeasonalError(['Deleting a commitment permanently needs explicit confirmation.']));
  return db.transaction('rw', db.seasonalVows, db.vowLogs, async () => {
    await db.vowLogs.where('vowId').equals(id).delete();
    await db.seasonalVows.delete(id);
  });
}

/** One log per commitment per date: the id is `${vowId}|${date}`, so logging twice updates the same row instead of adding a second. */
export function saveVowLog(vowId: string, date: string, entry: LogEntry): Promise<VowLog> {
  return db.transaction('rw', db.seasonalVows, db.vowLogs, async () => {
    const log = buildVowLog({ vow: await load(vowId), date, entry, existing: await db.vowLogs.get(logIdFor(vowId, date)), ctx: context() });
    await db.vowLogs.put(log);
    return log;
  });
}

/** The daily target for display: the day's own snapshot if it has one, otherwise the live seasonal-or-regular rule (see effectiveTargetFor). */
export async function getEffectiveTarget(date: string, regularTarget: number): Promise<ReturnType<typeof effectiveTargetFor>> {
  const record: SadhanaRecord | undefined = await db.sadhana.where('date').equals(date).first();
  return effectiveTargetFor(record ?? null, date, localDateString(), regularTarget, await db.seasonalVows.where('type').equals('japa').toArray());
}
