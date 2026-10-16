import Dexie, { type Table } from 'dexie';

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

class SadhanaDatabase extends Dexie {
  sessions!: Table<SessionRecord, number>;
  offerings!: Table<OfferingRecord, number>;
  sadhana!: Table<SadhanaRecord, number>;

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
  return db.transaction('rw', db.sadhana, async () => {
    const existing = await db.sadhana.where('date').equals(record.date).first();
    const fields = { ...record };
    delete fields.id;
    if (existing?.id !== undefined) await db.sadhana.put({ ...fields, id: existing.id });
    else await db.sadhana.add(fields);
  });
}
