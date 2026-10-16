import { useEffect, useState, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, CloudOff, Lock, ShieldCheck, Trash2, Unlock } from 'lucide-react';
import { DiaryCryptoError } from '@/lib/diaryCrypto';
import {
  LOCK_MINUTE_OPTIONS, beginRecoveryReplacement, cancelRecoveryReplacement, cancelSetup, changePassphrase, commitSetup, confirmRecoveryReplacement, countPlaintextReflections,
  discardUnsavedDrafts, getReflectionDraft, lockDiary, prepareSetup, readReflection, recoverWithKey, registerDiaryHolder, retryUnsavedDrafts, runReflectionMigration, setLockTimeoutMinutes, setReflectionDraft, unlockWithPassphrase, verifySetupRecovery,
} from '@/lib/diaryService';
import { createVerifiedBackup, deleteAllData, downloadTextFile, parseBackupText, restoreBackup, verifyBackupFileMatches } from '@/lib/backup';
import type { BackupFile } from '@/lib/backupFormat';
import { useDiary } from '@/lib/useDiary';

const REFLECTION_PLACEHOLDER = 'Record any insight, gratitude, or intention for tomorrow’s morning practice...';
const textareaClass = 'mt-4 w-full resize-none rounded-xl border border-line bg-surface p-3 text-sm leading-6 outline-none focus:border-primary-soft';

function messageOf(error: unknown): string {
  if (error instanceof DiaryCryptoError) return error.message;
  if (error instanceof Error && error.message) return error.message.slice(0, 300);
  return 'Something went wrong. Nothing was changed.';
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <section className="card p-5"><h2 className="mb-4 flex items-center gap-2 text-sm font-bold text-primary-deep"><span className="h-1.5 w-1.5 rounded-full bg-primary" /> {title}</h2>{children}</section>;
}
const Notice = ({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' | 'error' }) => <p role={tone === 'error' ? 'alert' : undefined} className={`mt-3 rounded-lg p-3 text-xs leading-5 font-semibold ${tone === 'error' ? 'bg-danger-tint text-danger' : tone === 'warn' ? 'bg-primary-tint text-primary' : 'bg-tint text-ink-soft'}`}>{children}</p>;

/** Passphrase box used for unlocking; shown inline on the reflection card and in Settings. */
function UnlockForm({ onDone }: { onDone?: () => void }) {
  const [passphrase, setPassphrase] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true); setError('');
    try { await unlockWithPassphrase(passphrase); setPassphrase(''); onDone?.(); }
    catch (failure) { setError(messageOf(failure)); }
    finally { setBusy(false); }
  };
  return <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <label className="label block">Diary passphrase<input type="password" autoComplete="current-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} className="field mt-2 bg-white" /></label>
    <button disabled={busy || !passphrase} className="btn-primary mt-3 flex w-full items-center justify-center gap-2 px-4 py-3 text-sm disabled:opacity-60"><Unlock size={16} /> {busy ? 'Unlocking…' : 'Unlock diary'}</button>
    {error && <Notice tone="error">{error}</Notice>}
  </form>;
}

/**
 * Decrypted reflection editor. Typed text goes into the draft store (src/lib/diaryDrafts.ts), which saves it encrypted and
 * keeps it if saving fails, even after this component unmounts (screen or date change).
 */
function PrivateReflection({ date }: { date: string }) {
  const diary = useDiary();
  const [text, setText] = useState(''); const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading'); const [loadError, setLoadError] = useState('');
  const [retrying, setRetrying] = useState(false); const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    const draft = getReflectionDraft(date); // unsaved text always wins over what is on disk
    if (draft !== undefined) { setText(draft); setStatus('ready'); }
    else readReflection(date)
      .then((value) => { if (!active) return; setText(value); setStatus('ready'); })
      .catch((error) => { if (!active) return; setLoadError(messageOf(error)); setStatus('error'); }); // never falls back to empty text
    const unregister = registerDiaryHolder(() => { setText(''); setStatus('loading'); setReloadKey((value) => value + 1); });
    return () => { active = false; unregister(); };
  }, [date, reloadKey]);

  const onChange = (value: string) => { if (status !== 'ready') return; setText(value); setReflectionDraft(date, value); };
  const unsaved = diary.unsavedDates.includes(date);
  const retry = async () => { setRetrying(true); try { await retryUnsavedDrafts(); } catch { /* the notice below stays visible */ } finally { setRetrying(false); } };

  if (status === 'error') return <><Notice tone="error">{loadError}</Notice><p className="mt-2 text-xs muted">Editing is paused so nothing is overwritten.</p></>;
  return <>
    <textarea value={text} disabled={status !== 'ready'} onChange={(event) => onChange(event.target.value)} placeholder={REFLECTION_PLACEHOLDER} rows={4} aria-label="Daily reflection" className={textareaClass} />
    <div className="mt-2 flex items-center justify-between gap-3 text-xs muted"><span>{diary.draftError && unsaved ? 'Not saved yet' : unsaved ? 'Encrypting and saving…' : 'Encrypted on this device'}</span><button type="button" onClick={() => { void lockDiary(); }} className="flex items-center gap-1 font-bold text-primary"><Lock size={12} /> Lock diary</button></div>
    {diary.draftError && unsaved && <><Notice tone="error">{diary.draftError} It stays on screen and is kept while the app is open.</Notice><button type="button" disabled={retrying} onClick={() => void retry()} className="btn-outlined mt-2 px-3 py-2 text-xs">{retrying ? 'Retrying…' : 'Retry saving'}</button></>}
    {diary.lockError && <Notice tone="error">{diary.lockError}</Notice>}
  </>;
}

/** Shown on every screen while private text is unsaved, so navigating away can never hide the only copy. */
export function UnsavedDiaryNotice() {
  const diary = useDiary();
  const [busy, setBusy] = useState(false); const [confirming, setConfirming] = useState(false);
  if (diary.unsavedDates.length === 0 || !diary.draftError) return null;
  const retry = async () => { setBusy(true); try { await retryUnsavedDrafts(); } catch { /* still unsaved: the notice stays */ } finally { setBusy(false); } };
  return <div role="alert" className="mb-4 rounded-xl border border-danger-soft bg-danger-tint p-4 text-xs leading-5 text-danger"><p className="font-bold">Private diary text is not saved yet</p><p className="mt-1">{diary.draftError} It is kept in memory while this page stays open, so do not close or reload it. Retry saving, or open Sādhana to copy it.</p><div className="mt-3 flex gap-2"><button onClick={() => void retry()} disabled={busy} className="btn-danger flex-1 px-3 py-2 text-xs">{busy ? 'Retrying…' : 'Retry saving'}</button>{!confirming ? <button onClick={() => setConfirming(true)} className="btn-outlined flex-1 px-3 py-2 text-xs">Discard text</button> : <><button onClick={() => setConfirming(false)} className="btn-outlined flex-1 px-3 py-2 text-xs">Keep text</button><button onClick={() => { discardUnsavedDrafts(); setConfirming(false); }} className="btn-danger-outline flex-1 px-3 py-2 text-xs">Yes, discard it</button></>}</div></div>;
}

/** Replaces the plain reflection textarea. With the diary off it behaves exactly as before. */
export function ReflectionField({ date, plainValue, onPlainChange }: { date: string; plainValue: string; onPlainChange: (value: string) => void }) {
  const diary = useDiary();
  if (!diary.loaded) return <p className="mt-4 text-xs muted">Opening…</p>;
  if (diary.state === 'disabled') return <>
    <textarea value={plainValue} onChange={(event) => onPlainChange(event.target.value)} placeholder={REFLECTION_PLACEHOLDER} rows={4} className={textareaClass} />
    <p className="mt-2 text-xs muted">Stays on this device. You can encrypt it in Settings → Private diary.</p>
  </>;
  if (diary.state === 'migrating' && !diary.unlocked) return <Notice tone="warn">Private diary setup was not finished. Your reflections are unchanged. Open Settings → Private diary to continue.</Notice>;
  if (diary.state === 'migrating') return <Notice tone="warn">Private diary setup is in progress. Finish it in Settings → Private diary; reflection editing is paused until then.</Notice>;
  if (!diary.unlocked) return <div className="mt-4 rounded-xl bg-tint p-4"><p className="flex items-center gap-2 text-sm font-bold text-primary-deep"><Lock size={16} /> Your diary is locked</p><p className="mb-3 mt-1 text-xs leading-5 muted">Unlock to read or write reflections. Everything else works as usual.</p><UnlockForm /></div>;
  return <PrivateReflection date={date} />;
}

// --- Settings: private diary ------------------------------------------------------------------------------------------

type Step = 'idle' | 'intro' | 'backup' | 'passphrase' | 'recovery' | 'verify' | 'migrate' | 'done';

export function DiarySettingsSection() {
  const diary = useDiary();
  const [step, setStep] = useState<Step>('idle');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [info, setInfo] = useState('');
  const [plainCount, setPlainCount] = useState<number | null>(null);
  const [backupMeta, setBackupMeta] = useState<{ checksum: string; plaintext: boolean; counts: BackupFile['counts'] } | null>(null);
  const [backupAck, setBackupAck] = useState(false); const [fileCheck, setFileCheck] = useState('');
  const [pass, setPass] = useState(''); const [pass2, setPass2] = useState('');
  const [recoveryKey, setRecoveryKey] = useState(''); const [saved, setSaved] = useState(false); const [entered, setEntered] = useState('');
  const [progress, setProgress] = useState(0);
  const [view, setView] = useState<'main' | 'recover' | 'change' | 'rekey'>('main');
  const [recoverKeyText, setRecoverKeyText] = useState(''); const [currentPass, setCurrentPass] = useState('');
  const [newKey, setNewKey] = useState(''); const [newKeyEntered, setNewKeyEntered] = useState(''); const [newKeySaved, setNewKeySaved] = useState(false);

  const reset = () => { cancelSetup(); cancelRecoveryReplacement(); setStep('idle'); setView('main'); setError(''); setInfo(''); setPass(''); setPass2(''); setRecoveryKey(''); setSaved(false); setEntered(''); setBackupMeta(null); setBackupAck(false); setFileCheck(''); setCurrentPass(''); setRecoverKeyText(''); setNewKey(''); setNewKeyEntered(''); setNewKeySaved(false); };
  const run = async (task: () => Promise<void>): Promise<boolean> => { setBusy(true); setError(''); try { await task(); return true; } catch (failure) { setError(messageOf(failure)); return false; } finally { setBusy(false); } };

  const begin = () => run(async () => { setPlainCount(await countPlaintextReflections()); setStep('intro'); });
  const makeBackup = () => run(async () => {
    const made = await createVerifiedBackup();
    downloadTextFile(`sadhana-backup-before-encryption-${new Date().toISOString().slice(0, 10)}.json`, made.text);
    setBackupMeta({ checksum: made.backup.checksum, plaintext: made.backup.containsPlaintextReflections, counts: made.backup.counts });
  });
  const checkFile = (file: File | undefined) => run(async () => {
    if (!file || !backupMeta) return;
    setFileCheck((await verifyBackupFileMatches(await file.text(), backupMeta.checksum)) ? 'The selected file matches the backup that was created. This checks the file only, not that it is stored safely.' : 'The selected file does not match. Create the backup again.');
  });
  const startKey = () => run(async () => {
    if (pass !== pass2) throw new Error('The two passphrases do not match.');
    setRecoveryKey(await prepareSetup(pass)); setPass(''); setPass2(''); setStep('recovery');
  });
  const migrate = () => run(async () => { setProgress(0); await runReflectionMigration(setProgress); setStep('done'); });
  const verifyKey = async () => {
    const verified = await run(async () => { await verifySetupRecovery(entered); await commitSetup(); setRecoveryKey(''); setEntered(''); setStep('migrate'); });
    if (verified) await migrate();
  };
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); setInfo('Copied. Paste it somewhere safe, then clear your clipboard history if your device keeps one.'); } catch { setInfo('Copying was blocked. Select the key and copy it manually.'); } };
  const saveKeyFile = (text: string) => downloadTextFile('sadhana-diary-recovery-key.txt', `Sādhana private diary recovery key\n\n${text}\n\nKeep this somewhere private and separate from your passphrase. Anyone with this key and access to your diary data can read it. If you lose both your passphrase and this key, your private entries cannot be recovered by anyone.\n`);

  if (!diary.loaded) return <Card title="Private diary"><p className="text-sm muted">Opening…</p></Card>;

  const keyBox = (text: string) => <><p className="mt-3 break-all rounded-xl bg-tint p-4 text-center font-mono text-sm font-bold tracking-wider text-primary-deep" aria-label="Recovery key">{text}</p><div className="mt-2 flex gap-2"><button type="button" onClick={() => void copy(text)} className="btn-outlined flex-1 px-3 py-2 text-xs">Copy</button><button type="button" onClick={() => saveKeyFile(text)} className="btn-outlined flex-1 px-3 py-2 text-xs">Save as file</button></div></>;

  // ---- setup wizard (diary off, or setup unfinished and unlocked) ----
  if (step !== 'idle' || diary.state === 'disabled' || (diary.state === 'migrating' && diary.unlocked)) {
    const active: Step = step === 'idle' ? (diary.state === 'migrating' ? 'migrate' : 'idle') : step;
    return <Card title="Private diary">
      {active === 'idle' && <><p className="text-sm leading-6 text-muted">Encrypt your Daily Reflection so that it is unreadable without a passphrase you choose. It is optional, and tracking, Sessions, Preaching and Insights keep working while the diary is locked.</p><button onClick={() => void begin()} disabled={busy} className="btn-primary mt-3 flex w-full items-center justify-center gap-2 px-4 py-3 text-sm"><Lock size={16} /> Set up private diary</button></>}
      {active === 'intro' && <>
        <p className="text-sm leading-6 text-muted">{plainCount ? `${plainCount} existing reflection${plainCount === 1 ? '' : 's'} will be encrypted after your consent.` : 'You have no saved reflections yet; future ones will be encrypted.'} Before anything changes, a full backup is created and checked, and every reflection is verified after encryption. If a step fails, your original text stays as it was.</p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-5 muted"><li>You will choose a passphrase of at least 12 characters and receive a recovery key.</li><li>If you lose both, nobody (including this app) can recover your private entries.</li><li>Dates, rounds, times and whether an entry exists are not encrypted. Encryption protects the written text on this device; it does not protect against malware or someone using your unlocked device.</li></ul>
        <div className="mt-4 flex gap-2"><button onClick={reset} className="btn-outlined flex-1 px-4 py-3 text-sm">Not now</button><button onClick={() => setStep('backup')} className="btn-primary flex-1 px-4 py-3 text-sm">I agree, continue</button></div></>}
      {active === 'backup' && <>
        <p className="text-sm leading-6 text-muted">Step 1: create a full backup of all your data and keep it safe.</p>
        <Notice tone="warn">This backup contains your reflections as readable text. Store it privately.</Notice>
        {!backupMeta ? <button onClick={() => void makeBackup()} disabled={busy} className="btn-outlined mt-3 flex w-full items-center justify-center gap-2 px-4 py-3 text-sm"><ArrowDownToLine size={16} /> {busy ? 'Creating…' : 'Create and download backup'}</button> : <>
          <Notice>Backup created and checked against your data: {backupMeta.counts.sessions} sessions, {backupMeta.counts.offerings} offerings, {backupMeta.counts.sadhana} Sādhana records. The app cannot confirm that your browser saved the file where you expect.</Notice>
          <label className="label mt-3 block">Optional: re-select the saved file to double-check it<input type="file" accept="application/json" onChange={(event) => void checkFile(event.target.files?.[0])} className="mt-2 block w-full text-xs normal-case tracking-normal" /></label>
          {fileCheck && <Notice tone={fileCheck.startsWith('The selected file matches') ? 'info' : 'error'}>{fileCheck}</Notice>}
          <label className="mt-3 flex items-start gap-2 text-sm text-ink-soft"><input type="checkbox" checked={backupAck} onChange={(event) => setBackupAck(event.target.checked)} className="mt-1" /> I saved the backup file somewhere safe.</label></>}
        <div className="mt-4 flex gap-2"><button onClick={reset} className="btn-outlined flex-1 px-4 py-3 text-sm">Cancel</button><button onClick={() => setStep('passphrase')} disabled={!backupMeta || !backupAck || fileCheck.startsWith('The selected file does not')} className="btn-primary flex-1 px-4 py-3 text-sm disabled:opacity-50">Continue</button></div></>}
      {active === 'passphrase' && <form onSubmit={(event) => { event.preventDefault(); void startKey(); }}>
        <p className="text-sm leading-6 text-muted">Step 2: choose a diary passphrase (at least 12 characters, different from any other password). It is never stored.</p>
        <label className="label mt-3 block">Passphrase<input type="password" autoComplete="new-password" value={pass} onChange={(event) => setPass(event.target.value)} className="field mt-2 bg-white" /></label>
        <label className="label mt-3 block">Repeat passphrase<input type="password" autoComplete="new-password" value={pass2} onChange={(event) => setPass2(event.target.value)} className="field mt-2 bg-white" /></label>
        <div className="mt-4 flex gap-2"><button type="button" onClick={reset} className="btn-outlined flex-1 px-4 py-3 text-sm">Cancel</button><button disabled={busy || pass.length < 12 || pass !== pass2} className="btn-primary flex-1 px-4 py-3 text-sm disabled:opacity-50">{busy ? 'Preparing key…' : 'Continue'}</button></div></form>}
      {active === 'recovery' && <>
        <p className="text-sm leading-6 text-muted">Step 3: this is your recovery key. It is shown only now and is not stored. It unlocks your diary if you forget your passphrase.</p>
        {keyBox(recoveryKey)}
        <label className="mt-3 flex items-start gap-2 text-sm text-ink-soft"><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} className="mt-1" /> I have saved this recovery key. I understand that if I lose both it and my passphrase, my private entries cannot be recovered.</label>
        <div className="mt-4 flex gap-2"><button onClick={reset} className="btn-outlined flex-1 px-4 py-3 text-sm">Cancel</button><button onClick={() => setStep('verify')} disabled={!saved} className="btn-primary flex-1 px-4 py-3 text-sm disabled:opacity-50">Continue</button></div></>}
      {active === 'verify' && <form onSubmit={(event) => { event.preventDefault(); void verifyKey(); }}>
        <p className="text-sm leading-6 text-muted">Step 4: prove the saved key works. Type or paste it exactly as you saved it. Encryption is turned on only after this succeeds.</p>
        <label className="label mt-3 block">Recovery key<input value={entered} onChange={(event) => setEntered(event.target.value)} autoComplete="off" spellCheck={false} className="field mt-2 bg-white font-mono" /></label>
        <div className="mt-4 flex gap-2"><button type="button" onClick={() => setStep('recovery')} className="btn-outlined flex-1 px-4 py-3 text-sm">Back</button><button disabled={busy || !entered.trim()} className="btn-primary flex-1 px-4 py-3 text-sm disabled:opacity-50">{busy ? 'Verifying…' : 'Verify and encrypt'}</button></div></form>}
      {active === 'migrate' && <>
        <p className="text-sm leading-6 text-muted">{busy ? `Encrypting your reflections… ${progress} done. Keep this page open.` : 'Encryption setup is not finished. Your original reflections are unchanged.'}</p>
        {!busy && <button onClick={() => void migrate()} className="btn-primary mt-3 w-full px-4 py-3 text-sm">{diary.state === 'migrating' ? 'Resume encryption' : 'Retry'}</button>}</>}
      {active === 'done' && <><Notice>Private diary is on. {progress ? `${progress} reflection${progress === 1 ? '' : 's'} encrypted and verified.` : 'Future reflections will be encrypted.'} The diary is unlocked now and locks after {diary.timeoutMinutes} minutes of inactivity.</Notice><button onClick={reset} className="btn-outlined mt-3 w-full px-4 py-3 text-sm">Done</button></>}
      {error && <Notice tone="error">{error}</Notice>}
      {info && <Notice>{info}</Notice>}
    </Card>;
  }

  // ---- unfinished setup, locked ----
  if (diary.state === 'migrating') return <Card title="Private diary"><Notice tone="warn">Setup was not finished. Your reflections are still unchanged. Unlock with your passphrase to continue.</Notice><div className="mt-3"><UnlockForm /></div></Card>;

  // ---- enabled, locked ----
  if (!diary.unlocked) {
    if (view === 'recover') return <Card title="Private diary · recover access">
      <form onSubmit={(event) => { event.preventDefault(); void run(async () => { if (pass !== pass2) throw new Error('The two passphrases do not match.'); await recoverWithKey(recoverKeyText, pass); reset(); }); }}>
        <p className="text-sm leading-6 text-muted">Enter your recovery key, then choose a new passphrase. Your entries are not changed.</p>
        <label className="label mt-3 block">Recovery key<input value={recoverKeyText} onChange={(event) => setRecoverKeyText(event.target.value)} autoComplete="off" spellCheck={false} className="field mt-2 bg-white font-mono" /></label>
        <label className="label mt-3 block">New passphrase (12+ characters)<input type="password" autoComplete="new-password" value={pass} onChange={(event) => setPass(event.target.value)} className="field mt-2 bg-white" /></label>
        <label className="label mt-3 block">Repeat new passphrase<input type="password" autoComplete="new-password" value={pass2} onChange={(event) => setPass2(event.target.value)} className="field mt-2 bg-white" /></label>
        <div className="mt-4 flex gap-2"><button type="button" onClick={reset} className="btn-outlined flex-1 px-4 py-3 text-sm">Cancel</button><button disabled={busy || !recoverKeyText.trim() || pass.length < 12} className="btn-primary flex-1 px-4 py-3 text-sm disabled:opacity-50">{busy ? 'Recovering…' : 'Recover'}</button></div>
        {error && <Notice tone="error">{error}</Notice>}</form></Card>;
    return <Card title="Private diary"><p className="flex items-center gap-2 text-sm font-bold text-primary-deep"><Lock size={16} /> Locked</p><div className="mt-3"><UnlockForm /></div><button onClick={() => { setError(''); setView('recover'); }} className="mt-3 text-xs font-bold text-primary">Forgot your passphrase? Use your recovery key</button></Card>;
  }

  // ---- enabled, unlocked ----
  if (view === 'change') return <Card title="Private diary · change passphrase">
    <form onSubmit={(event) => { event.preventDefault(); void run(async () => { if (pass !== pass2) throw new Error('The two new passphrases do not match.'); await changePassphrase(currentPass, pass); reset(); setInfo('Passphrase changed. Your entries did not need re-encrypting.'); }); }}>
      <label className="label block">Current passphrase<input type="password" autoComplete="current-password" value={currentPass} onChange={(event) => setCurrentPass(event.target.value)} className="field mt-2 bg-white" /></label>
      <label className="label mt-3 block">New passphrase (12+ characters)<input type="password" autoComplete="new-password" value={pass} onChange={(event) => setPass(event.target.value)} className="field mt-2 bg-white" /></label>
      <label className="label mt-3 block">Repeat new passphrase<input type="password" autoComplete="new-password" value={pass2} onChange={(event) => setPass2(event.target.value)} className="field mt-2 bg-white" /></label>
      <div className="mt-4 flex gap-2"><button type="button" onClick={reset} className="btn-outlined flex-1 px-4 py-3 text-sm">Cancel</button><button disabled={busy || !currentPass || pass.length < 12} className="btn-primary flex-1 px-4 py-3 text-sm disabled:opacity-50">{busy ? 'Changing…' : 'Change passphrase'}</button></div>
      {error && <Notice tone="error">{error}</Notice>}</form></Card>;
  if (view === 'rekey') return <Card title="Private diary · new recovery key">
    {!newKey ? <form onSubmit={(event) => { event.preventDefault(); void run(async () => { setNewKey(await beginRecoveryReplacement(currentPass)); setCurrentPass(''); }); }}>
      <p className="text-sm leading-6 text-muted">A new recovery key will be created and checked. Your current recovery key keeps working until the new one is confirmed.</p>
      <label className="label mt-3 block">Current passphrase<input type="password" autoComplete="current-password" value={currentPass} onChange={(event) => setCurrentPass(event.target.value)} className="field mt-2 bg-white" /></label>
      <div className="mt-4 flex gap-2"><button type="button" onClick={reset} className="btn-outlined flex-1 px-4 py-3 text-sm">Cancel</button><button disabled={busy || !currentPass} className="btn-primary flex-1 px-4 py-3 text-sm disabled:opacity-50">{busy ? 'Creating…' : 'Create new key'}</button></div></form>
    : <form onSubmit={(event) => { event.preventDefault(); void run(async () => { await confirmRecoveryReplacement(newKeyEntered); reset(); setInfo('New recovery key confirmed. The old recovery key no longer works.'); }); }}>
      <p className="text-sm leading-6 text-muted">Save this key, then type it below to confirm it works.</p>
      {keyBox(newKey)}
      <label className="mt-3 flex items-start gap-2 text-sm text-ink-soft"><input type="checkbox" checked={newKeySaved} onChange={(event) => setNewKeySaved(event.target.checked)} className="mt-1" /> I have saved the new recovery key.</label>
      <label className="label mt-3 block">Type the new key to confirm<input value={newKeyEntered} onChange={(event) => setNewKeyEntered(event.target.value)} autoComplete="off" spellCheck={false} className="field mt-2 bg-white font-mono" /></label>
      <div className="mt-4 flex gap-2"><button type="button" onClick={reset} className="btn-outlined flex-1 px-4 py-3 text-sm">Cancel</button><button disabled={busy || !newKeySaved || !newKeyEntered.trim()} className="btn-primary flex-1 px-4 py-3 text-sm disabled:opacity-50">{busy ? 'Checking…' : 'Confirm new key'}</button></div></form>}
    {error && <Notice tone="error">{error}</Notice>}{info && <Notice>{info}</Notice>}</Card>;

  return <Card title="Private diary">
    <p className="flex items-center gap-2 text-sm font-bold text-primary-deep"><Unlock size={16} /> Unlocked</p>
    <p className="mt-1 text-xs leading-5 muted">Daily Reflection is encrypted on this device. The diary locks when you press Lock, after inactivity, and whenever the app is reloaded.</p>
    {diary.lockError && <Notice tone="error">{diary.lockError}</Notice>}
    <button onClick={() => void run(async () => { const result = await lockDiary(); if (!result.ok) throw new Error(result.error); })} className="btn-primary mt-3 flex w-full items-center justify-center gap-2 px-4 py-3 text-sm"><Lock size={16} /> Lock diary now</button>
    <label className="label mt-4 block">Lock after inactivity<select value={diary.timeoutMinutes} onChange={(event) => void run(() => setLockTimeoutMinutes(Number(event.target.value)))} className="field mt-2 bg-white">{[...LOCK_MINUTE_OPTIONS, ...(LOCK_MINUTE_OPTIONS.some((value) => value === diary.timeoutMinutes) ? [] : [diary.timeoutMinutes])].map((value) => <option key={value} value={value}>{value} minute{value === 1 ? '' : 's'}</option>)}</select></label>
    <div className="mt-3 grid gap-2 sm:grid-cols-2"><button onClick={() => { setError(''); setView('change'); }} className="btn-outlined px-4 py-3 text-sm">Change passphrase</button><button onClick={() => { setError(''); setView('rekey'); }} className="btn-outlined px-4 py-3 text-sm">New recovery key</button></div>
    {error && <Notice tone="error">{error}</Notice>}{info && <Notice>{info}</Notice>}
  </Card>;
}

// --- Settings: backup, restore, delete all ---------------------------------------------------------------------------

export function DataSafetySection({ onDataChanged }: { onDataChanged: () => Promise<void> }) {
  const diary = useDiary();
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const [pending, setPending] = useState<{ backup: BackupFile; warnings: string[] } | null>(null); const [restoreErrors, setRestoreErrors] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const run = async (task: () => Promise<void>) => { setBusy(true); setError(''); setMessage(''); try { await task(); } catch (failure) { setError(messageOf(failure)); } finally { setBusy(false); } };

  const exportBackup = () => run(async () => {
    const made = await createVerifiedBackup();
    downloadTextFile(`sadhana-backup-${new Date().toISOString().slice(0, 10)}.json`, made.text);
    setMessage(`Backup created and checked against your data (${made.backup.counts.sadhana} Sādhana records, ${made.backup.counts.sessions} sessions, ${made.backup.counts.offerings} offerings${made.backup.counts.privateContent ? `, ${made.backup.counts.privateContent} encrypted entries` : ''}). ${made.backup.containsPlaintextReflections ? 'This file contains readable reflections: keep it private. ' : ''}${made.backup.diaryState !== 'disabled' ? 'It contains your wrapped diary keys, so a strong, unique passphrase matters: a leaked file allows offline guessing. ' : ''}The app cannot confirm where your browser saved it.`);
  });
  const choose = (file: File | undefined) => run(async () => {
    setPending(null); setRestoreErrors([]);
    if (!file) return;
    const parsed = await parseBackupText(await file.text());
    if (parsed.ok) setPending({ backup: parsed.backup, warnings: parsed.warnings }); else setRestoreErrors(parsed.errors);
  });
  const restore = () => run(async () => {
    if (!pending) return;
    await restoreBackup(pending.backup);
    await onDataChanged();
    setPending(null);
    setMessage(pending.backup.diaryState === 'disabled' ? 'Backup restored and verified.' : 'Backup restored and verified. The diary is locked: unlock it with the passphrase (or recovery key) it had when the backup was made.');
  });
  const wipe = () => run(async () => { await deleteAllData(); await onDataChanged(); setConfirmDelete(false); setPending(null); setMessage('All local records were deleted from this browser. Backup files you saved elsewhere are not affected.'); });

  return <>
    <Card title="Local vault & storage">
      <div className="flex items-center gap-3 rounded-xl bg-tint p-4"><CloudOff size={20} className="text-primary" /><div><p className="font-bold">Offline ready</p><p className="mt-1 text-xs muted">Your devotional records stay in this browser. Browser storage itself is not encrypted; only the private diary text is.</p></div></div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2"><button onClick={() => void exportBackup()} disabled={busy} className="flex items-center justify-center gap-2 btn-outlined px-4 py-3 text-sm"><ArrowDownToLine size={16} /> Export full backup</button><label className="flex cursor-pointer items-center justify-center gap-2 btn-outlined px-4 py-3 text-sm"><ArrowUpFromLine size={16} /> Choose backup to restore<input className="hidden" type="file" accept="application/json,.json" onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ''; }} /></label></div>
      {diary.state !== 'disabled' && <p className="mt-3 flex items-start gap-2 text-xs leading-5 muted"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-tertiary" /> Backups keep your private entries encrypted. They never contain your passphrase or recovery key.</p>}
      {restoreErrors.length > 0 && <Notice tone="error">{restoreErrors.join(' ')} Nothing was changed.</Notice>}
      {pending && <div className="mt-3 rounded-xl border border-line p-4"><p className="text-sm font-bold text-primary-deep">Restore this backup?</p><p className="mt-1 text-xs leading-5 muted">Made {new Date(pending.backup.exportedAt).toLocaleString()}: {pending.backup.counts.sadhana} Sādhana records, {pending.backup.counts.sessions} sessions, {pending.backup.counts.offerings} offerings{pending.backup.diaryState === 'disabled' ? '' : `, private diary ${pending.backup.diaryState === 'enabled' ? 'encrypted' : 'setup unfinished'}`}. It <strong>replaces all current data</strong> in this browser. Your current data is snapshotted first and put back if anything fails.</p>{pending.warnings.map((warning) => <Notice key={warning} tone="warn">{warning}</Notice>)}<div className="mt-3 flex gap-2"><button onClick={() => setPending(null)} disabled={busy} className="btn-outlined flex-1 px-4 py-3 text-sm">Cancel</button><button onClick={() => void restore()} disabled={busy} className="btn-danger flex-1 px-4 py-3 text-sm">{busy ? 'Restoring…' : 'Replace my data'}</button></div></div>}
      {message && <Notice>{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </Card>
    <Card title="Privacy & vault integrity">
      <p className="text-sm leading-6 text-muted">There is no account, cloud database, or synchronization in this first release.</p>
      <button onClick={() => { setError(''); setConfirmDelete(true); }} className="mt-3 flex w-full items-center justify-center gap-2 btn-danger-outline px-4 py-3 text-sm"><Trash2 size={16} /> Delete all local records</button>
    </Card>
    {confirmDelete && <div className="fixed inset-0 z-30 grid place-items-center bg-ink/30 p-5"><div role="alertdialog" aria-modal="true" aria-labelledby="delete-all-title" className="card w-full max-w-sm p-6"><h2 id="delete-all-title" className="font-heading text-xl font-bold">Delete all local records?</h2><p className="mt-2 text-sm leading-6 text-muted">This permanently removes your Sādhana records, sessions, offerings, the private diary and its keys from this browser. It cannot be undone, and it does not delete backup files you saved elsewhere.</p>{error && <Notice tone="error">{error}</Notice>}<div className="mt-5 flex gap-2"><button onClick={() => setConfirmDelete(false)} disabled={busy} className="btn-outlined flex-1 px-4 py-3 text-sm">Cancel</button><button onClick={() => void wipe()} disabled={busy} className="btn-danger flex-1 px-4 py-3 text-sm disabled:opacity-60">{busy ? 'Deleting…' : 'Delete'}</button></div></div></div>}
  </>;
}
