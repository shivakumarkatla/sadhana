import Dexie, { type Table } from 'dexie';
import { reflectionForSave, type DiaryState, type PrivateRecord } from './diaryRules';
import type { KdfParams, RecoveryWrap, WrappedKey } from './diaryCrypto';

export type SessionKind = 'Study' | 'Hearing' | 'Service';
export type OfferingKind = 'Book Distribution' | 'DYS Session Conducting' | 'DYS Registration' | 'Calling Service' | 'Prasadam Cooking for Boys' | 'Others';

export const QUALITY_TAGS = ['Quiet early morning', 'Good focus', 'Restless mind', 'Temple hall', 'Walking japa', 'Drowsy'] as const;
export type QualityTag = (typeof QUALITY_TAGS)[number];

export interface SessionRecord {
  id?: number;
  date: string;
  kind: SessionKind;
  title: string;
  topic?: string;
  minutes: number;
  note?: string;
}

export interface OfferingRecord {
  id?: number;
  date: string;
  kind: OfferingKind;
  minutes: number;
  description: string;
}

export interface SadhanaRecord {
  id?: number;
  date: string;
  rounds: number;
  targetRounds: number;
  earlyRounds: number;
  sixteenthRoundTime: string;
  quality?: 'Steady' | 'Mixed' | 'Difficult';
  /** Multi-select attention notes. Not indexed, so adding it needs no Dexie schema or version change; older records simply lack it. */
  qualityTags?: QualityTag[];
  wakeUp: string;
  bedtime: string;
  sleepOnset: string;
  mangalaArati: 'Attended' | 'Not today' | 'Unrecorded';
  reflection: string;
}

/** Single record (id 'diary'). Holds wrapped keys and settings only: never a passphrase, raw key or recovery secret. A missing record means the diary is disabled. */
export interface EncryptionMetaRecord {
  id: 'diary';
  formatVersion: 1;
  state: Exclude<DiaryState, 'disabled'>;
  lockTimeoutMinutes: number;
  kdf: KdfParams;
  passphraseWrap: WrappedKey;
  recoveryWrap: RecoveryWrap;
  createdAt: string;
  updatedAt: string;
}
/** Encrypted private text, keyed 'kind:refId' (e.g. 'reflection:2026-10-16'). Kinds are shared with future written Sādācāra answers. */
export type PrivateContentRecord = PrivateRecord;

class SadhanaDatabase extends Dexie {
  sessions!: Table<SessionRecord, number>;
  offerings!: Table<OfferingRecord, number>;
  sadhana!: Table<SadhanaRecord, number>;
  encryptionMeta!: Table<EncryptionMetaRecord, string>;
  privateContent!: Table<PrivateContentRecord, string>;

  constructor() {
    super('sadhana-devotional-companion');
    this.version(1).stores({
      sessions: '++id, date, kind',
      offerings: '++id, date, kind',
    });
    this.version(2).stores({
      sessions: '++id, date, kind',
      offerings: '++id, date, kind',
      sadhana: '++id, date',
    });
    this.version(3).stores({
      sessions: '++id, date, kind',
      offerings: '++id, date, kind',
      sadhana: '++id, date',
    });
    // v4 is additive: two new stores, existing stores and rows untouched. No upgrade callback (encryption never runs inside one).
    this.version(4).stores({
      sessions: '++id, date, kind',
      offerings: '++id, date, kind',
      sadhana: '++id, date',
      encryptionMeta: 'id',
      privateContent: 'id, kind',
    });
  }
}

export const db = new SadhanaDatabase();

const DEFAULT_TARGET_ROUNDS = 16;

/** Returns the record stored for `date`, or a blank unsaved one that inherits the latest earlier target. */
export async function loadSadhanaForDate(date: string): Promise<SadhanaRecord> {
  const existing = await db.sadhana.where('date').equals(date).first();
  if (existing) return existing;
  const previous = await db.sadhana.where('date').below(date).last();
  return {
    date, rounds: 0, targetRounds: previous?.targetRounds || DEFAULT_TARGET_ROUNDS, earlyRounds: 0,
    sixteenthRoundTime: '', quality: undefined, wakeUp: '', bedtime: '', sleepOnset: '', mangalaArati: 'Unrecorded', reflection: '',
  };
}

/** Saves a record under its own date. The lookup and write share one transaction, which Dexie queues,
 *  so rapid saves can never create a second row for the same date or touch another date's row. */
export function saveSadhanaForDate(record: SadhanaRecord): Promise<void> {
  return db.transaction('rw', db.sadhana, db.encryptionMeta, async () => {
    const existing = await db.sadhana.where('date').equals(record.date).first();
    const diaryState: DiaryState = (await db.encryptionMeta.get('diary'))?.state ?? 'disabled';
    const fields = { ...record };
    delete fields.id;
    // Once the private diary is being set up or is on, an autosave can never write (or resurrect) plaintext reflection text.
    fields.reflection = reflectionForSave(diaryState, record.reflection, existing?.reflection);
    if (existing?.id !== undefined) await db.sadhana.put({ ...fields, id: existing.id });
    else await db.sadhana.add(fields);
  });
}
