import Dexie, { type Table } from 'dexie';

export type SessionKind = 'Study' | 'Hearing' | 'Service';
export type OfferingKind = 'Book Distribution' | 'DYS Session Conducting' | 'DYS Registration' | 'Calling Service' | 'Prasadam Cooking for Boys' | 'Others';

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
