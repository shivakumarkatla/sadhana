/**
 * Sādācāra monthly reflection. Hub (choose a month) -> six ratings with optional private notes -> four private prompts -> Preview & Share.
 * Ratings are plain numbers (src/lib/sadacharaService.ts). Every written answer goes through PrivateTextField, i.e. the existing encrypted
 * private diary; when the diary is off or locked no written answer is shown or readable. The shared report never receives any text.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { liveQuery } from 'dexie';
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Copy, Lock, ShieldCheck } from 'lucide-react';
import { PrivateTextField, UnlockForm } from '@/components/PrivateDiary';
import {
  SADACHARA_AREAS, SADACHARA_KIND, SADACHARA_PROMPTS, SHARE_SECTIONS, answeredCount, averageRating, blankRatings, buildShareReport, currentMonth, isRating,
  monthLabel, refIdFor, shiftMonth, textFieldFor, withRating, ratingBand, type Rating, type SadacharaAssessment, type ShareSectionId,
} from '@/lib/sadachara';
import { getAssessment, listAssessments, saveAssessmentRatings } from '@/lib/sadacharaService';
import { useDiary } from '@/lib/useDiary';

type View = { name: 'hub' } | { name: 'form'; month: string } | { name: 'share'; month: string };

function useLive<T>(query: () => Promise<T>, key: string): { data?: T; failed: boolean } {
  const latest = useRef(query); latest.current = query;
  const [state, setState] = useState<{ data?: T; failed: boolean }>({ failed: false });
  useEffect(() => {
    const subscription = liveQuery(() => latest.current()).subscribe({ next: (data) => setState({ data, failed: false }), error: () => setState((current) => ({ ...current, failed: true })) });
    return () => subscription.unsubscribe();
  }, [key]);
  return state;
}

function Banner({ kind, children }: { kind: 'ok' | 'error' | 'warn'; children: ReactNode }) {
  const tone = kind === 'error' ? 'bg-danger-tint text-danger' : kind === 'warn' ? 'bg-primary-tint text-primary' : 'bg-tint text-ink-soft';
  return <p role={kind === 'error' ? 'alert' : 'status'} className={`rounded-xl p-3 text-sm font-semibold leading-6 ${tone}`}>{children}</p>;
}

function statusText(ratings: Record<string, Rating> | undefined): string {
  if (!ratings) return 'Not started';
  const count = answeredCount(ratings);
  return count === 0 ? 'Not started' : count === SADACHARA_AREAS.length ? 'All 6 areas rated' : `${count} of ${SADACHARA_AREAS.length} areas rated`;
}

/** Written answers need the private diary: explain why they are unavailable instead of showing a plaintext fallback. */
function PrivateGate({ children, what }: { children: ReactNode; what: string }) {
  const diary = useDiary();
  if (!diary.loaded) return <p role="status" className="text-xs muted">Opening…</p>;
  if (diary.state === 'disabled') return <div data-testid="sadachara-diary-off" className="rounded-xl bg-tint p-4"><p className="flex items-center gap-2 text-sm font-bold text-primary-deep"><Lock size={16} /> {what} stay private</p><p className="mt-1 text-xs leading-5 muted">Written answers are only ever saved encrypted, so they need the private diary. Turn it on in Settings → Private diary. Ratings work without it.</p></div>;
  if (diary.state === 'migrating') return <Banner kind="warn">Private diary setup is in progress. Finish it in Settings → Private diary; written answers are paused until then.</Banner>;
  if (!diary.unlocked) return <div data-testid="sadachara-locked" className="rounded-xl bg-tint p-4"><p className="flex items-center gap-2 text-sm font-bold text-primary-deep"><Lock size={16} /> Your diary is locked</p><p className="mb-3 mt-1 text-xs leading-5 muted">Unlock to read or write {what.toLowerCase()}. Ratings still work.</p><UnlockForm /></div>;
  return <>{children}</>;
}

// ---- hub ---------------------------------------------------------------------------------------------------------------------------

function Hub({ onOpen, onBack }: { onOpen: (view: View) => void; onBack: () => void }) {
  const now = currentMonth();
  const [month, setMonth] = useState(now);
  const { data, failed } = useLive(listAssessments, 'list');
  const byMonth = new Map((data ?? []).map((entry) => [entry.month, entry]));
  const selected = byMonth.get(month);
  const past = (data ?? []).filter((entry) => answeredCount(entry.ratings) > 0).sort((a, b) => b.month.localeCompare(a.month));
  const count = selected ? answeredCount(selected.ratings) : 0;
  return <div className="space-y-5">
    <button type="button" onClick={onBack} className="flex min-h-[44px] items-center gap-2 text-sm font-bold text-primary"><ArrowLeft size={16} /> Back to Today</button>
    <header><p className="label">Monthly antarmukha</p><h1 className="font-heading text-2xl font-bold">Sādācāra — Monthly Reflection</h1>
      <p className="mt-2 text-sm leading-6 text-ink-soft">Quiet personal introspection on Vaiṣṇava character, respectful relationships, and humility.</p></header>
    <section className="card flex gap-3 p-4"><ShieldCheck size={20} className="mt-0.5 shrink-0 text-primary" /><p className="text-sm leading-6 text-ink-soft">An offering of the heart. Not a performance scorecard or public leaderboard. Completely private on this device.</p></section>
    {failed && !data && <Banner kind="error">Your saved reflections could not be read. Nothing was changed.</Banner>}
    <section className="card p-5" aria-label="Choose a month">
      <div className="flex items-center justify-between gap-2">
        <button type="button" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))} className="grid h-11 w-11 place-items-center rounded-xl bg-tint text-primary"><ChevronLeft size={18} /></button>
        <div className="text-center"><p className="label">{month === now ? 'Current month' : 'Selected month'}</p><h2 data-testid="sadachara-month" className="font-heading text-xl font-bold">{monthLabel(month)}</h2></div>
        <button type="button" aria-label="Next month" disabled={month >= now} onClick={() => setMonth(shiftMonth(month, 1))} className="grid h-11 w-11 place-items-center rounded-xl bg-tint text-primary disabled:opacity-40"><ChevronRight size={18} /></button>
      </div>
      <p data-testid="sadachara-month-status" className="mt-3 text-center text-sm text-muted">{data ? statusText(selected?.ratings) : 'Opening…'}</p>
      <p className="mt-3 text-sm leading-6 text-ink-soft">Take unhurried time to review interpersonal dealings, mindful boundaries, and internal dignity.</p>
      <ul className="mt-3 grid grid-cols-2 gap-2 text-xs font-semibold text-ink-soft">{SADACHARA_AREAS.map((area) => <li key={area.id} className="rounded-lg bg-tint px-3 py-2">{area.title}</li>)}</ul>
      <button type="button" disabled={!data} onClick={() => onOpen({ name: 'form', month })} className="btn-primary mt-4 min-h-[44px] w-full px-4 py-3 text-sm disabled:opacity-60">{count > 0 ? `Continue ${monthLabel(month)}` : `Begin ${monthLabel(month)}`}</button>
      {count > 0 && <button type="button" onClick={() => onOpen({ name: 'share', month })} className="btn-outlined mt-2 min-h-[44px] w-full px-4 py-3 text-sm">Review & Preview</button>}
    </section>
    <section aria-label="Past self-reflections"><h2 className="mb-3 font-heading text-lg font-bold">Past Self-Reflections</h2>
      {data && past.length === 0 && <p className="card p-4 text-sm text-muted">Nothing here yet. Months you rate will appear here, ready to open or edit.</p>}
      <ul className="space-y-3">{past.map((entry) => <li key={entry.month} className="card flex items-center justify-between gap-3 p-4">
        <div><p className="font-bold">{monthLabel(entry.month)}</p><p className="text-xs text-muted">{statusText(entry.ratings)}{averageRating(entry.ratings) !== null ? ` · average ${averageRating(entry.ratings)!.toFixed(1)}` : ''}</p></div>
        <button type="button" aria-label={`Open ${monthLabel(entry.month)}`} onClick={() => onOpen({ name: 'form', month: entry.month })} className="btn-outlined min-h-[44px] px-4 py-2 text-xs">Open</button></li>)}</ul>
    </section>
    <p className="text-xs leading-5 text-muted">Ratings stay on this device. Written answers are saved only inside your encrypted private diary and are never shared or shown on other screens.</p>
  </div>;
}

// ---- form --------------------------------------------------------------------------------------------------------------------------

function RatingRow({ value, disabled, label, onPick }: { value: Rating; disabled: boolean; label: string; onPick: (next: Rating) => void }) {
  return <div role="group" aria-label={`${label} rating`}>
    <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-11">{Array.from({ length: 11 }, (_, n) => <button key={n} type="button" disabled={disabled} aria-pressed={value === n} onClick={() => onPick(n)}
      className={`min-h-[44px] rounded-lg text-sm font-bold transition disabled:opacity-50 ${value === n ? 'bg-primary text-white' : 'bg-tint text-muted hover:bg-tint-strong'}`}>{n}</button>)}</div>
    <div className="mt-2 flex items-center justify-between text-xs text-muted">
      <span data-testid="rating-state">{isRating(value) ? `${value}/10 · ${ratingBand(value)}` : 'Not answered'}</span>
      <button type="button" disabled={disabled || !isRating(value)} onClick={() => onPick(null)} className="min-h-[44px] px-2 font-bold text-primary disabled:opacity-40">Skip this question</button>
    </div>
  </div>;
}

function Form({ month, onBack, onReview }: { month: string; onBack: () => void; onReview: () => void }) {
  const [ratings, setRatings] = useState<Record<string, Rating> | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [save, setSave] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const latest = useRef<Record<string, Rating>>(blankRatings());
  useEffect(() => {
    let active = true; setRatings(null); setLoadError(false); setSave('idle');
    getAssessment(month).then((found: SadacharaAssessment | undefined) => { if (!active) return; latest.current = found ? { ...blankRatings(), ...found.ratings } : blankRatings(); setRatings(latest.current); })
      .catch(() => { if (active) setLoadError(true); });
    return () => { active = false; };
  }, [month]);

  const persist = () => {
    setSave('saving');
    return saveAssessmentRatings(month, latest.current).then(() => setSave('saved'), () => setSave('error'));
  };
  const pick = (areaId: string, value: Rating) => { latest.current = withRating(latest.current, areaId, value); setRatings(latest.current); void persist(); };

  const back = <button type="button" onClick={onBack} className="flex min-h-[44px] items-center gap-2 text-sm font-bold text-primary"><ArrowLeft size={16} /> All months</button>;
  if (loadError) return <div className="space-y-4">{back}<Banner kind="error">This month could not be read. Nothing was changed. Please try again.</Banner></div>;
  if (!ratings) return <div className="space-y-4">{back}<p role="status" className="card p-6 text-center text-sm text-muted">Opening {monthLabel(month)}…</p></div>;
  return <div className="space-y-5">
    {back}
    <header><p className="label">Private reflection · part 1 of 2</p><h1 className="font-heading text-2xl font-bold">{monthLabel(month)} Sādācāra Reflection</h1>
      <p className="mt-2 text-sm leading-6 text-ink-soft">Devotional demeanor and sacred conduct, in six areas. Rate only what you wish to; an area you skip stays unanswered.</p></header>
    <p className="rounded-xl bg-tint p-3 text-xs leading-5 text-ink-soft">Guide: 0–3 much room · 4–6 average · 7–10 excellent. A rating of 0 is an answer; skipping is not.</p>
    <div aria-live="polite" data-testid="sadachara-save">{save === 'saving' ? <p className="text-xs text-muted">Saving…</p> : save === 'saved' ? <p className="flex items-center gap-1 text-xs font-bold text-primary"><Check size={14} /> Saved on this device</p> : null}</div>
    {save === 'error' && <div><Banner kind="error">Your ratings could not be saved. They are still on screen and nothing was discarded.</Banner><button type="button" onClick={() => void persist()} className="btn-outlined mt-2 min-h-[44px] px-4 py-2 text-xs">Retry saving</button></div>}
    {SADACHARA_AREAS.map((area, index) => <section key={area.id} className="card p-5" aria-label={area.title} data-testid={`area-${area.id}`}>
      <p className="label">{index + 1} · {area.subtitle}</p><h2 className="font-heading text-lg font-bold">{area.title}</h2>
      <p className="mb-3 mt-1 text-sm leading-6 text-ink-soft">{area.description}</p>
      <RatingRow value={ratings[area.id] ?? null} disabled={false} label={area.title} onPick={(next) => pick(area.id, next)} />
      <div className="mt-3"><PrivateGate what="Written notes"><label className="label block">Optional private note<PrivateTextField kind={SADACHARA_KIND} refId={refIdFor(month, textFieldFor('area', area.id))} label={`${area.title} note`} placeholder="A private note, if you wish…" rows={2} /></label></PrivateGate></div>
    </section>)}
    <section className="card p-5" aria-label="Personal heart reflections"><p className="label">Part 2 of 2 · end-to-end encrypted</p><h2 className="font-heading text-lg font-bold">Personal Heart Reflections</h2>
      <p className="mb-3 mt-1 text-sm leading-6 text-ink-soft">Confidential, deeply honest notes to nurture your spiritual growth. All optional, all private by default.</p>
      <PrivateGate what="Heart reflections">
        <div className="space-y-4">{SADACHARA_PROMPTS.map((prompt) => <div key={prompt.id}><p className="text-sm font-bold">{prompt.title}</p>
          <PrivateTextField kind={SADACHARA_KIND} refId={refIdFor(month, textFieldFor('prompt', prompt.id))} label={prompt.title} placeholder={prompt.placeholder} rows={3} /></div>)}</div>
      </PrivateGate>
    </section>
    <button type="button" onClick={onReview} className="btn-primary min-h-[44px] w-full px-4 py-3 text-sm">Review & Preview Reflection</button>
  </div>;
}

// ---- preview & share -----------------------------------------------------------------------------------------------------------------

function Share({ month, onBack }: { month: string; onBack: () => void }) {
  const [ratings, setRatings] = useState<Record<string, Rating> | null>(null);
  const [failed, setFailed] = useState(false);
  const [sections, setSections] = useState<ShareSectionId[]>([]); // nothing is included until the person chooses
  const [copied, setCopied] = useState<'idle' | 'ok' | 'error'>('idle');
  useEffect(() => {
    let active = true;
    getAssessment(month).then((found) => { if (active) setRatings(found ? { ...blankRatings(), ...found.ratings } : blankRatings()); }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [month]);
  const back = <button type="button" onClick={onBack} className="flex min-h-[44px] items-center gap-2 text-sm font-bold text-primary"><ArrowLeft size={16} /> Back to reflection</button>;
  if (failed) return <div className="space-y-4">{back}<Banner kind="error">This month could not be read. Nothing was changed.</Banner></div>;
  if (!ratings) return <div className="space-y-4">{back}<p role="status" className="card p-6 text-center text-sm text-muted">Opening…</p></div>;
  const average = averageRating(ratings);
  const report = buildShareReport(month, ratings, sections);
  const toggle = (id: ShareSectionId) => { setCopied('idle'); setSections((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id])); };
  const copy = async () => {
    try { await navigator.clipboard.writeText(report); setCopied('ok'); } catch { setCopied('error'); }
  };
  return <div className="space-y-5">
    {back}
    <header><p className="label">Sanctuary vault</p><h1 className="font-heading text-2xl font-bold">{monthLabel(month)} Sādācāra Summary</h1></header>
    <section className="card flex gap-3 p-4"><ShieldCheck size={20} className="mt-0.5 shrink-0 text-primary" /><p className="text-sm leading-6 text-ink-soft"><strong>Private by default.</strong> Your written reflections, struggles and family-related notes are never included in a shared report, and nothing is sent anywhere. You copy the text yourself.</p></section>
    <section className="card p-5" aria-label="Summary"><div className="flex items-baseline justify-between"><h2 className="font-heading text-lg font-bold">Six areas</h2><p data-testid="share-average" className="text-sm font-bold text-primary">{average === null ? 'No average yet' : `Average ${average.toFixed(1)}/10`}</p></div>
      <ul className="mt-3 space-y-2">{SADACHARA_AREAS.map((area) => <li key={area.id} className="flex justify-between gap-3 rounded-lg bg-tint px-3 py-2 text-sm"><span>{area.title}</span><span className="font-bold">{isRating(ratings[area.id]) ? `${ratings[area.id]}/10` : 'Not answered'}</span></li>)}</ul></section>
    <section className="card p-5" aria-label="Compose summary"><h2 className="font-heading text-lg font-bold">Choose what to include</h2><p className="mb-3 mt-1 text-xs leading-5 text-muted">Only these numeric sections can be shared.</p>
      <div className="space-y-2">{SHARE_SECTIONS.map((section) => <label key={section.id} className="flex min-h-[44px] items-center gap-3 text-sm font-semibold"><input type="checkbox" checked={sections.includes(section.id)} onChange={() => toggle(section.id)} className="h-5 w-5 accent-primary" />{section.label}</label>)}</div></section>
    <section aria-label="Preview"><p className="label mb-2">Preview · plain text</p><pre data-testid="share-preview" className="whitespace-pre-wrap rounded-xl bg-tint p-4 text-xs leading-5 text-ink-soft">{report}</pre></section>
    <button type="button" disabled={sections.length === 0} onClick={() => void copy()} className="btn-primary flex min-h-[44px] w-full items-center justify-center gap-2 px-4 py-3 text-sm disabled:opacity-60"><Copy size={16} /> Copy summary</button>
    {sections.length === 0 && <p className="text-xs text-muted">Choose at least one section to copy.</p>}
    {copied === 'ok' && <Banner kind="ok">Copied. Nothing was sent anywhere.</Banner>}
    {copied === 'error' && <Banner kind="error">Copying was not allowed here. You can select the preview text and copy it yourself.</Banner>}
    <button type="button" onClick={onBack} className="btn-outlined min-h-[44px] w-full px-4 py-3 text-sm">Done</button>
  </div>;
}

export function SadacharaScreen({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<View>({ name: 'hub' });
  if (view.name === 'form') return <Form month={view.month} onBack={() => setView({ name: 'hub' })} onReview={() => setView({ name: 'share', month: view.month })} />;
  if (view.name === 'share') return <Share month={view.month} onBack={() => setView({ name: 'form', month: view.month })} />;
  return <Hub onOpen={setView} onBack={onBack} />;
}

export function SadacharaTodayLink({ onOpen }: { onOpen: () => void }) {
  return <button type="button" onClick={onOpen} className="card mb-5 flex min-h-[64px] w-full items-center justify-between gap-3 p-5 text-left">
    <span className="min-w-0"><span className="label block">Sādācāra</span><span className="mt-1 block text-sm leading-6 text-ink-soft">A private monthly review of conduct and relationships.</span></span>
    <ChevronRight size={18} className="shrink-0 text-primary" />
  </button>;
}
