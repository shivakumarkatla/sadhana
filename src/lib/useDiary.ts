import { useEffect, useSyncExternalStore } from 'react';
import { ensureDiaryLoaded, getDiarySnapshot, subscribeDiary, type DiarySnapshot } from './diaryService';

/** Observes diary state (disabled / migrating / enabled, locked or unlocked). Loads the key metadata on first use. */
export function useDiary(): DiarySnapshot {
  useEffect(() => { ensureDiaryLoaded().catch(() => console.error('Could not read private diary settings')); }, []);
  return useSyncExternalStore(subscribeDiary, getDiarySnapshot);
}
