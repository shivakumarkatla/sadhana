import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { db } from './db';
import type { SeasonalVow } from './seasonal';

/**
 * The seasonal Japa commitments, kept current by IndexedDB itself: pausing, editing or deleting one anywhere updates every screen using this.
 * Returns undefined until the first read, so a screen can show the regular target in the meantime. Only Japa vows are read.
 */
export function useJapaVows(): SeasonalVow[] | undefined {
  const [vows, setVows] = useState<SeasonalVow[] | undefined>(undefined);
  useEffect(() => {
    const subscription = liveQuery(() => db.seasonalVows.where('type').equals('japa').toArray()).subscribe({
      next: setVows,
      error: () => setVows([]), // unreadable commitments must never block recording: the regular target applies
    });
    return () => subscription.unsubscribe();
  }, []);
  return vows;
}
