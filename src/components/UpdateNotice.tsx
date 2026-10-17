import { useState, useSyncExternalStore } from 'react';
import { RefreshCw } from 'lucide-react';
import { getUpdateSnapshot, subscribeUpdate } from '@/lib/appUpdate';
import { getDiarySnapshot, retryUnsavedDrafts } from '@/lib/diaryService';
import { settleTrackedSaves } from '@/lib/pendingSaves';

/**
 * Shown when a newer version of the app has taken over in the background. Never reloads by itself: the person chooses, and a reload only
 * happens once every private draft is confirmed saved. If anything is still unsaved the page stays exactly as it is.
 */
export function UpdateNotice() {
  const available = useSyncExternalStore(subscribeUpdate, getUpdateSnapshot);
  const [dismissed, setDismissed] = useState(false); // for this page session only
  const [busy, setBusy] = useState(false); const [blocked, setBlocked] = useState<'private' | 'records' | null>(null);
  if (!available || dismissed) return null;

  const reload = async () => {
    setBusy(true); setBlocked(null);
    // 1. Sādhana records saved in the background (plain reflection, rounds, times…): wait for them, retry any that failed once.
    if (!(await settleTrackedSaves())) { setBusy(false); setBlocked('records'); return; }
    // 2. Private drafts.
    let flushed = true;
    try { await retryUnsavedDrafts(); } catch { flushed = false; } // resolves only when no draft is left and none failed
    const stillUnsaved = getDiarySnapshot().unsavedDates.length > 0; // re-read after the flush, not before it
    setBusy(false);
    if (!flushed || stillUnsaved) { setBlocked('private'); return; }
    window.location.reload();
  };

  return <div role="status" data-testid="update-notice" className="mb-4 rounded-xl border border-line bg-tint p-4 text-xs leading-5 text-ink-soft">
    <p className="flex items-center gap-2 text-sm font-bold text-primary-deep"><RefreshCw size={14} /> A newer version of Sādhana is ready</p>
    <p className="mt-1">Reload to use it. Your saved data stays as it is. Any unsaved private text is saved first, and reloading locks your private diary, so you will unlock it again.</p>
    {blocked === 'private' && <p role="alert" className="mt-2 font-semibold text-danger">Not reloaded: some private text is not saved yet. It is still on screen and nothing was discarded. Use Retry saving, then try again.</p>}
    {blocked === 'records' && <p role="alert" className="mt-2 font-semibold text-danger">Not reloaded: your latest changes could not be saved. They are still on screen and nothing was discarded. Check that this browser can store data, then try again.</p>}
    <div className="mt-3 flex gap-2">
      <button type="button" onClick={() => setDismissed(true)} disabled={busy} className="btn-outlined min-h-[44px] flex-1 px-4 py-2 text-xs">Later</button>
      <button type="button" onClick={() => void reload()} disabled={busy} className="btn-primary min-h-[44px] flex-1 px-4 py-2 text-xs disabled:opacity-60">{busy ? 'Saving…' : 'Reload now'}</button>
    </div>
  </div>;
}
