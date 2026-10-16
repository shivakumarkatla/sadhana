import { useEffect, useRef, useState, type ChangeEvent, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { db, loadSadhanaForDate, saveSadhanaForDate, QUALITY_TAGS, type QualityTag, type OfferingKind, type OfferingRecord, type SadhanaRecord, type SessionKind, type SessionRecord } from '@/lib/db';
import { AlarmClock, Archive, ArrowDownToLine, ArrowUpFromLine, BedDouble, BookOpen, CalendarDays, Check, ChevronLeft, ChevronRight, Circle, Clock3, CloudOff, Edit3, Flower2, Lock, HandHeart, Headphones, Home, Menu, Moon, NotebookPen, Plus, Settings as SettingsIcon, ShieldCheck, Sparkles, Sun, Trash2, TrendingUp, Users, X } from 'lucide-react';

type Screen = 'Today' | 'Sādhana' | 'Sessions' | 'Preaching' | 'Insights' | 'Settings';

const navItems: { label: Screen; icon: typeof Home }[] = [
  { label: 'Today', icon: Sun }, { label: 'Sādhana', icon: Moon }, { label: 'Sessions', icon: BookOpen },
  { label: 'Preaching', icon: Users }, { label: 'Insights', icon: TrendingUp }, { label: 'Settings', icon: SettingsIcon },
];

function formatMinutes(minutes: number): string { return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60 ? `${minutes % 60}m` : ''}`.trim() : `${minutes} min`; }
function todayString(): string {
  const now = new Date();
  const offset = now.getTimezoneOffset();
  return new Date(now.getTime() - offset * 60_000).toISOString().slice(0, 10);
}
function createInitialSadhana(): SadhanaRecord { return { date: todayString(), rounds: 0, targetRounds: 16, earlyRounds: 0, sixteenthRoundTime: '', quality: undefined, wakeUp: '', bedtime: '', sleepOnset: '', mangalaArati: 'Unrecorded', reflection: '' }; }
function addDays(date: string, days: number): string {
  const moved = new Date(`${date}T12:00:00`);
  moved.setDate(moved.getDate() + days);
  return new Date(moved.getTime() - moved.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}
function shortDate(date: string): string { return new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00`)); }
function displayDate(date: string): string { return new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${date}T12:00:00`)); }
function isCurrentWeek(date: string): boolean { const target = new Date(`${date}T12:00:00`); const now = new Date(); const day = now.getDay(); const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (day === 0 ? 6 : day - 1)); monday.setHours(0, 0, 0, 0); const nextMonday = new Date(monday); nextMonday.setDate(monday.getDate() + 7); return target >= monday && target < nextMonday; }
function isCurrentMonth(date: string): boolean { const now = new Date(); return date.startsWith(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`); }

function App() {
  const [screen, setScreen] = useState<Screen>('Today');
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [offerings, setOfferings] = useState<OfferingRecord[]>([]);
  const [sadhana, setSadhana] = useState<SadhanaRecord>(createInitialSadhana());
  const [showAddOffering, setShowAddOffering] = useState(false);
  const [editOffering, setEditOffering] = useState<OfferingRecord | null>(null);

  useEffect(() => {
    let active = true;
    const loadLocalRecords = async () => {
      const [storedSessions, storedOfferings, todaySadhana] = await Promise.all([
        db.sessions.toArray(),
        db.offerings.toArray(),
        loadSadhanaForDate(todayString()),
      ]);
      if (!active) return;
      if (storedSessions.length) setSessions(storedSessions);
      if (storedOfferings.length) setOfferings(storedOfferings);
      setSadhana(todaySadhana);
    };
    void loadLocalRecords();
    return () => { active = false; };
  }, []);

  // If the app was left open past midnight, switch to the new day's record when it becomes visible again.
  const shownDate = sadhana.date;
  useEffect(() => {
    const refreshDay = () => {
      if (document.visibilityState !== 'visible') return;
      const today = todayString();
      if (today === shownDate) return;
      void loadSadhanaForDate(today).then((record) => setSadhana((current) => current.date === shownDate ? record : current));
    };
    document.addEventListener('visibilitychange', refreshDay);
    window.addEventListener('focus', refreshDay);
    return () => { document.removeEventListener('visibilitychange', refreshDay); window.removeEventListener('focus', refreshDay); };
  }, [shownDate]);

  const deleteOffering = async (id: number) => {
    await db.offerings.delete(id);
    setOfferings((current) => current.filter((item) => item.id !== id));
  };

  const saveOffering = async (record: OfferingRecord) => {
    if (record.id) {
      await db.offerings.update(record.id, record);
      setOfferings((current) => current.map((item) => item.id === record.id ? record : item));
    } else {
      const id = await db.offerings.add(record);
      setOfferings((current) => [...current, { ...record, id }]);
    }
    setShowAddOffering(false);
    setEditOffering(null);
  };

  return (
    <div className="app-shell">
      <Header screen={screen} onSettings={() => setScreen('Settings')} />
      <main className="page-wrap">
        {screen === 'Today' && <TodayScreen sessions={sessions} offerings={offerings} sadhana={sadhana} onNavigate={setScreen} />}
        {screen === 'Sādhana' && <SadhanaScreen record={sadhana} onChange={setSadhana} sessions={sessions} setSessions={setSessions} />}
        {screen === 'Sessions' && <SessionsScreen sessions={sessions} setSessions={setSessions} />}
        {screen === 'Preaching' && <PreachingScreen offerings={offerings} onAdd={() => setShowAddOffering(true)} onEdit={(item) => setEditOffering(item)} onDelete={deleteOffering} />}
        {screen === 'Insights' && <InsightsScreen sessions={sessions} offerings={offerings} sadhana={sadhana} />}
        {screen === 'Settings' && <SettingsScreen sessions={sessions} offerings={offerings} />}
      </main>
      <BottomNav screen={screen} onNavigate={setScreen} />
      {(showAddOffering || editOffering) && <OfferingModal initial={editOffering ?? undefined} onClose={() => { setShowAddOffering(false); setEditOffering(null); }} onSave={saveOffering} />}
    </div>
  );
}

function Header({ screen, onSettings }: { screen: Screen; onSettings: () => void }) {
  return <header className="mx-auto flex w-full max-w-[760px] items-center justify-between px-5 py-4">
    <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-full bg-primary-tint text-primary"><Sparkles size={19} /></div><div><div className="flex items-center gap-2 text-lg font-semibold tracking-tight">Sādhana <span className="rounded-full bg-tint-strong px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-muted"><span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-tertiary" />offline ready</span></div><p className="text-xs font-semibold text-muted">{screen}</p></div></div>
    <button aria-label="Open settings" onClick={onSettings} className="rounded-xl p-2 text-ink-soft transition hover:bg-white"><Menu size={21} /></button>
  </header>;
}

function BottomNav({ screen, onNavigate }: { screen: Screen; onNavigate: (screen: Screen) => void }) {
  return <nav className="fixed bottom-0 left-0 right-0 z-20 border-t border-line-soft bg-surface/95 px-2 pb-3 pt-2 backdrop-blur md:bottom-5 md:left-1/2 md:right-auto md:w-[620px] md:-translate-x-1/2 md:rounded-2xl md:border md:shadow-lg"><div className="mx-auto flex max-w-[620px] justify-around">{navItems.slice(0, 5).map(({ label, icon: Icon }) => <button key={label} onClick={() => onNavigate(label)} className={`flex min-w-[58px] flex-col items-center gap-1 rounded-xl px-2 py-1 text-[11px] font-semibold transition ${screen === label ? 'text-primary' : 'text-muted hover:bg-tint'}`}><Icon size={19} strokeWidth={screen === label ? 2.4 : 1.8} /><span>{label}</span></button>)}</div></nav>;
}

function ScreenTitle({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) { return <div className="mb-6 flex items-start justify-between"><div>{eyebrow && <p className="label mb-2">{eyebrow}</p>}<h1 className="font-heading text-3xl font-bold leading-tight text-primary-deep md:text-4xl">{title}</h1>{children}</div></div>; }
function StatCard({ label, value, detail, icon: Icon }: { label: string; value: string; detail: string; icon: typeof Clock3 }) { return <div className="card p-4"><Icon size={17} className="mb-3 text-primary-soft" /><p className="label">{label}</p><p className="mt-1 text-xl font-bold text-primary-deep">{value}</p><p className="mt-1 text-xs text-muted">{detail}</p></div>; }

function TodayScreen({ sessions, offerings, sadhana, onNavigate }: { sessions: SessionRecord[]; offerings: OfferingRecord[]; sadhana: SadhanaRecord; onNavigate: (screen: Screen) => void }) {
  const date = todayString();
  const todaySessions = sessions.filter((item) => item.date === date);
  const weeklyOfferings = offerings.filter((item) => isCurrentWeek(item.date));
  const todayMinutes = todaySessions.reduce((sum, item) => sum + item.minutes, 0);
  const weeklyMinutes = weeklyOfferings.reduce((sum, item) => sum + item.minutes, 0);
  return <>
    <div className="mb-7 flex items-end justify-between"><div><p className="label mb-2">{displayDate(date)}</p><h1 className="font-heading text-3xl font-bold text-primary-deep">A gentle return<br />to the day.</h1><p className="mt-3 max-w-md text-sm leading-6 text-muted">Keep a clear record of what you offer, without turning practice into performance.</p></div><div className="hidden h-16 w-16 items-center justify-center rounded-2xl bg-tint-strong text-primary md:flex"><Sun size={29} /></div></div>
    <div className="card mb-5 grid grid-cols-2 gap-3 p-3 md:grid-cols-4"><div className="rounded-xl bg-tint p-4"><p className="label">Today's practice</p><p className="mt-1 text-2xl font-bold">{todayMinutes ? formatMinutes(todayMinutes) : '—'}</p><p className="mt-1 text-xs muted">{todaySessions.length ? `${todaySessions.length} sessions recorded` : 'No sessions recorded'}</p></div><div className="rounded-xl bg-tint p-4"><p className="label">Weekly preaching</p><p className="mt-1 text-2xl font-bold">{weeklyMinutes ? formatMinutes(weeklyMinutes) : '—'}</p><p className="mt-1 text-xs muted">of 2h minimum</p></div><div className="hidden rounded-xl bg-tint p-4 md:block"><p className="label">Japa rounds</p><p className="mt-1 text-2xl font-bold">{sadhana.date === date && sadhana.rounds ? sadhana.rounds : '—'}</p><p className="mt-1 text-xs muted">target {sadhana.targetRounds}</p></div><div className="hidden rounded-xl bg-tint p-4 md:block"><p className="label">Wake-up</p><p className="mt-1 text-2xl font-bold">{sadhana.date === date && sadhana.wakeUp ? sadhana.wakeUp : '—'}</p><p className="mt-1 text-xs muted">not inferred when missing</p></div></div>
    <section className="card mb-5 p-5"><div className="flex items-center justify-between"><div><p className="label">Weekly preaching offering</p><p className="mt-1 text-xl font-bold">{weeklyMinutes ? formatMinutes(weeklyMinutes) : 'No entries'} <span className="text-sm font-normal muted">/ 2h 00m</span></p></div><TrendingUp size={20} className="text-primary" /></div><div className="mt-4 h-2 overflow-hidden rounded-full bg-tint-strong"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, (weeklyMinutes / 120) * 100)}%` }} /></div><p className="mt-3 text-sm leading-6 text-muted">A weekly minimum is a direction, not a measure of devotion.</p><button onClick={() => onNavigate('Preaching')} className="mt-4 flex items-center gap-1 text-sm font-bold text-primary">Open preaching overview <ChevronRight size={16} /></button></section>
    <div className="mb-3 flex items-center justify-between"><h2 className="font-heading text-xl font-bold">Today’s sessions</h2><button onClick={() => onNavigate('Sessions')} className="text-xs font-bold text-primary">View all</button></div>
    {todaySessions.length ? <div className="space-y-3">{todaySessions.slice(0, 3).map((item) => <SessionCard key={item.id} session={item} compact />)}</div> : <EmptyState title="A clear day" detail="No session has been recorded for today. Missing data is not treated as no activity." />}
  </>;
}

const sessionKindLabel: Record<SessionKind, string> = { Study: 'Study (Svādhyāya)', Hearing: 'Hearing (Śravaṇam)', Service: 'Service (Sevā)' };
const sessionKindIcon: Record<SessionKind, typeof Home> = { Study: NotebookPen, Hearing: Headphones, Service: HandHeart };

function SessionCard({ session, compact = false, onEdit, onDelete }: { session: SessionRecord; compact?: boolean; onEdit?: () => void; onDelete?: () => void }) {
  const tone = session.kind === 'Study' ? 'bg-tint-strong text-ink-soft' : session.kind === 'Hearing' ? 'bg-primary-tint text-primary-soft' : 'bg-tertiary-tint text-tertiary';
  if (!compact) {
    const KindIcon = sessionKindIcon[session.kind];
    return <article className="card p-4 md:p-5"><div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${tone}`}><KindIcon size={17} /></span><span className="text-xs font-bold uppercase tracking-wider text-ink-soft">{sessionKindLabel[session.kind]}</span></div><div className="flex shrink-0 gap-3 text-muted">{onEdit && <button aria-label="Edit session" onClick={onEdit}><Edit3 size={15} /></button>}{onDelete && <button aria-label="Delete session" onClick={onDelete}><Trash2 size={15} /></button>}</div></div><h3 className="font-heading mt-3 text-lg font-bold leading-snug text-primary-deep">{session.title}</h3><p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted"><Clock3 size={14} /> {formatMinutes(session.minutes)}{session.note && <><span>·</span><span className="italic">{session.note}</span></>}</p>{session.topic && <p className="mt-3 rounded-lg bg-tint p-3 text-sm leading-6 text-ink-soft"><span className="font-bold">Topic: </span>{session.topic}</p>}{session.kind === 'Service' && <p className="mt-3 rounded-lg bg-tint p-3 text-sm italic leading-6 text-ink-soft">Service is an offering, not a performance metric.</p>}</article>;
  }
  return <article className={`card p-4 ${compact ? '' : 'md:p-5'}`}><div className="flex items-start justify-between gap-3"><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${tone}`}>{session.kind}</span><div className="flex gap-3 text-muted">{onEdit && <button aria-label="Edit session" onClick={onEdit}><Edit3 size={15} /></button>}{onDelete && <button aria-label="Delete session" onClick={onDelete}><Trash2 size={15} /></button>}</div></div><h3 className="mt-3 text-base font-bold text-primary-deep">{session.title}</h3><p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted"><Clock3 size={13} /> {formatMinutes(session.minutes)} <span>·</span> {session.note || 'No note added'}</p>{session.topic && <p className="mt-2 text-sm text-muted">Topic: {session.topic}</p>}{!compact && session.kind === 'Service' && <p className="mt-3 rounded-lg bg-tint p-3 text-sm italic leading-6 text-ink-soft">Service is an offering, not a performance metric.</p>}</article>;
}

function SadhanaScreen({ record: todayRecord, onChange, sessions, setSessions }: { record: SadhanaRecord; onChange: (record: SadhanaRecord) => void; sessions: SessionRecord[]; setSessions: Dispatch<SetStateAction<SessionRecord[]>> }) {
  // `picked` is null while following today; any other date is loaded from IndexedDB on demand.
  const [picked, setPicked] = useState<string | null>(null);
  const [other, setOther] = useState<SadhanaRecord | null>(null);
  const selectedDate = picked ?? todayRecord.date;
  const isToday = selectedDate === todayRecord.date;
  const latestDate = todayString();
  useEffect(() => {
    if (isToday) return;
    let active = true;
    void loadSadhanaForDate(selectedDate).then((loaded) => { if (active) setOther(loaded); });
    return () => { active = false; };
  }, [isToday, selectedDate]);
  const shown = isToday ? todayRecord : other?.date === selectedDate ? other : null;
  const goTo = (date: string) => {
    if (!date || date > latestDate) return;
    setPicked(date === todayRecord.date ? null : date);
  };
  const previousDate = addDays(selectedDate, -1);
  const nextDate = addDays(selectedDate, 1);
  const canGoNext = selectedDate < latestDate;
  return <>
    <div className="card mb-5 flex items-stretch gap-2 p-2">
      <button type="button" aria-label={`Previous day, ${displayDate(previousDate)}`} onClick={() => goTo(previousDate)} className="flex min-w-[64px] items-center justify-center gap-1 rounded-xl bg-tint px-2 py-2 text-xs font-bold text-primary transition hover:bg-tint-strong"><ChevronLeft size={16} /> {shortDate(previousDate)}</button>
      <div className="relative min-w-0 flex-1 rounded-xl px-2 py-1 text-center transition hover:bg-tint">
        <p className="label">{new Intl.DateTimeFormat('en', { weekday: 'long' }).format(new Date(`${selectedDate}T12:00:00`))}</p>
        <p className="mt-0.5 flex items-center justify-center gap-2 text-base font-bold text-primary-deep sm:text-lg"><span className="truncate">{new Intl.DateTimeFormat('en', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${selectedDate}T12:00:00`))}</span><CalendarDays size={16} className="shrink-0 text-primary-soft" /></p>
        <input type="date" aria-label="Choose date" value={selectedDate} max={latestDate} onChange={(event) => goTo(event.target.value)} onClick={(event) => { try { event.currentTarget.showPicker?.(); } catch { /* picker opens from the native control instead */ } }} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
      </div>
      <button type="button" aria-label={`Next day, ${displayDate(nextDate)}`} disabled={!canGoNext} onClick={() => goTo(nextDate)} className="flex min-w-[64px] items-center justify-center gap-1 rounded-xl bg-tint px-2 py-2 text-xs font-bold text-primary transition hover:bg-tint-strong disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-tint">{shortDate(nextDate)} <ChevronRight size={16} /></button>
    </div>
    {shown ? <SadhanaDay key={shown.date} record={shown} isToday={isToday} onChange={isToday ? onChange : setOther} sessions={sessions} setSessions={setSessions} /> : <EmptyState title="Opening this day…" detail="Loading the saved record for the selected date." />}
  </>;
}

const practiceRows: { kind: SessionKind; icon: typeof Home; title: string; tone: string }[] = [
  { kind: 'Study', icon: NotebookPen, title: 'Scriptural Study', tone: 'bg-tint-strong' },
  { kind: 'Hearing', icon: Headphones, title: 'Hearing (Śravaṇam)', tone: 'bg-primary-tint' },
  { kind: 'Service', icon: HandHeart, title: 'Devotional Service (Sevā)', tone: 'bg-tertiary-tint' },
];

function SadhanaDay({ record, isToday, onChange, sessions, setSessions }: { record: SadhanaRecord; isToday: boolean; onChange: (record: SadhanaRecord) => void; sessions: SessionRecord[]; setSessions: Dispatch<SetStateAction<SessionRecord[]>> }) {
  const [draft, setDraft] = useState<SessionRecord | null>(null);
  const [sessionError, setSessionError] = useState('');
  const update = (patch: Partial<SadhanaRecord>) => {
    const next = { ...record, ...patch, date: record.date || todayString() };
    onChange(next);
    void saveSadhanaForDate(next).catch((error) => console.error('Could not save Sādhana record', error));
  };
  const setRounds = (value: number) => {
    const rounds = Math.min(64, Math.max(0, value));
    update({ rounds, earlyRounds: Math.min(record.earlyRounds, rounds) });
  };
  const setEarly = (value: number) => update({ earlyRounds: Math.min(record.rounds, Math.max(0, value || 0)) });
  const toggleQuality = (tag: QualityTag) => {
    const selected = record.qualityTags ?? [];
    update({ qualityTags: QUALITY_TAGS.filter((option) => option === tag ? !selected.includes(option) : selected.includes(option)) });
  };
  const timeStatus =record.sixteenthRoundTime ? 'Completed' : record.rounds >= record.targetRounds ? 'Time not recorded' : 'In progress';
  const daySessions = sessions.filter((item) => item.date === record.date);
  const sessionRows = practiceRows.map((row) => {
    const items = daySessions.filter((item) => item.kind === row.kind);
    return { ...row, items: items.slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0)), count: items.length, minutes: items.reduce((sum, item) => sum + item.minutes, 0), titles: Array.from(new Set(items.map((item) => item.title))) };
  });
  const coreFilled = [record.rounds > 0, record.wakeUp.trim() !== '', record.bedtime.trim() !== '', record.sleepOnset.trim() !== '', record.mangalaArati !== 'Unrecorded'].filter(Boolean).length;
  const hasAnything = coreFilled > 0 || record.reflection.trim() !== '' || daySessions.length > 0;
  const status = coreFilled === 5 ? 'Core fields recorded' : hasAnything ? 'Partially recorded' : 'Not started';
  const observed = [
    { name: 'Japa', done: record.rounds > 0 }, { name: 'Maṅgala Ārati', done: record.mangalaArati === 'Attended' },
    ...sessionRows.map((row) => ({ name: row.kind === 'Service' ? 'Sevā' : row.kind, done: row.count > 0 })),
  ].filter((item) => item.done).map((item) => item.name);
  const savingSession = useRef(false);
  const saveSession = async (item: SessionRecord) => {
    if (savingSession.current) return;
    savingSession.current = true;
    try {
      if (item.id !== undefined) {
        await db.sessions.update(item.id, item);
        setSessions((current) => current.map((existing) => existing.id === item.id ? item : existing));
      } else {
        const id = await db.sessions.add(item);
        setSessions((current) => [...current, { ...item, id }]);
      }
      setDraft(null);
    } catch (error) { console.error('Could not save session', error); setSessionError('Could not save this session. Your entry is still open; please try again.'); }
    finally { savingSession.current = false; }
  };
  return <>
    <section className="mb-6 flex items-center justify-between gap-4"><div><p className="label">{displayDate(record.date || todayString())}</p><h1 className="font-heading mt-2 text-3xl font-bold text-primary-deep">{isToday ? 'Today’s Sādhana' : 'Sādhana record'}</h1><p className="mt-2 text-sm leading-6 muted">A quiet record of the practices that turn the heart toward service.</p></div><div className="hidden rounded-2xl bg-primary-tint p-4 text-primary md:block"><Sparkles size={25} /></div></section>
    <div className="mb-5 flex items-center justify-between rounded-xl bg-tint-strong px-4 py-3 text-xs font-semibold text-muted"><span className="flex items-center gap-2"><ShieldCheck size={16} className="text-tertiary" /> {hasAnything ? `${coreFilled} of 5 core fields recorded · saved on this device` : 'Nothing recorded for this day yet · entries save on this device'}</span><span className="rounded-full bg-page px-2 py-1">{status}</span></div>
    <section className="card mb-5 p-5"><div className="flex items-center justify-between"><div><p className="label">Daily devotional record</p><h2 className="mt-1 text-xl font-bold">Steep heart in contemplation</h2><p className="mt-1 text-sm muted">{observed.length ? `${observed.length} of 5 practices have recorded activity${isToday ? ' today' : ' on this day'}: ${observed.join(', ')}.` : `No practice activity recorded${isToday ? ' today' : ' on this day'} yet.`}</p></div><div className="rounded-full bg-tint-strong p-3 text-primary"><NotebookPen size={20} /></div></div></section>
    <section className="card mb-5 p-5"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Moon size={21} className="text-secondary-ink" /><h2 className="text-xl font-bold">Sleep & Rising Times</h2></div><span className="label">Core fields</span></div><div className="mt-4 grid gap-3 sm:grid-cols-3"><TimeField icon={AlarmClock} label="Wake-up time" value={record.wakeUp} onChange={(value) => update({ wakeUp: value })} /><TimeField icon={BedDouble} label="Bedtime" value={record.bedtime} onChange={(value) => update({ bedtime: value })} /><TimeField icon={BedDouble} label="Sleep onset" value={record.sleepOnset} onChange={(value) => update({ sleepOnset: value })} /></div></section>
    <section className="card mb-5 p-5"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Sun size={21} className="text-secondary-ink" /><h2 className="text-xl font-bold">Maṅgala Ārati</h2></div><span className="label">Dawn worship</span></div><div className="mt-4 grid grid-cols-3 gap-2">{(['Attended', 'Not today', 'Unrecorded'] as const).map((option) => <button key={option} type="button" aria-pressed={record.mangalaArati === option} onClick={() => update({ mangalaArati: option })} className={`rounded-xl px-2 py-3 text-xs font-bold transition ${record.mangalaArati === option ? 'bg-primary text-white' : 'bg-tint text-muted hover:bg-tint-strong'}`}>{record.mangalaArati === option && <Check className="mr-1 inline" size={14} />}{option}</button>)}</div><p className="mt-3 flex items-start gap-2 text-xs leading-5 muted"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-tertiary" /> Neutral presence: ‘Unrecorded’ protects honest reflection without punitive markers or streak loss.</p></section>
    <section className="card mb-5 p-5"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Moon size={21} className="text-secondary-ink" /><h2 className="text-xl font-bold">Japa Meditation</h2></div><label className="flex items-center gap-1 rounded-full bg-tint-strong px-3 py-1 text-xs font-bold text-secondary-ink">Target <input type="number" min="1" max="64" value={record.targetRounds} onChange={(event) => update({ targetRounds: Number(event.target.value) || 1 })} className="w-8 bg-transparent text-center outline-none" /> rounds</label></div><div className="mt-4 grid grid-cols-2 gap-3"><div className="rounded-xl bg-tint p-3"><p className="label">Rounds chanted</p><p className="mt-2 flex items-baseline gap-1"><span className="text-3xl font-bold text-primary-deep">{record.rounds}</span><span className="text-xs muted">/ {record.targetRounds} total</span></p><div className="mt-3 flex gap-2"><button type="button" aria-label="Remove one round" disabled={record.rounds === 0} onClick={() => setRounds(record.rounds - 1)} className="btn-secondary px-3 py-2 text-sm disabled:opacity-40">−</button><button type="button" aria-label="Add one round" onClick={() => setRounds(record.rounds + 1)} className="btn-primary flex flex-1 items-center justify-center gap-1 px-3 py-2 text-sm"><Plus size={16} /> Round</button></div></div><div className="rounded-xl bg-tint p-3"><p className="label flex items-center justify-between gap-2">Early rounds <Sun size={14} className="text-primary-soft" /></p><p className="mt-2 flex items-baseline gap-1"><input type="number" min="0" max={record.rounds} value={record.earlyRounds} aria-label="Rounds completed before 7:00 AM" onChange={(event) => setEarly(Number(event.target.value))} className="w-14 bg-transparent text-3xl font-bold text-primary-deep outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" /><span className="text-xs muted">before 7:00 AM</span></p><div className="mt-3 flex gap-2"><button type="button" aria-label="Remove one early round" disabled={record.earlyRounds === 0} onClick={() => setEarly(record.earlyRounds - 1)} className="btn-secondary px-3 py-2 text-sm disabled:opacity-40">−</button><button type="button" aria-label="Add one early round" disabled={record.earlyRounds >= record.rounds} onClick={() => setEarly(record.earlyRounds + 1)} className="btn-secondary flex flex-1 items-center justify-center gap-1 px-3 py-2 text-sm disabled:opacity-40"><Plus size={16} /> Early</button></div></div></div><div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-tint p-3"><label className="min-w-0 flex-1"><span className="label block">Time 16th round completed</span><input type="time" value={record.sixteenthRoundTime} onChange={(event) => update({ sixteenthRoundTime: event.target.value })} className="mt-2 w-full rounded-lg border border-line bg-white p-2 text-sm" /></label><span className="shrink-0 rounded-full bg-tint-strong px-3 py-1 text-xs font-bold text-muted">{timeStatus}</span></div><div className="mt-4"><p id="quality-label" className="label">Attention & inner quality</p><div role="group" aria-labelledby="quality-label" className="mt-2 flex flex-wrap gap-2">{QUALITY_TAGS.map((tag) => { const on = (record.qualityTags ?? []).includes(tag); return <button key={tag} type="button" aria-pressed={on} onClick={() => toggleQuality(tag)} className={`flex items-center gap-1 rounded-full px-3 py-2 text-xs font-bold transition ${on ? 'bg-primary-tint-strong text-primary' : 'bg-tint-strong text-muted hover:bg-tint'}`}>{on && <Check size={13} />}{tag}</button>; })}</div></div><p className="mt-3 text-sm leading-6 muted">Attentive, steady recitation offered with reverence.</p></section>
    <section className="mb-5"><div className="mb-3 flex items-center justify-between gap-3"><h2 className="font-heading text-xl font-bold">Session Offerings</h2><span className="label">{daySessions.length} total {isToday ? 'today' : 'this day'}</span></div><div className="space-y-4">{sessionRows.map(({ kind, icon: Icon, title, tone, count, minutes, items }) => <div key={kind} className="card p-4"><div className="flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><div className={`shrink-0 rounded-xl p-2 text-primary ${tone}`}><Icon size={18} /></div><h3 className="font-heading text-base font-bold text-primary-deep">{title}</h3></div><span className="shrink-0 rounded-full bg-tint-strong px-3 py-1 text-xs font-bold text-ink-soft">{count ? `${count} session${count === 1 ? '' : 's'} · ${formatMinutes(minutes)}` : 'None recorded'}</span></div>{items.length > 0 && <div className="mt-3 space-y-2">{items.map((item) => <div key={item.id} className="flex items-center gap-3 rounded-xl bg-tint p-3"><div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-primary-deep">{item.title}</p>{(item.topic || item.note) && <p className="truncate text-xs muted">{item.topic || item.note}</p>}</div><span className="shrink-0 text-xs font-bold text-primary">{formatMinutes(item.minutes)}</span><button type="button" aria-label={`Edit ${item.title}`} onClick={() => { setSessionError(''); setDraft(item); }} className="shrink-0 text-muted"><Edit3 size={15} /></button></div>)}</div>}<button type="button" onClick={() => { setSessionError(''); setDraft({ date: record.date, kind, title: '', minutes: 30, note: '' }); }} className="btn-outlined mt-3 flex w-full items-center justify-center gap-2 px-3 py-3 text-sm"><Plus size={16} /> Add {kind} Session</button></div>)}</div></section>
    <section className="card mb-5 p-5"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Clock3 size={20} className="text-secondary-ink" /><h2 className="text-xl font-bold">Daily reflection</h2></div><span className="label flex items-center gap-1"><Lock size={12} /> Private</span></div><textarea value={record.reflection} onChange={(event) => update({ reflection: event.target.value })} placeholder="Record any insight, gratitude, or intention for tomorrow’s morning practice..." rows={4} className="mt-4 w-full resize-none rounded-xl border border-line bg-surface p-3 text-sm leading-6 outline-none focus:border-primary-soft" /><p className="mt-2 text-xs muted">Stays on this device.</p></section>
    <p className="flex items-center gap-2 rounded-xl bg-tint-strong p-4 text-xs leading-5 text-muted"><ShieldCheck size={18} className="shrink-0 text-primary" /> Records are stored in this browser’s IndexedDB. Browser storage is not encrypted, so make periodic backups in Settings.</p>
    {draft && <SessionEditor draft={draft} error={sessionError} onChange={setDraft} onClose={() => { setDraft(null); setSessionError(''); }} onSave={() => void saveSession(draft)} />}
  </>;
}

function TimeField({ icon: Icon, label, value, onChange }: { icon: typeof AlarmClock; label: string; value: string; onChange: (value: string) => void }) { return <label className="flex items-center gap-3 rounded-xl bg-tint p-3"><span className="rounded-full bg-tint-strong p-2 text-primary"><Icon size={17} /></span><span className="min-w-0 flex-1"><span className="label block">{label}</span><input value={value} placeholder="Not recorded" onChange={(event) => onChange(event.target.value)} className="mt-1 w-full bg-transparent text-sm font-bold text-primary-deep outline-none placeholder:font-normal placeholder:text-muted" /></span></label>; }

type SessionTimeframe = '7' | '30' | 'all';
const sessionTimeframes: { value: SessionTimeframe; label: string }[] = [{ value: '7', label: 'Past 7 days' }, { value: '30', label: 'Past 30 days' }, { value: 'all', label: 'All time' }];

function SessionsScreen({ sessions, setSessions }: { sessions: SessionRecord[]; setSessions: Dispatch<SetStateAction<SessionRecord[]>> }) {
  const [filter, setFilter] = useState<'All' | SessionKind>('All');
  const [timeframe, setTimeframe] = useState<SessionTimeframe>('7');
  const [showWeekly, setShowWeekly] = useState(false);
  const [draft, setDraft] = useState<SessionRecord | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SessionRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const today = todayString();
  // "Past 7 days" is today and the six local days before it; later-dated sessions are never hidden.
  const earliest = timeframe === 'all' ? '' : addDays(today, timeframe === '7' ? -6 : -29);
  const byKind = filter === 'All' ? sessions : sessions.filter((item) => item.kind === filter);
  const visible = byKind.filter((item) => !earliest || item.date >= earliest);
  const hiddenCount = byKind.length - visible.length;
  const days = Array.from(new Set(visible.map((item) => item.date))).sort().reverse().map((date) => {
    const items = visible.filter((item) => item.date === date).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    return { date, items, minutes: items.reduce((sum, item) => sum + item.minutes, 0) };
  });
  const todaySessions = sessions.filter((item) => item.date === today);
  const todayMinutes = todaySessions.reduce((sum, item) => sum + item.minutes, 0);
  const weekSessions = sessions.filter((item) => isCurrentWeek(item.date));
  const weekMinutes = weekSessions.reduce((sum, item) => sum + item.minutes, 0);
  const plural = (count: number) => `${count} session${count === 1 ? '' : 's'}`;
  const save = async (record: SessionRecord) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (record.id !== undefined) {
        await db.sessions.update(record.id, record);
        setSessions((current) => current.map((item) => item.id === record.id ? record : item));
      } else {
        const id = await db.sessions.add(record);
        setSessions((current) => [...current, { ...record, id }]);
      }
      setDraft(null);
    } catch (failure) { console.error('Could not save session', failure); setError('Could not save this session. Your entry is still open; please try again.'); }
    finally { setBusy(false); }
  };
  const confirmDelete = async () => {
    if (pendingDelete?.id === undefined || busy) return;
    const id = pendingDelete.id;
    setBusy(true); setError('');
    try { await db.sessions.delete(id); setSessions((current) => current.filter((item) => item.id !== id)); setPendingDelete(null); }
    catch (failure) { console.error('Could not delete session', failure); setError('Could not delete this session. It has been kept; please try again.'); }
    finally { setBusy(false); }
  };
  const closeDelete = () => { if (busy) return; setPendingDelete(null); setError(''); };
  return <>
    <div className="mb-3 flex items-start justify-between gap-4"><div className="min-w-0"><p className="label mb-2 flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-primary" /> Daily journal of humble offerings</p><h1 className="font-heading text-3xl font-bold leading-tight text-primary-deep md:text-4xl">Session Logs</h1></div><button onClick={() => { setError(''); setDraft({ date: todayString(), kind: 'Study', title: '', minutes: 30, note: '' }); }} className="btn-primary flex shrink-0 items-center gap-2 px-4 py-3 text-sm shadow-md"><Plus size={16} /> New session</button></div>
    <p className="mb-6 max-w-lg text-sm leading-6 text-muted">A record of svādhyāya, hearing, and humble service—offered without haste or performance pressure.</p>
    <section className="card mb-5 flex items-center gap-3 p-3"><div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-tint-strong text-primary"><BookOpen size={20} /></div><div className="min-w-0 flex-1"><p className="label">Today’s dedication</p><p className="mt-1 text-xl font-bold text-primary-deep">{todayMinutes ? formatMinutes(todayMinutes) : '—'}</p></div><span className="shrink-0 rounded-xl bg-tint px-3 py-2 text-xs font-bold text-ink-soft">{todaySessions.length ? `${todaySessions.length} ${todaySessions.length === 1 ? 'practice' : 'practices'} recorded` : 'None recorded'}</span></section>
    <div className="mb-4 flex gap-2 overflow-x-auto">{(['All', 'Study', 'Hearing', 'Service'] as const).map((item) => <button key={item} onClick={() => setFilter(item)} className={`whitespace-nowrap rounded-full px-4 py-2 text-xs font-bold ${filter === item ? 'bg-primary-tint-strong text-primary' : 'bg-white text-muted'}`}>{item === 'All' ? 'All Sessions' : sessionKindLabel[item]}</button>)}</div>
    <div className="mb-5 flex items-center justify-between gap-3"><label className="flex min-w-0 items-center gap-2 text-xs font-bold text-muted">Timeframe<select value={timeframe} onChange={(event) => setTimeframe(event.target.value as SessionTimeframe)} className="field !w-auto bg-white !p-2 text-xs">{sessionTimeframes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><button type="button" aria-expanded={showWeekly} onClick={() => setShowWeekly((open) => !open)} className="shrink-0 text-xs font-bold text-primary">Weekly summary</button></div>
    {showWeekly && <section className="card mb-5 p-5"><p className="label">Weekly summary</p><p className="mt-1 text-xs font-semibold text-muted">Current week · {currentWeekLabel()}</p>{weekSessions.length ? <><div className="mt-4 grid grid-cols-2 gap-2"><div className="rounded-xl bg-tint p-3"><p className="label">Total time</p><p className="mt-1 text-xl font-bold text-primary">{formatMinutes(weekMinutes)}</p></div><div className="rounded-xl bg-tint p-3"><p className="label">Sessions</p><p className="mt-1 text-xl font-bold text-primary">{weekSessions.length}</p></div></div><div className="mt-3 space-y-2">{(['Study', 'Hearing', 'Service'] as const).map((kind) => { const items = weekSessions.filter((item) => item.kind === kind); return <div key={kind} className="flex items-baseline justify-between gap-3 rounded-xl bg-tint p-3"><p className="text-sm font-bold text-ink-soft">{sessionKindLabel[kind]}</p><p className="text-sm font-bold text-primary">{items.length ? `${formatMinutes(items.reduce((sum, item) => sum + item.minutes, 0))} · ${plural(items.length)}` : '—'}</p></div>; })}</div></> : <p className="mt-3 text-sm leading-6 text-muted">No sessions recorded this week. Missing data is not treated as no activity.</p>}</section>}
    {days.length ? <div className="space-y-6">{days.map((day) => <section key={day.date}><div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><h2 className="font-heading flex items-center gap-2 text-xl font-bold"><span className="h-1.5 w-1.5 rounded-full bg-primary" /> {offeringDateLabel(day.date)}</h2><span className="text-xs text-muted">{plural(day.items.length)} · {formatMinutes(day.minutes)} total</span></div><div className="space-y-3">{day.items.map((item) => <SessionCard key={item.id} session={item} onEdit={() => { setError(''); setDraft(item); }} onDelete={() => { setError(''); setPendingDelete(item); }} />)}</div></section>)}</div> : <EmptyState title="No sessions in this view" detail="Add a study, hearing, or service entry when you are ready, or widen the timeframe. Missing data is not treated as no activity." />}
    {hiddenCount > 0 && <p className="mt-4 text-center text-xs text-muted">{plural(hiddenCount)} outside this timeframe. Choose All time to see them.</p>}
    {draft && <SessionEditor draft={draft} error={error} onChange={setDraft} onClose={() => { if (!busy) { setDraft(null); setError(''); } }} onSave={() => void save(draft)} />}
    {pendingDelete && <div className="fixed inset-0 z-30 grid place-items-center bg-ink/30 p-5"><div role="alertdialog" aria-modal="true" aria-labelledby="delete-session-title" className="card w-full max-w-sm p-6"><h2 id="delete-session-title" className="font-heading text-xl font-bold">Delete this session?</h2><p className="mt-2 text-sm leading-6 text-muted">{pendingDelete.title} · {offeringDateLabel(pendingDelete.date)} · {formatMinutes(pendingDelete.minutes)}. This cannot be undone. Only this session is removed.</p>{error && <p role="alert" className="mt-3 rounded-lg bg-danger-tint p-3 text-xs font-semibold text-danger">{error}</p>}<div className="mt-5 flex gap-2"><button onClick={closeDelete} disabled={busy} className="btn-outlined flex-1 px-4 py-3 text-sm">Cancel</button><button onClick={() => void confirmDelete()} disabled={busy} className="btn-danger flex-1 px-4 py-3 text-sm disabled:opacity-60">{busy ? 'Deleting…' : 'Delete'}</button></div></div></div>}
  </>;
}

function SessionEditor({ draft, error, onChange, onClose, onSave }: { draft: SessionRecord; error?: string; onChange: (record: SessionRecord) => void; onClose: () => void; onSave: () => void }) {
  const patch = (value: Partial<SessionRecord>) => onChange({ ...draft, ...value });
  return <div className="fixed inset-0 z-30 grid place-items-center bg-ink/30 p-5"><form onSubmit={(event) => { event.preventDefault(); onSave(); }} className="card w-full max-w-md p-6"><div className="mb-5 flex items-center justify-between"><h2 className="font-heading text-xl font-bold">{draft.id ? 'Edit session' : 'New session'}</h2><button type="button" onClick={onClose}><X size={20} /></button></div><label className="label">Practice type<select value={draft.kind} onChange={(event) => patch({ kind: event.target.value as SessionKind })} className="mt-2 field bg-white"><option>Study</option><option>Hearing</option><option>Service</option></select></label><label className="label mt-4 block">{draft.kind === 'Study' ? 'Scripture or book' : draft.kind === 'Hearing' ? 'Source or speaker' : 'Service description'}<input required value={draft.title} onChange={(event) => patch({ title: event.target.value })} className="mt-2 field" /></label><div className="mt-4 grid grid-cols-2 gap-3"><label className="label">Date<input required type="date" value={draft.date} onChange={(event) => patch({ date: event.target.value })} className="mt-2 field" /></label><label className="label">Minutes<input required min="1" type="number" value={draft.minutes} onChange={(event) => patch({ minutes: Number(event.target.value) })} className="mt-2 field" /></label></div><label className="label mt-4 block">Topic or notes<textarea value={draft.note || ''} onChange={(event) => patch({ note: event.target.value })} rows={3} className="mt-2 field resize-none" /></label>{error && <p role="alert" className="mt-4 rounded-lg bg-danger-tint p-3 text-xs font-semibold text-danger">{error}</p>}<button className="mt-5 w-full btn-primary px-4 py-3 text-sm">Save session</button></form></div>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) { return <div className="card p-8 text-center"><Circle className="mx-auto mb-3 text-primary-soft" size={25} /><p className="font-bold">{title}</p><p className="mt-2 text-sm leading-6 muted">{detail}</p></div>; }

const WEEKLY_TARGET_MINUTES = 120;

/** "Today, 24 Oct" / "Yesterday, 23 Oct" / "Mon, 21 Oct" (year added when not the current year). Uses local calendar dates. */
function offeringDateLabel(date: string): string {
  const today = todayString();
  const day = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00`));
  if (date === today) return `Today, ${day}`;
  if (date === addDays(today, -1)) return `Yesterday, ${day}`;
  return new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short', ...(date.slice(0, 4) !== today.slice(0, 4) ? { year: 'numeric' as const } : {}) }).format(new Date(`${date}T12:00:00`));
}

/** Monday–Sunday label for the current local week; the same Monday-start week that isCurrentWeek uses. */
function currentWeekLabel(): string {
  const today = todayString();
  const day = new Date(`${today}T12:00:00`).getDay();
  const monday = addDays(today, -(day === 0 ? 6 : day - 1));
  return `${shortDate(monday)} – ${shortDate(addDays(monday, 6))}`;
}

function OfferingReport({ heading, range, offerings, progress }: { heading: string; range: string; offerings: OfferingRecord[]; progress?: { percent: number; text: string } }) {
  const total = offerings.reduce((sum, item) => sum + item.minutes, 0);
  const categories = Object.entries(offerings.reduce<Record<string, number>>((totals, item) => ({ ...totals, [item.kind]: (totals[item.kind] || 0) + item.minutes }), {})).sort((a, b) => b[1] - a[1]);
  if (!offerings.length) return <EmptyState title="No offerings in this period" detail={`Nothing has been logged for ${range}. Missing data is not treated as no activity.`} />;
  return <section className="card p-5"><p className="label">{heading}</p><p className="mt-1 text-xs font-semibold text-muted">{range}</p><div className="mt-4 grid grid-cols-2 gap-2"><div className="rounded-xl bg-tint p-3"><p className="label">Total time</p><p className="mt-1 text-xl font-bold text-primary">{formatMinutes(total)}</p></div><div className="rounded-xl bg-tint p-3"><p className="label">Offerings</p><p className="mt-1 text-xl font-bold text-primary">{offerings.length}</p></div></div>{progress && <div className="mt-4"><div className="flex items-baseline justify-between gap-3 text-xs font-bold text-muted"><span>{progress.percent}% of the 2h 00m weekly offering</span><span>{progress.text}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-tint-strong"><div className="h-full rounded-full bg-primary" style={{ width: `${progress.percent}%` }} /></div></div>}<p className="label mt-5">Category breakdown</p><div className="mt-3 space-y-3">{categories.map(([category, minutes]) => <div key={category}><div className="flex items-baseline justify-between gap-3"><p className="min-w-0 text-sm font-bold text-ink-soft">{category}</p><p className="shrink-0 text-sm font-bold text-primary">{formatMinutes(minutes)}</p></div><div className="mt-1 h-1.5 overflow-hidden rounded-full bg-tint-strong"><div className="h-full rounded-full bg-primary-soft" style={{ width: `${Math.round((minutes / total) * 100)}%` }} /></div></div>)}</div></section>;
}

function PreachingScreen({ offerings, onAdd, onEdit, onDelete }: { offerings: OfferingRecord[]; onAdd: () => void; onEdit: (record: OfferingRecord) => void; onDelete: (id: number) => Promise<void> }) {
  const [period, setPeriod] = useState<'week' | 'weekly' | 'month'>('week');
  const [pendingDelete, setPendingDelete] = useState<OfferingRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  // `visible` is the current week's list. The vow card and Weekly reports use the same week; Monthly reports use the current month.
  const visible = offerings.filter((item) => isCurrentWeek(item.date)).sort((a, b) => b.date.localeCompare(a.date));
  const monthOfferings = offerings.filter((item) => isCurrentMonth(item.date));
  const total = visible.reduce((sum, item) => sum + item.minutes, 0);
  const weeklyTotal = total;
  const percent = Math.min(100, Math.floor((weeklyTotal / WEEKLY_TARGET_MINUTES) * 100));
  const remaining = Math.max(0, WEEKLY_TARGET_MINUTES - weeklyTotal);
  const remainingText = remaining > 0 ? `${formatMinutes(remaining)} remaining` : weeklyTotal > WEEKLY_TARGET_MINUTES ? `Target exceeded by ${formatMinutes(weeklyTotal - WEEKLY_TARGET_MINUTES)}` : 'Target reached';
  const categoryTotals = visible.reduce<Record<string, number>>((totals, item) => ({ ...totals, [item.kind]: (totals[item.kind] || 0) + item.minutes }), {});
  const closeDelete = () => { if (deleting) return; setPendingDelete(null); setDeleteError(''); };
  const confirmDelete = async () => {
    if (pendingDelete?.id === undefined) return;
    setDeleting(true); setDeleteError('');
    try { await onDelete(pendingDelete.id); setPendingDelete(null); }
    catch (error) { console.error('Could not delete offering', error); setDeleteError('Could not delete this offering. It has been kept; please try again.'); }
    finally { setDeleting(false); }
  };
  return <><ScreenTitle eyebrow="Humble offerings of saṅkīrtana, youth guidance, and devotional care" title="Preaching & Outreach"><p className="mt-2 max-w-lg text-sm leading-6 text-muted">A dedicated place for activity records and gentle weekly and monthly review.</p></ScreenTitle><section className="card mb-5 p-5"><div className="flex items-start justify-between"><div><p className="label">Personal vow</p><p className="mt-2 text-xl font-bold">Weekly Offering</p></div><div className="text-right"><p className="text-xl font-bold text-primary">{formatMinutes(weeklyTotal)} <span className="text-sm font-normal muted">/ 2h 00m</span></p><p className="mt-1 text-xs font-bold text-muted">{remainingText}</p></div></div><div className="mt-5 h-2 overflow-hidden rounded-full bg-tint-strong" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Weekly offering progress"><div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} /></div><div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"><p className="text-sm font-semibold text-muted">{percent}% of the weekly offering</p><p className="text-xs italic text-muted">A quiet personal discipline, not a performance metric</p></div></section><div className="mb-5 flex items-start gap-3 rounded-xl bg-tint p-3 text-sm italic leading-6 text-ink-soft"><Flower2 size={18} className="mt-1 shrink-0 text-primary-soft" /><p>“Every step in saṅkīrtana is a conscious offering of love, free from the desire for praise.”</p></div><button onClick={onAdd} className="btn-primary mb-7 flex w-full items-center justify-center gap-2 px-4 py-4 text-sm tracking-wide shadow-md"><Plus size={19} /> Log preaching offering</button><div className="mb-5 flex rounded-xl bg-tint-strong p-1 text-sm font-bold text-muted"><button onClick={() => setPeriod('week')} className={`flex-1 rounded-lg px-3 py-2 ${period === 'week' ? 'bg-white text-primary-deep shadow-sm' : ''}`}>This week</button><button onClick={() => setPeriod('weekly')} className={`flex-1 rounded-lg px-3 py-2 ${period === 'weekly' ? 'bg-white text-primary-deep shadow-sm' : ''}`}>Weekly reports</button><button onClick={() => setPeriod('month')} className={`flex-1 rounded-lg px-3 py-2 ${period === 'month' ? 'bg-white text-primary-deep shadow-sm' : ''}`}>Monthly reports</button></div>{period === 'week' ? <><div className="mb-3 flex items-center justify-between"><p className="label">Offerings in current cycle ({visible.length})</p><span className="text-xs font-bold muted">{formatMinutes(total)} total</span></div>{visible.length ? <div className="space-y-4">{visible.map((item) => <article key={item.id} className="card p-4"><div className="flex items-center justify-between gap-3"><div className="flex min-w-0 flex-wrap items-center gap-2"><span className="rounded-full bg-primary-tint px-3 py-1.5 text-xs font-bold text-primary-soft">{item.kind}</span><span className="text-xs font-bold text-muted">{offeringDateLabel(item.date)}</span></div><div className="flex shrink-0 gap-3 text-muted"><button aria-label="Edit offering" onClick={() => onEdit(item)}><Edit3 size={15} /></button><button aria-label="Delete offering" onClick={() => { setDeleteError(''); setPendingDelete(item); }}><Trash2 size={15} /></button></div></div><div className="mt-3 flex items-baseline justify-between gap-3"><p className="text-xl font-bold text-primary">{formatMinutes(item.minutes)}</p><span className="text-xs font-semibold text-tertiary">Sanctified Offering</span></div><p className="mt-2 rounded-lg bg-tint p-3 text-sm leading-6 text-ink-soft">{item.description}</p></article>)}</div> : <EmptyState title="No offerings in this cycle" detail="Log a preaching offering when you are ready. Missing data is not treated as no activity." />}{visible.length > 0 && <div className="card mt-5 p-5"><p className="label">Category breakdown</p><div className="mt-3 grid grid-cols-2 gap-2">{Object.entries(categoryTotals).map(([category, minutes]) => <div key={category} className="rounded-xl bg-tint p-3"><p className="text-xs font-bold text-ink-soft">{category}</p><p className="mt-1 font-bold text-primary">{formatMinutes(minutes)}</p></div>)}</div></div>}</> : period === 'weekly' ? <OfferingReport heading="Weekly report" range={`Current week · ${currentWeekLabel()}`} offerings={visible} progress={{ percent, text: remainingText }} /> : <OfferingReport heading="Monthly report" range={new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' }).format(new Date())} offerings={monthOfferings} />}<aside className="mt-5 rounded-2xl bg-tint p-5"><p className="label">Śrī Kṛṣṇa’s promise to the preacher</p><p className="font-heading mt-3 text-lg italic leading-8">“ya idaṁ paramam guhyaṁ mad-bhakteṣv abhidhāsyati”</p><p className="mt-3 text-sm leading-6 text-muted">For one who explains this supreme secret to the devotees, pure devotional service is guaranteed.</p></aside>{pendingDelete && <div className="fixed inset-0 z-30 grid place-items-center bg-ink/30 p-5"><div role="alertdialog" aria-modal="true" aria-labelledby="delete-offering-title" className="card w-full max-w-sm p-6"><h2 id="delete-offering-title" className="font-heading text-xl font-bold">Delete this offering?</h2><p className="mt-2 text-sm leading-6 text-muted">{pendingDelete.kind} · {offeringDateLabel(pendingDelete.date)} · {formatMinutes(pendingDelete.minutes)}. This cannot be undone. Only this offering is removed.</p>{deleteError && <p role="alert" className="mt-3 rounded-lg bg-danger-tint p-3 text-xs font-semibold text-danger">{deleteError}</p>}<div className="mt-5 flex gap-2"><button onClick={closeDelete} disabled={deleting} className="btn-outlined flex-1 px-4 py-3 text-sm">Cancel</button><button onClick={() => void confirmDelete()} disabled={deleting} className="btn-danger flex-1 px-4 py-3 text-sm disabled:opacity-60">{deleting ? 'Deleting…' : 'Delete'}</button></div></div></div>}</>;
}

function InsightsScreen({ sessions, offerings, sadhana }: { sessions: SessionRecord[]; offerings: OfferingRecord[]; sadhana: SadhanaRecord }) {
  const chart = [0, 1, 2, 3].map((week) => ({ name: `Week ${week + 1}`, study: sessions.filter((item) => item.kind === 'Study' && Math.floor((new Date(`${item.date}T12:00:00`).getDate() - 1) / 7) === week).reduce((sum, item) => sum + item.minutes, 0), hearing: sessions.filter((item) => item.kind === 'Hearing' && Math.floor((new Date(`${item.date}T12:00:00`).getDate() - 1) / 7) === week).reduce((sum, item) => sum + item.minutes, 0), service: sessions.filter((item) => item.kind === 'Service' && Math.floor((new Date(`${item.date}T12:00:00`).getDate() - 1) / 7) === week).reduce((sum, item) => sum + item.minutes, 0) }));
  const sessionMinutes = sessions.reduce((sum, item) => sum + item.minutes, 0);
  const hearingMinutes = sessions.filter((item) => item.kind === 'Hearing').reduce((sum, item) => sum + item.minutes, 0);
  const roundData = sadhana.rounds ? [{ day: displayDate(sadhana.date), rounds: sadhana.rounds }] : [];
  return <><ScreenTitle eyebrow="Historical view · reports" title="Insights"><p className="mt-2 max-w-lg text-sm leading-6 text-muted">Patterns for reflection, never a scorecard. Every number below comes from saved local records.</p></ScreenTitle><div className="grid grid-cols-2 gap-3 md:grid-cols-4"><StatCard label="Sessions logged" value={String(sessions.length)} detail={sessionMinutes ? formatMinutes(sessionMinutes) : 'No activity yet'} icon={Archive} /><StatCard label="Recorded rounds" value={sadhana.rounds ? String(sadhana.rounds) : '—'} detail={`Target: ${sadhana.targetRounds} daily`} icon={Sun} /><StatCard label="Total hearing" value={hearingMinutes ? formatMinutes(hearingMinutes) : '—'} detail="Saved sessions only" icon={BookOpen} /><StatCard label="Preaching" value={offerings.length ? formatMinutes(offerings.reduce((sum, item) => sum + item.minutes, 0)) : '—'} detail="Saved offerings" icon={Users} /></div><ChartCard title="Chanting rounds" subtitle="Saved daily records"><ResponsiveContainer width="100%" height={230}><LineChart data={roundData}><CartesianGrid stroke="rgb(var(--c-line-soft))" vertical={false} /><XAxis dataKey="day" tick={{ fontSize: 11, fill: 'rgb(var(--c-muted))' }} /><YAxis domain={[0, Math.max(20, sadhana.targetRounds)]} tick={{ fontSize: 11, fill: 'rgb(var(--c-muted))' }} /><Tooltip /><Line type="monotone" dataKey="rounds" stroke="rgb(var(--c-primary))" strokeWidth={3} dot={{ fill: 'rgb(var(--c-primary))', r: 3 }} /></LineChart></ResponsiveContainer>{!roundData.length && <p className="text-center text-sm muted">No chanting records yet.</p>}</ChartCard><ChartCard title="Study, hearing & service duration" subtitle="Current calendar-month minutes"><ResponsiveContainer width="100%" height={230}><BarChart data={chart} barGap={4}><CartesianGrid stroke="rgb(var(--c-line-soft))" vertical={false} /><XAxis dataKey="name" tick={{ fontSize: 11, fill: 'rgb(var(--c-muted))' }} /><YAxis tick={{ fontSize: 11, fill: 'rgb(var(--c-muted))' }} /><Tooltip /><Bar dataKey="study" name="Study" fill="rgb(var(--c-tertiary))" radius={[5, 5, 0, 0]} /><Bar dataKey="hearing" name="Hearing" fill="rgb(var(--c-primary))" radius={[5, 5, 0, 0]} /><Bar dataKey="service" name="Service" fill="rgb(var(--c-primary-soft))" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></ChartCard><div className="card mt-5 p-5"><p className="label">Reflection</p><p className="mt-2 text-sm leading-7 text-ink-soft">{sessions.length ? `You have saved ${sessions.length} session${sessions.length === 1 ? '' : 's'} and ${offerings.length} preaching offering${offerings.length === 1 ? '' : 's'}.` : 'Your historical view will grow as you record practice.'}</p></div></>;
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) { return <section className="card mt-5 p-4 md:p-5"><div className="mb-4"><p className="font-bold text-primary-deep">{title}</p><p className="mt-1 text-xs muted">{subtitle}</p></div>{children}</section>; }

function SettingsScreen({ sessions, offerings }: { sessions: SessionRecord[]; offerings: OfferingRecord[] }) {
  const [confirm, setConfirm] = useState(false); const [message, setMessage] = useState('');
  const backup = () => { const blob = new Blob([JSON.stringify({ sessions, offerings, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'sadhana-backup.json'; anchor.click(); URL.revokeObjectURL(url); setMessage('Backup saved to your device.'); };
  const restore = (event: ChangeEvent<HTMLInputElement>) => { if (event.target.files?.length) setMessage('Backup selected. Restore will be connected in the next data stage.'); };
  return <><ScreenTitle eyebrow="Preferences & local data" title="Settings"><p className="mt-2 max-w-lg text-sm leading-6 text-muted">Keep this companion calm and local-first. Browser storage is not encrypted.</p></ScreenTitle><div className="space-y-4"><SettingGroup title="Reminders & observance"><ToggleRow label="Morning practice reminder" detail="A gentle prompt at 4:30 AM" /><ToggleRow label="Evening reflection" detail="A quiet end-of-day prompt" /></SettingGroup><SettingGroup title="Appearance"><div className="grid grid-cols-3 gap-2"><button className="rounded-xl border-2 border-primary bg-tint p-3 text-xs font-bold">Rose paper</button><button className="rounded-xl border border-line-soft bg-white p-3 text-xs font-bold text-muted">Light</button><button className="rounded-xl border border-line-soft bg-ink p-3 text-xs font-bold text-white">Dark</button></div></SettingGroup><SettingGroup title="Local vault & storage"><div className="flex items-center gap-3 rounded-xl bg-tint p-4"><CloudOff size={20} className="text-primary" /><div><p className="font-bold">Offline ready</p><p className="mt-1 text-xs muted">Your devotional records stay in this browser.</p></div></div><div className="mt-3 grid gap-2 sm:grid-cols-2"><button onClick={backup} className="flex items-center justify-center gap-2 btn-outlined px-4 py-3 text-sm"><ArrowDownToLine size={16} /> Export backup</button><label className="flex cursor-pointer items-center justify-center gap-2 btn-outlined px-4 py-3 text-sm"><ArrowUpFromLine size={16} /> Choose backup<input className="hidden" type="file" accept="application/json" onChange={restore} /></label></div>{message && <p className="mt-3 text-xs font-semibold text-tertiary">{message}</p>}</SettingGroup><SettingGroup title="History cleanup"><p className="text-sm leading-6 text-muted">When your history spans at least 15 months, you can manually retain the latest 12 months. Nothing is ever removed automatically.</p><button disabled className="mt-3 w-full rounded-xl bg-tint-strong px-4 py-3 text-sm font-bold text-faint">Cleanup older records · not yet available</button></SettingGroup><SettingGroup title="Privacy & vault integrity"><p className="text-sm leading-6 text-muted">There is no account, cloud database, or synchronization in this first release.</p><button onClick={() => setConfirm(true)} className="mt-3 flex w-full items-center justify-center gap-2 btn-danger-outline px-4 py-3 text-sm"><Trash2 size={16} /> Delete all local records</button></SettingGroup></div>{confirm && <div className="fixed inset-0 z-30 grid place-items-center bg-ink/30 p-5"><div className="card max-w-sm p-6"><h2 className="font-heading text-xl font-bold">Delete local records?</h2><p className="mt-2 text-sm leading-6 text-muted">This cannot be undone. Your sessions and offerings will be removed from this device.</p><div className="mt-5 flex gap-2"><button onClick={() => setConfirm(false)} className="btn-outlined flex-1 px-4 py-3 text-sm">Cancel</button><button onClick={() => { void db.sessions.clear(); void db.offerings.clear(); void db.sadhana.clear(); setConfirm(false); setMessage('Local records deleted.'); }} className="btn-danger flex-1 px-4 py-3 text-sm">Delete</button></div></div></div>}</>;
}

function SettingGroup({ title, children }: { title: string; children: ReactNode }) { return <section className="card p-5"><h2 className="mb-4 flex items-center gap-2 text-sm font-bold text-primary-deep"><span className="h-1.5 w-1.5 rounded-full bg-primary" /> {title}</h2>{children}</section>; }
function ToggleRow({ label, detail }: { label: string; detail: string }) { const [enabled, setEnabled] = useState(true); return <div className="flex items-center justify-between border-b border-line-soft py-3 first:pt-0 last:border-0 last:pb-0"><div><p className="text-sm font-bold">{label}</p><p className="mt-1 text-xs muted">{detail}</p></div><button onClick={() => setEnabled(!enabled)} aria-label={`Toggle ${label}`} className={`h-6 w-11 rounded-full p-1 transition ${enabled ? 'bg-primary' : 'bg-line-strong'}`}><span className={`block h-4 w-4 rounded-full bg-white transition ${enabled ? 'translate-x-5' : ''}`} /></button></div>; }

function OfferingModal({ initial, onClose, onSave }: { initial?: OfferingRecord; onClose: () => void; onSave: (record: OfferingRecord) => void }) {
  const [kind, setKind] = useState<OfferingKind>(initial?.kind ?? 'Book Distribution'); const [minutes, setMinutes] = useState(String(initial?.minutes ?? 30)); const [description, setDescription] = useState(initial?.description ?? ''); const [date, setDate] = useState(initial?.date ?? todayString());
  return <div className="fixed inset-0 z-30 grid place-items-center bg-ink/30 p-5"><form onSubmit={(event) => { event.preventDefault(); onSave({ id: initial?.id, date, kind, minutes: Number(minutes), description }); }} className="card w-full max-w-md p-6"><div className="mb-5 flex items-center justify-between"><h2 className="font-heading text-xl font-bold">{initial ? 'Edit preaching offering' : 'Log preaching offering'}</h2><button type="button" onClick={onClose}><X size={20} /></button></div><label className="label">Offering type<select value={kind} onChange={(event) => setKind(event.target.value as OfferingKind)} className="mt-2 field bg-white"><option>Book Distribution</option><option>DYS Session Conducting</option><option>DYS Registration</option><option>Calling Service</option><option>Prasadam Cooking for Boys</option><option>Others</option></select></label><label className="label mt-4 block">Date<input required type="date" value={date} onChange={(event) => setDate(event.target.value)} className="mt-2 field" /></label><label className="label mt-4 block">Minutes<input value={minutes} onChange={(event) => setMinutes(event.target.value)} type="number" min="1" className="mt-2 field" /></label><label className="label mt-4 block">Description<textarea required value={description} onChange={(event) => setDescription(event.target.value)} rows={4} placeholder="What was offered?" className="mt-2 field resize-none" /></label><button className="mt-5 w-full btn-primary px-4 py-3 text-sm">{initial ? 'Save changes' : 'Save offering'}</button></form></div>;
}

export default App;
