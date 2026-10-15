import { useEffect, useState, type ChangeEvent, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { db, loadSadhanaForDate, saveSadhanaForDate, type OfferingKind, type OfferingRecord, type SadhanaRecord, type SessionKind, type SessionRecord } from '@/lib/db';
import { AlarmClock, Archive, ArrowDownToLine, ArrowUpFromLine, BedDouble, BookOpen, CalendarDays, Check, ChevronLeft, ChevronRight, Circle, Clock3, CloudOff, Edit3, HandHeart, Headphones, Home, Menu, Moon, NotebookPen, Plus, Settings as SettingsIcon, ShieldCheck, Sparkles, Sun, Trash2, TrendingUp, Users, X } from 'lucide-react';

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
        {screen === 'Sādhana' && <SadhanaScreen record={sadhana} onChange={setSadhana} />}
        {screen === 'Sessions' && <SessionsScreen sessions={sessions} setSessions={setSessions} />}
        {screen === 'Preaching' && <PreachingScreen offerings={offerings} onAdd={() => setShowAddOffering(true)} onEdit={(item) => setEditOffering(item)} />}
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
    <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-full bg-[#f5dfeb] text-[#65183d]"><Sparkles size={19} /></div><div><div className="flex items-center gap-2 text-lg font-semibold tracking-tight">Sādhana <span className="rounded-full bg-[#f2e8ef] px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[#806b78]"><span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-[#5f896d]" />offline ready</span></div><p className="text-xs font-semibold text-[#806b78]">{screen}</p></div></div>
    <button aria-label="Open settings" onClick={onSettings} className="rounded-xl p-2 text-[#5b4050] transition hover:bg-white"><Menu size={21} /></button>
  </header>;
}

function BottomNav({ screen, onNavigate }: { screen: Screen; onNavigate: (screen: Screen) => void }) {
  return <nav className="fixed bottom-0 left-0 right-0 z-20 border-t border-[#f0e3eb] bg-[#fffafd]/95 px-2 pb-3 pt-2 backdrop-blur md:bottom-5 md:left-1/2 md:right-auto md:w-[620px] md:-translate-x-1/2 md:rounded-2xl md:border md:shadow-lg"><div className="mx-auto flex max-w-[620px] justify-around">{navItems.slice(0, 5).map(({ label, icon: Icon }) => <button key={label} onClick={() => onNavigate(label)} className={`flex min-w-[58px] flex-col items-center gap-1 rounded-xl px-2 py-1 text-[11px] font-semibold transition ${screen === label ? 'text-[#65183d]' : 'text-[#806b78] hover:bg-[#fff0f7]'}`}><Icon size={19} strokeWidth={screen === label ? 2.4 : 1.8} /><span>{label}</span></button>)}</div></nav>;
}

function ScreenTitle({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) { return <div className="mb-6 flex items-start justify-between"><div>{eyebrow && <p className="label mb-2">{eyebrow}</p>}<h1 className="serif text-3xl font-bold leading-tight text-[#4b1732] md:text-4xl">{title}</h1>{children}</div></div>; }
function StatCard({ label, value, detail, icon: Icon }: { label: string; value: string; detail: string; icon: typeof Clock3 }) { return <div className="card p-4"><Icon size={17} className="mb-3 text-[#7c3157]" /><p className="label">{label}</p><p className="mt-1 text-xl font-bold text-[#4b1732]">{value}</p><p className="mt-1 text-xs text-[#806b78]">{detail}</p></div>; }

function TodayScreen({ sessions, offerings, sadhana, onNavigate }: { sessions: SessionRecord[]; offerings: OfferingRecord[]; sadhana: SadhanaRecord; onNavigate: (screen: Screen) => void }) {
  const date = todayString();
  const todaySessions = sessions.filter((item) => item.date === date);
  const weeklyOfferings = offerings.filter((item) => isCurrentWeek(item.date));
  const todayMinutes = todaySessions.reduce((sum, item) => sum + item.minutes, 0);
  const weeklyMinutes = weeklyOfferings.reduce((sum, item) => sum + item.minutes, 0);
  return <>
    <div className="mb-7 flex items-end justify-between"><div><p className="label mb-2">{displayDate(date)}</p><h1 className="serif text-3xl font-bold text-[#4b1732]">A gentle return<br />to the day.</h1><p className="mt-3 max-w-md text-sm leading-6 text-[#806b78]">Keep a clear record of what you offer, without turning practice into performance.</p></div><div className="hidden h-16 w-16 items-center justify-center rounded-2xl bg-[#f6e6ee] text-[#65183d] md:flex"><Sun size={29} /></div></div>
    <div className="card mb-5 grid grid-cols-2 gap-3 p-3 md:grid-cols-4"><div className="rounded-xl bg-[#fff3f8] p-4"><p className="label">Today's practice</p><p className="mt-1 text-2xl font-bold">{todayMinutes ? formatMinutes(todayMinutes) : '—'}</p><p className="mt-1 text-xs muted">{todaySessions.length ? `${todaySessions.length} sessions recorded` : 'No sessions recorded'}</p></div><div className="rounded-xl bg-[#fff3f8] p-4"><p className="label">Weekly preaching</p><p className="mt-1 text-2xl font-bold">{weeklyMinutes ? formatMinutes(weeklyMinutes) : '—'}</p><p className="mt-1 text-xs muted">of 2h minimum</p></div><div className="hidden rounded-xl bg-[#fff3f8] p-4 md:block"><p className="label">Japa rounds</p><p className="mt-1 text-2xl font-bold">{sadhana.date === date && sadhana.rounds ? sadhana.rounds : '—'}</p><p className="mt-1 text-xs muted">target {sadhana.targetRounds}</p></div><div className="hidden rounded-xl bg-[#fff3f8] p-4 md:block"><p className="label">Wake-up</p><p className="mt-1 text-2xl font-bold">{sadhana.date === date && sadhana.wakeUp ? sadhana.wakeUp : '—'}</p><p className="mt-1 text-xs muted">not inferred when missing</p></div></div>
    <section className="card mb-5 p-5"><div className="flex items-center justify-between"><div><p className="label">Weekly preaching offering</p><p className="mt-1 text-xl font-bold">{weeklyMinutes ? formatMinutes(weeklyMinutes) : 'No entries'} <span className="text-sm font-normal muted">/ 2h 00m</span></p></div><TrendingUp size={20} className="text-[#65183d]" /></div><div className="mt-4 h-2 overflow-hidden rounded-full bg-[#f1e4ec]"><div className="h-full rounded-full bg-[#681a40]" style={{ width: `${Math.min(100, (weeklyMinutes / 120) * 100)}%` }} /></div><p className="mt-3 text-sm leading-6 text-[#806b78]">A weekly minimum is a direction, not a measure of devotion.</p><button onClick={() => onNavigate('Preaching')} className="mt-4 flex items-center gap-1 text-sm font-bold text-[#65183d]">Open preaching overview <ChevronRight size={16} /></button></section>
    <div className="mb-3 flex items-center justify-between"><h2 className="serif text-xl font-bold">Today’s sessions</h2><button onClick={() => onNavigate('Sessions')} className="text-xs font-bold text-[#65183d]">View all</button></div>
    {todaySessions.length ? <div className="space-y-3">{todaySessions.slice(0, 3).map((item) => <SessionCard key={item.id} session={item} compact />)}</div> : <EmptyState title="A clear day" detail="No session has been recorded for today. Missing data is not treated as no activity." />}
  </>;
}

function SessionCard({ session, compact = false, onEdit, onDelete }: { session: SessionRecord; compact?: boolean; onEdit?: () => void; onDelete?: () => void }) {
  const tone = session.kind === 'Study' ? 'bg-[#f2e9f0] text-[#62334e]' : session.kind === 'Hearing' ? 'bg-[#fbe1ef] text-[#8e3869]' : 'bg-[#dff2e7] text-[#347159]';
  return <article className={`card p-4 ${compact ? '' : 'md:p-5'}`}><div className="flex items-start justify-between gap-3"><span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${tone}`}>{session.kind}</span><div className="flex gap-3 text-[#806b78]">{onEdit && <button aria-label="Edit session" onClick={onEdit}><Edit3 size={15} /></button>}{onDelete && <button aria-label="Delete session" onClick={onDelete}><Trash2 size={15} /></button>}</div></div><h3 className="mt-3 text-base font-bold text-[#4b1732]">{session.title}</h3><p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#806b78]"><Clock3 size={13} /> {formatMinutes(session.minutes)} <span>·</span> {session.note || 'No note added'}</p>{session.topic && <p className="mt-2 text-sm text-[#806b78]">Topic: {session.topic}</p>}{!compact && session.kind === 'Service' && <p className="mt-3 rounded-lg bg-[#fff4f8] p-3 text-sm italic leading-6 text-[#634553]">Service is an offering, not a performance metric.</p>}</article>;
}

function SadhanaScreen({ record: todayRecord, onChange }: { record: SadhanaRecord; onChange: (record: SadhanaRecord) => void }) {
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
      <button type="button" aria-label={`Previous day, ${displayDate(previousDate)}`} onClick={() => goTo(previousDate)} className="flex min-w-[64px] items-center justify-center gap-1 rounded-xl bg-[#fff3f8] px-2 py-2 text-xs font-bold text-[#65183d] transition hover:bg-[#f7e2ee]"><ChevronLeft size={16} /> {shortDate(previousDate)}</button>
      <div className="relative min-w-0 flex-1 rounded-xl px-2 py-1 text-center transition hover:bg-[#fff3f8]">
        <p className="label">{new Intl.DateTimeFormat('en', { weekday: 'long' }).format(new Date(`${selectedDate}T12:00:00`))}</p>
        <p className="mt-0.5 flex items-center justify-center gap-2 text-base font-bold text-[#4b1732] sm:text-lg"><span className="truncate">{new Intl.DateTimeFormat('en', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${selectedDate}T12:00:00`))}</span><CalendarDays size={16} className="shrink-0 text-[#7c3157]" /></p>
        <input type="date" aria-label="Choose date" value={selectedDate} max={latestDate} onChange={(event) => goTo(event.target.value)} onClick={(event) => { try { event.currentTarget.showPicker?.(); } catch { /* picker opens from the native control instead */ } }} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
      </div>
      <button type="button" aria-label={`Next day, ${displayDate(nextDate)}`} disabled={!canGoNext} onClick={() => goTo(nextDate)} className="flex min-w-[64px] items-center justify-center gap-1 rounded-xl bg-[#fff3f8] px-2 py-2 text-xs font-bold text-[#65183d] transition hover:bg-[#f7e2ee] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[#fff3f8]">{shortDate(nextDate)} <ChevronRight size={16} /></button>
    </div>
    {shown ? <SadhanaDay key={shown.date} record={shown} isToday={isToday} onChange={isToday ? onChange : setOther} /> : <EmptyState title="Opening this day…" detail="Loading the saved record for the selected date." />}
  </>;
}

function SadhanaDay({ record, isToday, onChange }: { record: SadhanaRecord; isToday: boolean; onChange: (record: SadhanaRecord) => void }) {
  const update = (patch: Partial<SadhanaRecord>) => {
    const next = { ...record, ...patch, date: record.date || todayString() };
    onChange(next);
    void saveSadhanaForDate(next).catch((error) => console.error('Could not save Sādhana record', error));
  };
  const progress = Math.min(100, (record.rounds / Math.max(1, record.targetRounds)) * 100);
  const sessionRows = [
    { icon: NotebookPen, title: 'Scriptural Study', detail: 'Śrīmad-Bhāgavatam Canto 1', time: '45 min', count: '1 session', tone: 'bg-[#f2e9f0]' },
    { icon: Headphones, title: 'Hearing (Śravaṇam)', detail: 'Bhagavad-gītā As It Is Lecture', time: '1h 10 min', count: '2 sessions', tone: 'bg-[#fbe1ef]' },
    { icon: HandHeart, title: 'Devotional Service (Sevā)', detail: 'Deity Kitchen Assistance', time: '1h 30 min', count: '1 session', tone: 'bg-[#e1f2e7]' },
  ];
  return <>
    <section className="mb-6 flex items-center justify-between gap-4"><div><p className="label">{displayDate(record.date || todayString())}</p><h1 className="serif mt-2 text-3xl font-bold text-[#4b1732]">{isToday ? 'Today’s Sādhana' : 'Sādhana record'}</h1><p className="mt-2 text-sm leading-6 muted">A quiet record of the practices that turn the heart toward service.</p></div><div className="hidden rounded-2xl bg-[#f5dfeb] p-4 text-[#65183d] md:block"><Sparkles size={25} /></div></section>
    <div className="mb-5 flex items-center justify-between rounded-xl bg-[#f4e9f1] px-4 py-3 text-xs font-semibold text-[#806b78]"><span className="flex items-center gap-2"><ShieldCheck size={16} className="text-[#347159]" /> Partial records preserved locally on this device</span><span className="rounded-full bg-[#fff7fb] px-2 py-1">Draft</span></div>
    <section className="card mb-5 overflow-hidden"><div className="bg-gradient-to-br from-[#6c2147] to-[#3d0522] p-5 text-white"><p className="label !text-[#ffd6f8]">Brahma-muhūrta offering</p><div className="mt-2 flex items-end justify-between gap-3"><div><h2 className="serif text-xl font-bold">Quietude before dawn</h2><p className="mt-1 text-sm text-[#f9ddea]">An intentional beginning, offered gently.</p></div><Moon size={30} className="text-[#ffd6f8]" /></div></div><div className="grid gap-3 p-4 sm:grid-cols-3"><TimeField icon={AlarmClock} label="Wake-up time" value={record.wakeUp} onChange={(value) => update({ wakeUp: value })} /><TimeField icon={BedDouble} label="Bedtime" value={record.bedtime} onChange={(value) => update({ bedtime: value })} /><TimeField icon={BedDouble} label="Sleep onset" value={record.sleepOnset} onChange={(value) => update({ sleepOnset: value })} /></div></section>
    <section className="card mb-5 p-5"><div className="flex items-center justify-between"><div><p className="label">Daily devotional record</p><h2 className="mt-1 text-xl font-bold">Steep heart in contemplation</h2><p className="mt-1 text-sm muted">4 disciplines gently observed today.</p></div><div className="rounded-full bg-[#f4e5ef] p-3 text-[#65183d]"><NotebookPen size={20} /></div></div></section>
    <section className="card mb-5 p-5"><div className="flex items-center justify-between"><div className="flex items-center gap-2"><Moon size={21} className="text-[#735470]" /><h2 className="text-xl font-bold">Japa Meditation</h2></div><label className="flex items-center gap-2 rounded-full bg-[#f4e5ef] px-3 py-1 text-xs font-bold text-[#735470]">Target <input type="number" min="1" max="64" value={record.targetRounds} onChange={(event) => update({ targetRounds: Number(event.target.value) || 1 })} className="w-8 bg-transparent text-center outline-none" /></label></div><div className="mt-5 flex flex-col items-center gap-6 sm:flex-row"><div className="relative h-36 w-36 shrink-0"><svg className="h-full w-full -rotate-90" viewBox="0 0 120 120"><circle cx="60" cy="60" r="50" fill="none" stroke="#f0e3eb" strokeWidth="8" /><circle cx="60" cy="60" r="50" fill="none" stroke="#681a40" strokeDasharray="314" strokeDashoffset={314 - (314 * progress) / 100} strokeLinecap="round" strokeWidth="8" /></svg><div className="absolute inset-0 flex flex-col items-center justify-center"><span className="text-3xl font-bold text-[#4b1732]">{record.rounds}</span><span className="text-xs muted">of {record.targetRounds} rounds</span></div></div><div className="flex w-full flex-1 flex-col gap-4"><div className="rounded-xl bg-[#fff3f8] p-3 text-sm font-semibold text-[#5b4050]"><Sun size={16} className="mr-2 inline text-[#8e3869]" /> {record.earlyRounds} rounds before 7:00 AM</div><label className="label block">Rounds completed before 7:00 AM<input type="number" min="0" max={record.rounds} value={record.earlyRounds} onChange={(event) => update({ earlyRounds: Math.min(record.rounds, Math.max(0, Number(event.target.value))) })} className="mt-2 w-full rounded-lg border border-[#ecdce6] bg-white p-2 text-sm normal-case tracking-normal" /></label><label className="label block">Time 16th round completed<input type="time" value={record.sixteenthRoundTime} onChange={(event) => update({ sixteenthRoundTime: event.target.value })} className="mt-2 w-full rounded-lg border border-[#ecdce6] bg-white p-2 text-sm normal-case tracking-normal" /></label><p className="text-sm leading-6 muted">Attentive, steady recitation offered with reverence.</p><div className="flex gap-2"><button onClick={() => update({ rounds: Math.min(64, record.rounds + 1), earlyRounds: Math.min(record.earlyRounds, record.rounds + 1) })} className="flex h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-[#f2e7ef] text-sm font-bold text-[#65183d] transition hover:bg-[#ead8e5]"><Plus size={19} /> +1 round</button><button onClick={() => update({ rounds: Math.max(0, record.rounds - 1) })} className="rounded-xl bg-[#fff3f8] px-4 text-sm font-bold text-[#806b78]">−</button></div></div></div></section>
    <section className="card mb-5 p-5"><div className="flex items-center justify-between"><div className="flex items-center gap-2"><Sun size={21} className="text-[#735470]" /><h2 className="text-xl font-bold">Morning Routine & Vigil</h2></div><span className="label">Awakening & rest</span></div><div className="mt-4 rounded-xl bg-[#fff3f8] p-4"><div className="flex items-center justify-between"><div><p className="font-bold">Maṅgala Ārati</p><p className="mt-1 text-sm muted">Early prayer offering with congregational assembly.</p></div><span className="text-xs font-bold text-[#347159]">{record.mangalaArati}</span></div><div className="mt-4 grid grid-cols-3 gap-2">{(['Attended', 'Not today', 'Unrecorded'] as const).map((option) => <button key={option} onClick={() => update({ mangalaArati: option })} className={`rounded-lg px-2 py-2 text-xs font-bold transition ${record.mangalaArati === option ? 'bg-[#681a40] text-white' : 'bg-white text-[#806b78]'}`}>{record.mangalaArati === option && <Check className="mr-1 inline" size={14} />}{option}</button>)}</div></div></section>
    <section className="card mb-5 p-5"><div className="flex items-center justify-between"><div className="flex items-center gap-2"><BookOpen size={21} className="text-[#735470]" /><h2 className="text-xl font-bold">Study, Hearing & Sevā</h2></div><span className="label">3 practices</span></div><div className="mt-4 space-y-2">{sessionRows.map(({ icon: Icon, title, detail, time, count, tone }) => <div key={title} className={`flex items-center justify-between gap-3 rounded-xl ${tone} p-3`}><div className="flex min-w-0 items-center gap-3"><div className="rounded-xl bg-white/70 p-2 text-[#65183d]"><Icon size={18} /></div><div className="min-w-0"><p className="truncate text-sm font-bold">{title}</p><p className="truncate text-xs muted">{detail}</p></div></div><div className="shrink-0 text-right"><p className="text-xs font-bold text-[#65183d]">{time}</p><p className="mt-1 text-[10px] muted">{count}</p></div></div>)}</div></section>
    <section className="mb-5"><p className="label mb-3">Quick entries</p><div className="grid grid-cols-2 gap-2"><button className="rounded-xl bg-[#f2e7ef] px-3 py-3 text-sm font-bold text-[#65183d]"><NotebookPen className="mr-1 inline" size={16} /> Log study</button><button className="rounded-xl bg-[#f2e7ef] px-3 py-3 text-sm font-bold text-[#65183d]"><Headphones className="mr-1 inline" size={16} /> Log hearing</button><button className="rounded-xl bg-[#f2e7ef] px-3 py-3 text-sm font-bold text-[#65183d]"><HandHeart className="mr-1 inline" size={16} /> Log service</button><button className="rounded-xl bg-[#f2e7ef] px-3 py-3 text-sm font-bold text-[#65183d]"><Circle className="mr-1 inline" size={16} /> Share update</button></div></section>
    <section className="card mb-5 p-5"><div className="flex items-center gap-2"><Clock3 size={20} className="text-[#735470]" /><h2 className="text-xl font-bold">Daily reflection</h2></div><textarea value={record.reflection} onChange={(event) => update({ reflection: event.target.value })} placeholder="Record any insight, gratitude, or intention for tomorrow’s morning practice..." rows={4} className="mt-4 w-full resize-none rounded-xl border border-[#ecdce6] bg-[#fffafd] p-3 text-sm leading-6 outline-none focus:border-[#8e3869]" /></section>
    <p className="flex items-center gap-2 rounded-xl bg-[#f3e8ef] p-4 text-xs leading-5 text-[#806b78]"><ShieldCheck size={18} className="shrink-0 text-[#65183d]" /> Records are stored in this browser’s IndexedDB. Browser storage is not encrypted, so make periodic backups in Settings.</p>
  </>;
}

function TimeField({ icon: Icon, label, value, onChange }: { icon: typeof AlarmClock; label: string; value: string; onChange: (value: string) => void }) { return <label className="flex items-center gap-3 rounded-xl bg-[#fff3f8] p-3"><span className="rounded-full bg-[#f4e5ef] p-2 text-[#65183d]"><Icon size={17} /></span><span className="min-w-0 flex-1"><span className="label block">{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full bg-transparent text-sm font-bold text-[#4b1732] outline-none" /></span></label>; }

function SessionsScreen({ sessions, setSessions }: { sessions: SessionRecord[]; setSessions: (records: SessionRecord[]) => void }) {
  const [filter, setFilter] = useState<'All' | SessionKind>('All');
  const [draft, setDraft] = useState<SessionRecord | null>(null);
  const visible = filter === 'All' ? sessions : sessions.filter((item) => item.kind === filter);
  const save = async (record: SessionRecord) => {
    if (record.id) await db.sessions.update(record.id, record);
    else record.id = await db.sessions.add(record);
    setSessions(sessions.some((item) => item.id === record.id) ? sessions.map((item) => item.id === record.id ? record : item) : [...sessions, record]);
    setDraft(null);
  };
  const remove = async (id: number | undefined) => { if (!id) return; await db.sessions.delete(id); setSessions(sessions.filter((item) => item.id !== id)); };
  return <><ScreenTitle eyebrow="Daily journal of humble offerings" title="Session Logs"><p className="mt-2 max-w-lg text-sm leading-6 text-[#806b78]">A record of svādhyāya, hearing, and humble service—offered without haste or performance pressure.</p></ScreenTitle><div className="mb-5 flex items-center justify-between gap-3"><div className="flex gap-2 overflow-x-auto">{(['All', 'Study', 'Hearing', 'Service'] as const).map((item) => <button key={item} onClick={() => setFilter(item)} className={`whitespace-nowrap rounded-full px-4 py-2 text-xs font-bold ${filter === item ? 'bg-[#f5c8e6] text-[#65183d]' : 'bg-white text-[#806b78]'}`}>{item}</button>)}</div><button onClick={() => setDraft({ date: todayString(), kind: 'Study', title: '', minutes: 30, note: '' })} className="flex shrink-0 items-center gap-2 rounded-xl bg-[#681a40] px-4 py-2 text-sm font-bold text-white shadow-sm"><Plus size={16} /> New session</button></div><div className="mb-3 flex items-center justify-between"><h2 className="serif text-xl font-bold">{displayDate(todayString())}</h2><span className="text-xs text-[#806b78]">{visible.length} sessions · {formatMinutes(visible.reduce((s, i) => s + i.minutes, 0))}</span></div>{visible.length ? <div className="space-y-3">{visible.map((item) => <SessionCard key={item.id} session={item} onEdit={() => setDraft(item)} onDelete={() => void remove(item.id)} />)}</div> : <EmptyState title="No sessions recorded" detail="Add a study, hearing, or service entry when you are ready." />} {draft && <SessionEditor draft={draft} onChange={setDraft} onClose={() => setDraft(null)} onSave={() => void save(draft)} />}</>;
}

function SessionEditor({ draft, onChange, onClose, onSave }: { draft: SessionRecord; onChange: (record: SessionRecord) => void; onClose: () => void; onSave: () => void }) {
  const patch = (value: Partial<SessionRecord>) => onChange({ ...draft, ...value });
  return <div className="fixed inset-0 z-30 grid place-items-center bg-[#351526]/30 p-5"><form onSubmit={(event) => { event.preventDefault(); onSave(); }} className="card w-full max-w-md p-6"><div className="mb-5 flex items-center justify-between"><h2 className="serif text-xl font-bold">{draft.id ? 'Edit session' : 'New session'}</h2><button type="button" onClick={onClose}><X size={20} /></button></div><label className="label">Practice type<select value={draft.kind} onChange={(event) => patch({ kind: event.target.value as SessionKind })} className="mt-2 w-full rounded-xl border border-[#ecdce6] bg-white p-3 text-sm normal-case tracking-normal"><option>Study</option><option>Hearing</option><option>Service</option></select></label><label className="label mt-4 block">{draft.kind === 'Study' ? 'Scripture or book' : draft.kind === 'Hearing' ? 'Source or speaker' : 'Service description'}<input required value={draft.title} onChange={(event) => patch({ title: event.target.value })} className="mt-2 w-full rounded-xl border border-[#ecdce6] p-3 text-sm normal-case tracking-normal" /></label><div className="mt-4 grid grid-cols-2 gap-3"><label className="label">Date<input required type="date" value={draft.date} onChange={(event) => patch({ date: event.target.value })} className="mt-2 w-full rounded-xl border border-[#ecdce6] p-3 text-sm normal-case tracking-normal" /></label><label className="label">Minutes<input required min="1" type="number" value={draft.minutes} onChange={(event) => patch({ minutes: Number(event.target.value) })} className="mt-2 w-full rounded-xl border border-[#ecdce6] p-3 text-sm normal-case tracking-normal" /></label></div><label className="label mt-4 block">Topic or notes<textarea value={draft.note || ''} onChange={(event) => patch({ note: event.target.value })} rows={3} className="mt-2 w-full resize-none rounded-xl border border-[#ecdce6] p-3 text-sm normal-case tracking-normal" /></label><button className="mt-5 w-full rounded-xl bg-[#681a40] px-4 py-3 text-sm font-bold text-white">Save session</button></form></div>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) { return <div className="card p-8 text-center"><Circle className="mx-auto mb-3 text-[#8e3869]" size={25} /><p className="font-bold">{title}</p><p className="mt-2 text-sm leading-6 muted">{detail}</p></div>; }

function PreachingScreen({ offerings, onAdd, onEdit }: { offerings: OfferingRecord[]; onAdd: () => void; onEdit: (record: OfferingRecord) => void }) {
  const [period, setPeriod] = useState<'week' | 'month'>('week');
  const visible = offerings.filter((item) => period === 'week' ? isCurrentWeek(item.date) : isCurrentMonth(item.date));
  const total = visible.reduce((sum, item) => sum + item.minutes, 0); const percent = Math.min(100, (total / 120) * 100);
  const categoryTotals = visible.reduce<Record<string, number>>((totals, item) => ({ ...totals, [item.kind]: (totals[item.kind] || 0) + item.minutes }), {});
  return <><ScreenTitle eyebrow="Humble offerings of saṅkīrtana, youth guidance, and devotional care" title="Preaching & Outreach"><p className="mt-2 max-w-lg text-sm leading-6 text-[#806b78]">A dedicated place for activity records and gentle weekly and monthly review.</p></ScreenTitle><section className="card mb-5 p-5"><div className="flex items-start justify-between"><div><p className="label">Personal vow</p><p className="mt-2 text-xl font-bold">Weekly Offering</p></div><div className="text-right"><p className="text-xl font-bold text-[#65183d]">{formatMinutes(total)} <span className="text-sm font-normal muted">/ 2h 00m</span></p><p className="mt-1 text-xs font-bold text-[#806b78]">{Math.max(0, 120 - total)}m remaining</p></div></div><div className="mt-5 h-2 overflow-hidden rounded-full bg-[#f1e4ec]"><div className="h-full rounded-full bg-[#681a40]" style={{ width: `${percent}%` }} /></div><p className="mt-3 text-sm font-semibold text-[#806b78]">{Math.round(percent)}% of chosen <em>A quiet personal discipline, not a performance metric</em></p></section><div className="mb-7 rounded-xl bg-[#681a40] p-4 text-center text-white shadow-md"><button onClick={onAdd} className="w-full text-sm font-bold tracking-wide"><Plus className="mr-2 inline" size={19} /> Log preaching offering</button></div><div className="mb-5 flex rounded-xl bg-[#f2e7ef] p-1 text-sm font-bold text-[#806b78]"><button onClick={() => setPeriod('week')} className={`flex-1 rounded-lg px-3 py-2 ${period === 'week' ? 'bg-white text-[#4b1732] shadow-sm' : ''}`}>This week</button><button onClick={() => setPeriod('week')} className={`flex-1 px-3 py-2 ${period === 'week' ? 'text-[#4b1732]' : ''}`}>Weekly reports</button><button onClick={() => setPeriod('month')} className={`flex-1 px-3 py-2 ${period === 'month' ? 'bg-white text-[#4b1732] shadow-sm' : ''}`}>Monthly reports</button></div><div className="mb-3 flex items-center justify-between"><p className="label">Offerings in current cycle ({visible.length})</p><span className="text-xs font-bold muted">{formatMinutes(total)} total</span></div><div className="space-y-4">{visible.map((item) => <article key={item.id} className="card p-4"><div className="flex items-center justify-between"><span className="rounded-full bg-[#f5d8ed] px-3 py-2 text-xs font-bold text-[#6c315b]">{item.kind}</span><span className="text-xs font-bold text-[#806b78]">{item.date === '2024-10-24' ? 'Today' : 'Yesterday'} · <button aria-label="Edit offering" onClick={() => onEdit(item)} className="inline"><Edit3 size={14} /></button> <Trash2 className="ml-3 inline" size={14} /></span></div><p className="mt-3 text-xl font-bold text-[#65183d]">{formatMinutes(item.minutes)}</p><p className="mt-2 rounded-lg bg-[#fff3f8] p-3 text-sm leading-6 text-[#503443]">{item.description}</p></article>)}</div>{visible.length > 0 && <div className="card mt-5 p-5"><p className="label">Category breakdown</p><div className="mt-3 grid grid-cols-2 gap-2">{Object.entries(categoryTotals).map(([category, minutes]) => <div key={category} className="rounded-xl bg-[#fff3f8] p-3"><p className="text-xs font-bold text-[#5b4050]">{category}</p><p className="mt-1 font-bold text-[#65183d]">{formatMinutes(minutes)}</p></div>)}</div></div>}<aside className="mt-5 rounded-2xl bg-[#fbecf6] p-5"><p className="label">Śrī Kṛṣṇa’s promise to the preacher</p><p className="serif mt-3 text-lg italic leading-8">“ya idaṁ paramam guhyaṁ mad-bhakteṣv abhidhāsyati”</p><p className="mt-3 text-sm leading-6 text-[#806b78]">For one who explains this supreme secret to the devotees, pure devotional service is guaranteed.</p></aside></>;
}

function InsightsScreen({ sessions, offerings, sadhana }: { sessions: SessionRecord[]; offerings: OfferingRecord[]; sadhana: SadhanaRecord }) {
  const chart = [0, 1, 2, 3].map((week) => ({ name: `Week ${week + 1}`, study: sessions.filter((item) => item.kind === 'Study' && Math.floor((new Date(`${item.date}T12:00:00`).getDate() - 1) / 7) === week).reduce((sum, item) => sum + item.minutes, 0), hearing: sessions.filter((item) => item.kind === 'Hearing' && Math.floor((new Date(`${item.date}T12:00:00`).getDate() - 1) / 7) === week).reduce((sum, item) => sum + item.minutes, 0), service: sessions.filter((item) => item.kind === 'Service' && Math.floor((new Date(`${item.date}T12:00:00`).getDate() - 1) / 7) === week).reduce((sum, item) => sum + item.minutes, 0) }));
  const sessionMinutes = sessions.reduce((sum, item) => sum + item.minutes, 0);
  const hearingMinutes = sessions.filter((item) => item.kind === 'Hearing').reduce((sum, item) => sum + item.minutes, 0);
  const roundData = sadhana.rounds ? [{ day: displayDate(sadhana.date), rounds: sadhana.rounds }] : [];
  return <><ScreenTitle eyebrow="Historical view · reports" title="Insights"><p className="mt-2 max-w-lg text-sm leading-6 text-[#806b78]">Patterns for reflection, never a scorecard. Every number below comes from saved local records.</p></ScreenTitle><div className="grid grid-cols-2 gap-3 md:grid-cols-4"><StatCard label="Sessions logged" value={String(sessions.length)} detail={sessionMinutes ? formatMinutes(sessionMinutes) : 'No activity yet'} icon={Archive} /><StatCard label="Recorded rounds" value={sadhana.rounds ? String(sadhana.rounds) : '—'} detail={`Target: ${sadhana.targetRounds} daily`} icon={Sun} /><StatCard label="Total hearing" value={hearingMinutes ? formatMinutes(hearingMinutes) : '—'} detail="Saved sessions only" icon={BookOpen} /><StatCard label="Preaching" value={offerings.length ? formatMinutes(offerings.reduce((sum, item) => sum + item.minutes, 0)) : '—'} detail="Saved offerings" icon={Users} /></div><ChartCard title="Chanting rounds" subtitle="Saved daily records"><ResponsiveContainer width="100%" height={230}><LineChart data={roundData}><CartesianGrid stroke="#f1e3eb" vertical={false} /><XAxis dataKey="day" tick={{ fontSize: 11, fill: '#806b78' }} /><YAxis domain={[0, Math.max(20, sadhana.targetRounds)]} tick={{ fontSize: 11, fill: '#806b78' }} /><Tooltip /><Line type="monotone" dataKey="rounds" stroke="#681a40" strokeWidth={3} dot={{ fill: '#681a40', r: 3 }} /></LineChart></ResponsiveContainer>{!roundData.length && <p className="text-center text-sm muted">No chanting records yet.</p>}</ChartCard><ChartCard title="Study, hearing & service duration" subtitle="Current calendar-month minutes"><ResponsiveContainer width="100%" height={230}><BarChart data={chart} barGap={4}><CartesianGrid stroke="#f1e3eb" vertical={false} /><XAxis dataKey="name" tick={{ fontSize: 11, fill: '#806b78' }} /><YAxis tick={{ fontSize: 11, fill: '#806b78' }} /><Tooltip /><Bar dataKey="study" name="Study" fill="#17715a" radius={[5, 5, 0, 0]} /><Bar dataKey="hearing" name="Hearing" fill="#681a40" radius={[5, 5, 0, 0]} /><Bar dataKey="service" name="Service" fill="#8e3869" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></ChartCard><div className="card mt-5 p-5"><p className="label">Reflection</p><p className="mt-2 text-sm leading-7 text-[#5b4050]">{sessions.length ? `You have saved ${sessions.length} session${sessions.length === 1 ? '' : 's'} and ${offerings.length} preaching offering${offerings.length === 1 ? '' : 's'}.` : 'Your historical view will grow as you record practice.'}</p></div></>;
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) { return <section className="card mt-5 p-4 md:p-5"><div className="mb-4"><p className="font-bold text-[#4b1732]">{title}</p><p className="mt-1 text-xs muted">{subtitle}</p></div>{children}</section>; }

function SettingsScreen({ sessions, offerings }: { sessions: SessionRecord[]; offerings: OfferingRecord[] }) {
  const [confirm, setConfirm] = useState(false); const [message, setMessage] = useState('');
  const backup = () => { const blob = new Blob([JSON.stringify({ sessions, offerings, exportedAt: new Date().toISOString() }, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'sadhana-backup.json'; anchor.click(); URL.revokeObjectURL(url); setMessage('Backup saved to your device.'); };
  const restore = (event: ChangeEvent<HTMLInputElement>) => { if (event.target.files?.length) setMessage('Backup selected. Restore will be connected in the next data stage.'); };
  return <><ScreenTitle eyebrow="Preferences & local data" title="Settings"><p className="mt-2 max-w-lg text-sm leading-6 text-[#806b78]">Keep this companion calm and local-first. Browser storage is not encrypted.</p></ScreenTitle><div className="space-y-4"><SettingGroup title="Reminders & observance"><ToggleRow label="Morning practice reminder" detail="A gentle prompt at 4:30 AM" /><ToggleRow label="Evening reflection" detail="A quiet end-of-day prompt" /></SettingGroup><SettingGroup title="Appearance"><div className="grid grid-cols-3 gap-2"><button className="rounded-xl border-2 border-[#681a40] bg-[#fff3f8] p-3 text-xs font-bold">Rose paper</button><button className="rounded-xl border border-[#f0e3eb] bg-white p-3 text-xs font-bold text-[#806b78]">Light</button><button className="rounded-xl border border-[#f0e3eb] bg-[#351526] p-3 text-xs font-bold text-white">Dark</button></div></SettingGroup><SettingGroup title="Local vault & storage"><div className="flex items-center gap-3 rounded-xl bg-[#fff3f8] p-4"><CloudOff size={20} className="text-[#681a40]" /><div><p className="font-bold">Offline ready</p><p className="mt-1 text-xs muted">Your devotional records stay in this browser.</p></div></div><div className="mt-3 grid gap-2 sm:grid-cols-2"><button onClick={backup} className="flex items-center justify-center gap-2 rounded-xl border border-[#ecdce6] bg-white px-4 py-3 text-sm font-bold"><ArrowDownToLine size={16} /> Export backup</button><label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-[#ecdce6] bg-white px-4 py-3 text-sm font-bold"><ArrowUpFromLine size={16} /> Choose backup<input className="hidden" type="file" accept="application/json" onChange={restore} /></label></div>{message && <p className="mt-3 text-xs font-semibold text-[#347159]">{message}</p>}</SettingGroup><SettingGroup title="History cleanup"><p className="text-sm leading-6 text-[#806b78]">When your history spans at least 15 months, you can manually retain the latest 12 months. Nothing is ever removed automatically.</p><button disabled className="mt-3 w-full rounded-xl bg-[#f2e7ef] px-4 py-3 text-sm font-bold text-[#a999a5]">Cleanup older records · not yet available</button></SettingGroup><SettingGroup title="Privacy & vault integrity"><p className="text-sm leading-6 text-[#806b78]">There is no account, cloud database, or synchronization in this first release.</p><button onClick={() => setConfirm(true)} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-[#e8bdca] px-4 py-3 text-sm font-bold text-[#9a3e54]"><Trash2 size={16} /> Delete all local records</button></SettingGroup></div>{confirm && <div className="fixed inset-0 z-30 grid place-items-center bg-[#351526]/30 p-5"><div className="card max-w-sm p-6"><h2 className="serif text-xl font-bold">Delete local records?</h2><p className="mt-2 text-sm leading-6 text-[#806b78]">This cannot be undone. Your sessions and offerings will be removed from this device.</p><div className="mt-5 flex gap-2"><button onClick={() => setConfirm(false)} className="flex-1 rounded-xl border border-[#ecdce6] px-4 py-3 text-sm font-bold">Cancel</button><button onClick={() => { void db.sessions.clear(); void db.offerings.clear(); void db.sadhana.clear(); setConfirm(false); setMessage('Local records deleted.'); }} className="flex-1 rounded-xl bg-[#9a3e54] px-4 py-3 text-sm font-bold text-white">Delete</button></div></div></div>}</>;
}

function SettingGroup({ title, children }: { title: string; children: ReactNode }) { return <section className="card p-5"><h2 className="mb-4 flex items-center gap-2 text-sm font-bold text-[#4b1732]"><span className="h-1.5 w-1.5 rounded-full bg-[#681a40]" /> {title}</h2>{children}</section>; }
function ToggleRow({ label, detail }: { label: string; detail: string }) { const [enabled, setEnabled] = useState(true); return <div className="flex items-center justify-between border-b border-[#f3e8ef] py-3 first:pt-0 last:border-0 last:pb-0"><div><p className="text-sm font-bold">{label}</p><p className="mt-1 text-xs muted">{detail}</p></div><button onClick={() => setEnabled(!enabled)} aria-label={`Toggle ${label}`} className={`h-6 w-11 rounded-full p-1 transition ${enabled ? 'bg-[#681a40]' : 'bg-[#dfd4dc]'}`}><span className={`block h-4 w-4 rounded-full bg-white transition ${enabled ? 'translate-x-5' : ''}`} /></button></div>; }

function OfferingModal({ initial, onClose, onSave }: { initial?: OfferingRecord; onClose: () => void; onSave: (record: OfferingRecord) => void }) {
  const [kind, setKind] = useState<OfferingKind>(initial?.kind ?? 'Book Distribution'); const [minutes, setMinutes] = useState(String(initial?.minutes ?? 30)); const [description, setDescription] = useState(initial?.description ?? ''); const [date, setDate] = useState(initial?.date ?? todayString());
  return <div className="fixed inset-0 z-30 grid place-items-center bg-[#351526]/30 p-5"><form onSubmit={(event) => { event.preventDefault(); onSave({ id: initial?.id, date, kind, minutes: Number(minutes), description }); }} className="card w-full max-w-md p-6"><div className="mb-5 flex items-center justify-between"><h2 className="serif text-xl font-bold">{initial ? 'Edit preaching offering' : 'Log preaching offering'}</h2><button type="button" onClick={onClose}><X size={20} /></button></div><label className="label">Offering type<select value={kind} onChange={(event) => setKind(event.target.value as OfferingKind)} className="mt-2 w-full rounded-xl border border-[#ecdce6] bg-white p-3 text-sm normal-case tracking-normal text-[#351526]"><option>Book Distribution</option><option>DYS Session Conducting</option><option>DYS Registration</option><option>Calling Service</option><option>Prasadam Cooking for Boys</option><option>Others</option></select></label><label className="label mt-4 block">Date<input required type="date" value={date} onChange={(event) => setDate(event.target.value)} className="mt-2 w-full rounded-xl border border-[#ecdce6] p-3 text-sm normal-case tracking-normal" /></label><label className="label mt-4 block">Minutes<input value={minutes} onChange={(event) => setMinutes(event.target.value)} type="number" min="1" className="mt-2 w-full rounded-xl border border-[#ecdce6] p-3 text-sm normal-case tracking-normal" /></label><label className="label mt-4 block">Description<textarea required value={description} onChange={(event) => setDescription(event.target.value)} rows={4} placeholder="What was offered?" className="mt-2 w-full resize-none rounded-xl border border-[#ecdce6] p-3 text-sm normal-case tracking-normal" /></label><button className="mt-5 w-full rounded-xl bg-[#681a40] px-4 py-3 text-sm font-bold text-white">{initial ? 'Save changes' : 'Save offering'}</button></form></div>;
}

export default App;
