import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { liveQuery } from 'dexie';
import { Archive, ArrowLeft, BookOpen, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, ChevronDown, Flame, Flower2, Headphones, Pause, Pencil, Play, Plus, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';
import { db } from '@/lib/db';
import {
  SeasonalError, VOW_TYPES, VOW_TYPE_LABELS, daysWithRecordedActivity, dateInRange, effectiveEnd, effectiveTargetFor, japaProgress, localDateString,
  loggingBlockedReason, logIdFor, studyProgress, vowPhase, isJapaInForce, DEFAULT_MORNING_CUTOFF,
  type AbstinenceStatus, type JapaConfig, type SeasonalVow, type StudyConfig, type TargetSnapshot, type VowAction, type VowLog, type VowPhase, type VowType,
} from '@/lib/seasonal';
import { changeVowStatus, createSeasonalVow, deleteSeasonalVow, editSeasonalVow, saveVowLog } from '@/lib/seasonalService';
import {
  FORM_FIELD_ORDER, clock12, emptyForm, formFromVow, groupVows, knownSeasonNames, regularTargetFor, targetDifference, validateVowForm, vowFormToInput,
  type VowFormErrors, type VowFormField, type VowFormValues,
} from '@/lib/seasonalView';

// ---- data ---------------------------------------------------------------------------------------------------------------

interface StudyRow { id?: number; date: string; kind: string; title: string; topic?: string; minutes: number }
interface DayRow { date: string; rounds: number; targetRounds: number; targetSnapshot?: TargetSnapshot }
interface Overview { vows: SeasonalVow[]; logs: VowLog[]; studySessions: StudyRow[]; rows: DayRow[] }

/** Reads only what the screen needs. Daily reflection text is never read here, so it can never reach this screen. */
async function loadOverview(): Promise<Overview> {
  return {
    vows: await db.seasonalVows.toArray(),
    logs: await db.vowLogs.toArray(),
    studySessions: (await db.sessions.where('kind').equals('Study').toArray()).map((s) => ({ id: s.id, date: s.date, kind: s.kind, title: s.title, topic: s.topic, minutes: s.minutes })),
    rows: (await db.sadhana.toArray()).map((row) => ({ date: row.date, rounds: row.rounds, targetRounds: row.targetRounds, targetSnapshot: row.targetSnapshot })),
  };
}

/** Subscribes to IndexedDB so the screen updates itself after every change, wherever it was made. */
function useLive<T>(query: () => Promise<T>, key: string): { data?: T; failed: boolean } {
  const latest = useRef(query);
  latest.current = query;
  const [state, setState] = useState<{ data?: T; failed: boolean }>({ failed: false });
  useEffect(() => {
    const subscription = liveQuery(() => latest.current()).subscribe({
      next: (data) => setState({ data, failed: false }),
      error: () => setState((current) => ({ ...current, failed: true })),
    });
    return () => subscription.unsubscribe();
  }, [key]);
  return state;
}

function messageOf(error: unknown): string {
  if (error instanceof SeasonalError) return error.message;
  return 'Something went wrong and nothing was changed. Please try again.';
}
const formatDay = (date: string) => new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${date}T12:00:00`));
const formatShort = (date: string) => new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00`));
function shiftDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * 86_400_000).toISOString().slice(0, 10);
}
const TYPE_ICONS: Record<VowType, typeof Flower2> = { japa: Flower2, study: BookOpen, lamps: Flame, damodarastaka: Sparkles, 'evening-sravanam': Headphones, abstinence: ShieldCheck };
const PHASE_TEXT: Record<VowPhase, string> = { draft: 'Draft', upcoming: 'Not started yet', 'in-season': 'In season', ended: 'Dates have passed', paused: 'Paused', completed: 'Completed', archived: 'Archived' };

// ---- small building blocks ------------------------------------------------------------------------------------------------

function Banner({ kind, children }: { kind: 'ok' | 'error' | 'warn'; children: ReactNode }) {
  const tone = kind === 'error' ? 'bg-danger-tint text-danger' : kind === 'warn' ? 'bg-primary-tint text-primary' : 'bg-tint text-ink-soft';
  return <p role={kind === 'error' ? 'alert' : 'status'} className={`rounded-xl p-3 text-sm font-semibold leading-6 ${tone}`}>{children}</p>;
}

function ConfirmDialog({ title, body, confirmLabel, danger, busy, onConfirm, onCancel }: { title: string; body: ReactNode; confirmLabel: string; danger?: boolean; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const titleId = useId();
  return <div className="fixed inset-0 z-30 grid place-items-center bg-ink/30 p-5" onKeyDown={(event) => { if (event.key === 'Escape') onCancel(); }}>
    <div role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="card w-full max-w-sm p-6">
      <h2 id={titleId} className="font-heading text-xl font-bold">{title}</h2>
      <div className="mt-2 text-sm leading-6 text-muted">{body}</div>
      <div className="mt-5 flex gap-2">
        <button type="button" autoFocus onClick={onCancel} disabled={busy} className="btn-outlined min-h-[44px] flex-1 px-4 py-3 text-sm">Cancel</button>
        <button type="button" onClick={onConfirm} disabled={busy} className={`${danger ? 'btn-danger' : 'btn-primary'} min-h-[44px] flex-1 px-4 py-3 text-sm disabled:opacity-60`}>{busy ? 'Working…' : confirmLabel}</button>
      </div>
    </div>
  </div>;
}

function Segmented<T extends string>({ label, options, value, disabled, onPick }: { label: string; options: { value: T; label: string }[]; value: T | null; disabled?: boolean; onPick: (value: T) => void }) {
  return <div role="group" aria-label={label} className={`grid gap-2 ${options.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
    {options.map((option) => <button key={option.value} type="button" aria-pressed={value === option.value} disabled={disabled} onClick={() => onPick(option.value)}
      className={`min-h-[44px] rounded-xl px-2 py-2 text-xs font-bold transition disabled:opacity-50 ${value === option.value ? 'bg-primary text-white' : 'bg-tint text-muted hover:bg-tint-strong'}`}>{option.label}</button>)}
  </div>;
}

// ---- one commitment ------------------------------------------------------------------------------------------------------

interface CardProps {
  vow: SeasonalVow; date: string; today: string; data: Overview; busy: boolean; effectiveRounds: number; regularRounds: number;
  onLog: (vow: SeasonalVow, entry: { completed: boolean } | { abstinence: AbstinenceStatus }) => void;
  onAction: (vow: SeasonalVow, action: VowAction) => void;
  onAsk: (vow: SeasonalVow, action: 'complete' | 'archive' | 'delete') => void;
  onEdit: (vow: SeasonalVow) => void;
}

function VowCard({ vow, date, today, data, busy, effectiveRounds, regularRounds, onLog, onAction, onAsk, onEdit }: CardProps) {
  const titleId = useId();
  const Icon = TYPE_ICONS[vow.type];
  const phase = vowPhase(vow, today);
  const recorded = daysWithRecordedActivity({ vow, today, logs: data.logs, sessions: data.studySessions, sadhana: data.rows }).length;
  const log = data.logs.find((entry) => entry.id === logIdFor(vow.id, date));
  const row = data.rows.find((entry) => entry.date === date) ?? null;
  const inDates = dateInRange(vow, date);
  const readOnly = vow.status === 'completed' || vow.status === 'archived';

  let detail = '';
  if (vow.type === 'japa') { const japa = vow.config as JapaConfig; detail = `${japa.targetRounds} rounds a day, by ${clock12(japa.morningCutoff ?? DEFAULT_MORNING_CUTOFF)}`; }
  if (vow.type === 'study') { const study = vow.config as StudyConfig; detail = `${study.minutesPerDay} minutes a day${study.scripture ? ` · ${study.scripture}` : ''}`; }

  let daily: ReactNode;
  if (!inDates) daily = <p className="text-sm leading-6 text-muted">{formatShort(date)} is outside this commitment’s dates.</p>;
  else if (vow.status === 'draft') daily = <p className="text-sm leading-6 text-muted">Activate this commitment to begin recording.</p>;
  else if (vow.status === 'paused') daily = <p className="text-sm leading-6 text-muted">Paused. While paused it does not apply and nothing is recorded.</p>;
  else if (vow.status === 'archived') daily = <p className="text-sm leading-6 text-muted">Archived and kept for review.</p>;
  else if (vow.type === 'japa') {
    const progress = japaProgress(row);
    daily = date > today ? <p className="text-sm leading-6 text-muted">This day has not happened yet.</p>
      : !progress ? <p className="text-sm leading-6 text-muted">No Sādhana record for this day yet. Rounds are recorded on the Sādhana screen.</p>
      : <p className="text-sm leading-6 text-ink-soft"><strong>{progress.rounds}</strong> rounds recorded against a target of <strong>{progress.target}</strong>{progress.source === 'seasonal' ? ' (seasonal)' : ''}.</p>;
  } else if (vow.type === 'study') {
    const study = studyProgress(vow, date, data.studySessions);
    daily = date > today ? <p className="text-sm leading-6 text-muted">This day has not happened yet.</p>
      : <p className="text-sm leading-6 text-ink-soft"><strong>{study.minutes}</strong> of {study.target} minutes from {study.sessionCount} saved Study {study.sessionCount === 1 ? 'session' : 'sessions'}. Add sessions on the Sessions screen.</p>;
  } else {
    const blocked = loggingBlockedReason(vow, date, today);
    const options: { value: string; label: string }[] = vow.type === 'abstinence'
      ? [{ value: 'observed', label: 'Observed' }, { value: 'not-today', label: 'Not today' }, { value: 'unrecorded', label: 'Unrecorded' }]
      : [{ value: 'done', label: 'Done' }, { value: 'not-today', label: 'Not today' }];
    const current = vow.type === 'abstinence' ? (log?.abstinence ?? null) : log?.completed === undefined ? null : log.completed ? 'done' : 'not-today';
    daily = <div className="space-y-2">
      <Segmented label={`${vow.name} on ${formatShort(date)}`} options={options} value={current} disabled={busy || blocked !== null}
        onPick={(value) => onLog(vow, vow.type === 'abstinence' ? { abstinence: value as AbstinenceStatus } : { completed: value === 'done' })} />
      <p className="text-xs leading-5 text-muted">{blocked ?? (current ? `Recorded for ${formatShort(date)}.` : `Nothing recorded for ${formatShort(date)} yet.`)}</p>
    </div>;
  }

  const small = 'btn-outlined min-h-[44px] flex items-center justify-center gap-1 px-3 py-2 text-xs';
  return <article aria-labelledby={titleId} className="card p-4">
    <div className="flex items-start gap-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-tint-strong text-primary"><Icon size={19} /></span>
      <div className="min-w-0 flex-1">
        <h3 id={titleId} className="font-heading text-base font-bold text-primary-deep">{vow.name}</h3>
        <p className="mt-0.5 text-xs text-muted">{VOW_TYPE_LABELS[vow.type]} · {vow.seasonName}</p>
        <p className="mt-0.5 text-xs text-muted">{formatDay(vow.startDate)} – {formatDay(effectiveEnd(vow))}{vow.endedOn ? ' (ended early)' : ''}</p>
      </div>
      <span className="shrink-0 rounded-full bg-tint-strong px-2.5 py-1 text-[11px] font-bold text-secondary-ink">{PHASE_TEXT[phase]}</span>
    </div>
    {detail && <p className="mt-3 text-sm font-semibold text-ink-soft">{detail}</p>}
    {vow.type === 'japa' && vow.status === 'active' && inDates && isJapaInForce(vow, date) && <p className="mt-1 text-xs text-muted">Applies on {formatShort(date)}: {effectiveRounds} rounds, {targetDifference(effectiveRounds, regularRounds)}.</p>}
    <div className="mt-3 rounded-xl bg-tint p-3"><p className="label mb-2">{formatShort(date)}</p>{daily}</div>
    <p className="mt-3 text-xs text-muted">{recorded} {recorded === 1 ? 'day' : 'days'} with recorded activity so far</p>
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
      {vow.status === 'draft' && <button type="button" disabled={busy} onClick={() => onAction(vow, 'activate')} className="btn-primary min-h-[44px] flex items-center justify-center gap-1 px-3 py-2 text-xs"><Play size={14} /> Activate</button>}
      {vow.status === 'paused' && <button type="button" disabled={busy} onClick={() => onAction(vow, 'resume')} className="btn-primary min-h-[44px] flex items-center justify-center gap-1 px-3 py-2 text-xs"><Play size={14} /> Resume</button>}
      {vow.status === 'active' && <button type="button" disabled={busy} onClick={() => onAction(vow, 'pause')} className={small}><Pause size={14} /> Pause</button>}
      {!readOnly && <button type="button" disabled={busy} onClick={() => onEdit(vow)} className={small}><Pencil size={14} /> Edit</button>}
      {(vow.status === 'active' || vow.status === 'paused') && <button type="button" disabled={busy} onClick={() => onAsk(vow, 'complete')} className={small}><CheckCircle2 size={14} /> Complete</button>}
      {(vow.status === 'draft' || vow.status === 'paused' || vow.status === 'completed') && <button type="button" disabled={busy} onClick={() => onAsk(vow, 'archive')} className={small}><Archive size={14} /> Archive</button>}
      <button type="button" disabled={busy} onClick={() => onAsk(vow, 'delete')} className="btn-danger-outline min-h-[44px] flex items-center justify-center gap-1 px-3 py-2 text-xs"><Trash2 size={14} /> Delete</button>
    </div>
  </article>;
}

// ---- create / edit form ----------------------------------------------------------------------------------------------------

function VowForm({ mode, initial, seasonNames, regularRounds, onCancel, onSubmit }: { mode: 'create' | 'edit'; initial: VowFormValues; seasonNames: string[]; regularRounds: number; onCancel: () => void; onSubmit: (values: VowFormValues, activate: boolean) => Promise<string | null> }) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<VowFormErrors>({});
  const [serverError, setServerError] = useState('');
  const [saving, setSaving] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listId = useId();
  useEffect(() => { headingRef.current?.focus(); }, []);
  const set = (field: keyof VowFormValues, value: string) => { setValues((current) => ({ ...current, [field]: value })); if (field !== 'type') setErrors((current) => ({ ...current, [field]: undefined })); };

  const submit = async (event: FormEvent, activate: boolean) => {
    event.preventDefault();
    const found = validateVowForm(values);
    setErrors(found); setServerError('');
    const first = FORM_FIELD_ORDER.find((field) => found[field]);
    if (first) { document.getElementById(`vow-${first}`)?.focus(); return; }
    setSaving(true);
    const problem = await onSubmit(values, activate);
    setSaving(false);
    if (problem) setServerError(problem);
  };

  const field = (name: VowFormField, label: string, input: (props: Record<string, unknown>) => ReactNode, hint?: string) => {
    const id = `vow-${name}`; const error = errors[name];
    return <div>
      <label htmlFor={id} className="label block">{label}</label>
      {input({ id, 'aria-invalid': error ? true : undefined, 'aria-describedby': error ? `${id}-error` : hint ? `${id}-hint` : undefined })}
      {hint && !error && <p id={`${id}-hint`} className="mt-1 text-xs leading-5 text-muted">{hint}</p>}
      {error && <p id={`${id}-error`} className="mt-1 text-xs font-semibold text-danger">{error}</p>}
    </div>;
  };
  const text = (name: VowFormField, extra: Record<string, unknown> = {}) => (props: Record<string, unknown>) => <input {...props} {...extra} value={values[name]} onChange={(event) => set(name, event.target.value)} className="field mt-2 bg-white" />;
  const targetNumber = Number(values.targetRounds);
  const japaNote = values.type === 'japa' && /^\d+$/.test(values.targetRounds.trim()) ? `That is ${targetDifference(targetNumber, regularRounds)}.` : undefined;

  return <form onSubmit={(event) => void submit(event, false)} noValidate aria-labelledby="vow-form-title" className="space-y-4">
    <div className="card p-5">
      <h2 id="vow-form-title" ref={headingRef} tabIndex={-1} className="font-heading text-xl font-bold text-primary-deep outline-none">{mode === 'create' ? 'New seasonal commitment' : 'Edit commitment'}</h2>
      <p className="mt-1 text-sm leading-6 text-muted">You choose the season’s name and its dates; nothing is assumed. A seasonal commitment adds to your daily routine. Only a Japa target replaces your regular target, and only on its dates.</p>
      <div className="mt-4 space-y-4">
        <div>
          <label htmlFor="vow-type" className="label block">Type of commitment</label>
          <select id="vow-type" value={values.type} disabled={mode === 'edit'} onChange={(event) => set('type', event.target.value)} className="field mt-2 bg-white">
            {VOW_TYPES.map((type) => <option key={type} value={type}>{VOW_TYPE_LABELS[type]}</option>)}
          </select>
          {mode === 'edit' && <p className="mt-1 text-xs text-muted">The type cannot be changed after it is created.</p>}
        </div>
        {field('seasonName', 'Season name', text('seasonName', { list: listId, autoComplete: 'off', maxLength: 80 }), 'Any name you like, shared by the commitments of one season.')}
        <datalist id={listId}>{seasonNames.map((name) => <option key={name} value={name} />)}</datalist>
        {field('name', 'Commitment name', text('name', { autoComplete: 'off', maxLength: 120 }))}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {field('startDate', 'Starts on', text('startDate', { type: 'date' }))}
          {field('endDate', 'Ends on (included)', text('endDate', { type: 'date' }))}
        </div>
      </div>
    </div>

    {values.type === 'japa' && <div className="card space-y-4 p-5">
      <h3 className="font-heading text-base font-bold text-primary-deep">Japa target</h3>
      <p className="text-sm leading-6 text-muted">Your regular target is <strong>{regularRounds} rounds</strong> and stays unchanged. This target applies only between the dates above, and only while the commitment is active.</p>
      {field('targetRounds', 'Rounds per day', text('targetRounds', { inputMode: 'numeric', autoComplete: 'off' }), japaNote)}
      {field('morningCutoff', 'Morning cutoff', text('morningCutoff', { type: 'time' }), 'The time by which you mean to finish these rounds. Default 7:00 AM.')}
    </div>}

    {values.type === 'study' && <div className="card space-y-4 p-5">
      <h3 className="font-heading text-base font-bold text-primary-deep">Scriptural study</h3>
      {field('scripture', 'Scripture (optional)', text('scripture', { autoComplete: 'off', maxLength: 120 }), 'If set, only Study sessions whose title or topic mention it count. Leave empty to count every Study session.')}
      {field('minutesPerDay', 'Minutes per day', text('minutesPerDay', { inputMode: 'numeric', autoComplete: 'off' }), 'Progress is counted from the Study sessions you save on the Sessions screen.')}
    </div>}

    {values.type !== 'japa' && values.type !== 'study' && <p className="rounded-xl bg-tint p-4 text-sm leading-6 text-muted">{VOW_TYPE_LABELS[values.type]} needs no extra details. You record each day on the overview as Done, Not today{values.type === 'abstinence' ? ', Observed or Unrecorded' : ''}.</p>}

    {serverError && <Banner kind="error">{serverError}</Banner>}
    <div className="grid gap-2 sm:grid-cols-3">
      {mode === 'create' ? <>
        <button type="submit" disabled={saving} className="btn-outlined min-h-[44px] px-4 py-3 text-sm">{saving ? 'Saving…' : 'Save as draft'}</button>
        <button type="button" disabled={saving} onClick={(event) => void submit(event, true)} className="btn-primary min-h-[44px] px-4 py-3 text-sm">{saving ? 'Saving…' : 'Save and activate'}</button>
      </> : <button type="submit" disabled={saving} className="btn-primary min-h-[44px] px-4 py-3 text-sm sm:col-span-2">{saving ? 'Saving…' : 'Save changes'}</button>}
      <button type="button" disabled={saving} onClick={onCancel} className="btn-outlined min-h-[44px] px-4 py-3 text-sm">Cancel</button>
    </div>
  </form>;
}

// ---- the screen -------------------------------------------------------------------------------------------------------------

export function SankalpaScreen({ onBack }: { onBack: () => void }) {
  const today = localDateString();
  const [date, setDate] = useState(today);
  const { data, failed } = useLive(loadOverview, 'overview');
  const [editor, setEditor] = useState<{ mode: 'create' } | { mode: 'edit'; vow: SeasonalVow } | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ action: 'complete' | 'archive' | 'delete'; vow: SeasonalVow } | null>(null);

  const act = async (task: () => Promise<string>) => {
    setBusy(true); setNotice(null);
    try { setNotice({ kind: 'ok', text: await task() }); } catch (error) { setNotice({ kind: 'error', text: messageOf(error) }); } finally { setBusy(false); }
  };

  const back = <button type="button" onClick={onBack} className="mb-4 flex min-h-[44px] items-center gap-2 text-sm font-bold text-primary"><ArrowLeft size={16} /> Back to Today</button>;
  if (failed && !data) return <>{back}<Banner kind="error">Your saved commitments could not be read. Nothing was changed. Please reload the app.</Banner></>;
  if (!data) return <>{back}<p role="status" className="card p-6 text-center text-sm text-muted">Opening your commitments…</p></>;

  const groups = groupVows(data.vows);
  const japaVows = data.vows.filter((vow) => vow.type === 'japa');
  const dayRow = data.rows.find((row) => row.date === date) ?? null;
  const regular = regularTargetFor(date, data.rows);
  const effective = effectiveTargetFor(dayRow, date, today, regular, japaVows);

  if (editor) {
    const submit = async (values: VowFormValues, activate: boolean): Promise<string | null> => {
      try {
        const input = vowFormToInput(values);
        if (editor.mode === 'edit') {
          await editSeasonalVow(editor.vow.id, { seasonName: input.seasonName, name: input.name, startDate: input.startDate, endDate: input.endDate, config: input.config });
          setNotice({ kind: 'ok', text: 'Changes saved. Days you already recorded keep the target they were recorded with.' });
        } else {
          const created = await createSeasonalVow(input);
          if (!activate) setNotice({ kind: 'ok', text: 'Saved as a draft. Activate it when you are ready.' });
          else {
            try { await changeVowStatus(created.id, 'activate'); setNotice({ kind: 'ok', text: 'Commitment saved and activated.' }); }
            catch (error) { setNotice({ kind: 'error', text: `Saved as a draft, but it could not be activated. ${messageOf(error)}` }); }
          }
        }
        setEditor(null);
        return null;
      } catch (error) { return messageOf(error); }
    };
    return <>{back}<VowForm key={editor.mode === 'edit' ? editor.vow.id : 'new'} mode={editor.mode} initial={editor.mode === 'edit' ? formFromVow(editor.vow) : emptyForm('japa')} seasonNames={knownSeasonNames(data.vows)} regularRounds={regular} onCancel={() => setEditor(null)} onSubmit={submit} /></>;
  }

  const log = (vow: SeasonalVow, entry: { completed: boolean } | { abstinence: AbstinenceStatus }) => void act(async () => { await saveVowLog(vow.id, date, entry); return `Recorded for ${formatShort(date)}.`; });
  const action = (vow: SeasonalVow, what: VowAction) => void act(async () => { await changeVowStatus(vow.id, what); return { activate: 'Activated.', resume: 'Resumed.', pause: 'Paused. Your history is kept.', complete: 'Completed. Your history is kept.', archive: 'Archived. Your history is kept.' }[what]; });
  const confirmed = () => {
    if (!confirm) return;
    const { action: what, vow } = confirm;
    void act(async () => {
      try {
        if (what === 'delete') { await deleteSeasonalVow(vow.id, { confirmed: true }); return `“${vow.name}” and its daily records were deleted.`; }
        await changeVowStatus(vow.id, what); return what === 'complete' ? 'Completed. Your history is kept.' : 'Archived. Your history is kept.';
      } finally { setConfirm(null); }
    });
  };
  const cardFor = (vow: SeasonalVow) => <VowCard key={vow.id} vow={vow} date={date} today={today} data={data} busy={busy} effectiveRounds={effective.rounds} regularRounds={regular} onLog={log} onAction={action} onAsk={(target, what) => setConfirm({ action: what, vow: target })} onEdit={(target) => { setNotice(null); setEditor({ mode: 'edit', vow: target }); }} />;

  const section = (title: string, vows: SeasonalVow[], note?: string) => vows.length > 0 && <section aria-label={title} className="space-y-3"><div><h2 className="font-heading text-lg font-bold text-primary-deep">{title}</h2>{note && <p className="text-xs text-muted">{note}</p>}</div>{vows.map(cardFor)}</section>;

  return <>
    {back}
    <div className="mb-5"><p className="label mb-2">Seasonal commitments</p><h1 className="font-heading text-3xl font-bold leading-tight text-primary-deep">Seasonal Saṅkalpa</h1>
      <p className="mt-3 text-sm leading-6 text-muted">Take up extra commitments for a season you choose. You enter every date yourself. They add to your daily routine; only a Japa target replaces your regular one, on its dates alone, and your regular target is never changed.</p></div>

    <section aria-label="Day" className="card mb-4 p-4">
      <div className="flex items-stretch gap-2">
        <button type="button" aria-label="Previous day" onClick={() => setDate(shiftDate(date, -1))} className="grid min-h-[44px] min-w-[44px] place-items-center rounded-xl bg-tint text-primary"><ChevronLeft size={18} /></button>
        <label className="relative min-w-0 flex-1 rounded-xl px-2 py-1 text-center">
          <span className="label block">{date === today ? 'Today' : 'Selected day'}</span>
          <span className="mt-0.5 flex items-center justify-center gap-2 text-base font-bold text-primary-deep"><CalendarDays size={16} className="text-primary-soft" />{formatDay(date)}</span>
          <input type="date" aria-label="Choose day" value={date} onChange={(event) => event.target.value && setDate(event.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
        </label>
        <button type="button" aria-label="Next day" onClick={() => setDate(shiftDate(date, 1))} className="grid min-h-[44px] min-w-[44px] place-items-center rounded-xl bg-tint text-primary"><ChevronRight size={18} /></button>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-xl bg-tint p-3"><dt className="label">Regular target</dt><dd className="mt-1 text-lg font-bold text-primary-deep">{regular} rounds</dd></div>
        <div className="rounded-xl bg-tint p-3"><dt className="label">Target for this day</dt><dd className="mt-1 text-lg font-bold text-primary-deep">{effective.rounds} rounds</dd></div>
      </dl>
      <p className="mt-3 text-xs leading-5 text-muted" data-testid="target-explanation">
        {effective.conflict ? 'Your regular target is used because seasonal Japa commitments disagree (see below).'
          : effective.source === 'seasonal' ? `Seasonal target from “${effective.vowName}”, ${targetDifference(effective.rounds, regular)}.${dayRow?.targetSnapshot && date < today ? ' This is the target that day was recorded with.' : ''}`
          : effective.source === 'regular-unrecorded' ? 'This day was recorded before seasonal commitments existed, so its saved regular target is shown.'
          : 'No seasonal Japa target applies on this day.'}
      </p>
      {effective.conflict && <div className="mt-3"><Banner kind="error">More than one active seasonal Japa commitment covers this day with different targets ({effective.conflict.targets.join(' and ')} rounds). One is never chosen for you, so the regular target applies. Pause or change one of them.</Banner></div>}
    </section>

    {notice && <div className="mb-4"><Banner kind={notice.kind}>{notice.text}</Banner></div>}

    <button type="button" onClick={() => { setNotice(null); setEditor({ mode: 'create' }); }} className="btn-primary mb-5 flex min-h-[48px] w-full items-center justify-center gap-2 px-4 py-3 text-sm"><Plus size={18} /> Add a commitment</button>

    {data.vows.length === 0 && <div className="card p-6 text-center"><p className="font-bold">No seasonal commitments yet</p><p className="mt-2 text-sm leading-6 text-muted">When a season begins, add the commitments you wish to take up. Nothing is assumed about the calendar, so you enter the dates.</p></div>}

    <div className="space-y-6">
      {section('Active', groups.active, 'Commitments you have activated. Dates that have passed are shown as such.')}
      {section('Drafts', groups.drafts, 'Saved but not yet in effect.')}
      {section('Paused', groups.paused)}
      {groups.history.length > 0 && <details className="group"><summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between rounded-xl bg-tint-strong px-4 py-3 text-sm font-bold text-primary-deep"><span>History ({groups.history.length})</span><ChevronDown size={16} /></summary><div className="mt-3 space-y-3">{groups.history.map(cardFor)}</div></details>}
    </div>

    {confirm && <ConfirmDialog busy={busy} danger={confirm.action === 'delete'} onCancel={() => { if (!busy) setConfirm(null); }} onConfirm={confirmed}
      title={confirm.action === 'delete' ? 'Delete this commitment?' : confirm.action === 'complete' ? 'Complete this commitment?' : 'Archive this commitment?'}
      confirmLabel={confirm.action === 'delete' ? 'Delete permanently' : confirm.action === 'complete' ? 'Complete' : 'Archive'}
      body={confirm.action === 'delete' ? <p>“{confirm.vow.name}” and all of its daily records will be permanently removed. This cannot be undone. Days already recorded in Sādhana keep the target they were recorded with. To keep the history, pause, complete or archive it instead.</p>
        : confirm.action === 'complete' ? <p>“{confirm.vow.name}” ends today and no longer applies afterwards. Everything recorded is kept, and a completed commitment cannot be edited or resumed.</p>
        : <p>“{confirm.vow.name}” moves to History for review. Everything recorded is kept.</p>} />}
  </>;
}

/** Compact entry point shown on the Today screen. */
export function SankalpaTodayLink({ onOpen }: { onOpen: () => void }) {
  const { data } = useLive(async () => db.seasonalVows.toArray(), 'today-link');
  const today = localDateString();
  const inForce = data?.filter((vow) => vow.status === 'active' && dateInRange(vow, today)).length ?? 0;
  return <button type="button" onClick={onOpen} className="card mb-5 flex min-h-[64px] w-full items-center justify-between gap-3 p-5 text-left">
    <span className="min-w-0"><span className="label block">Seasonal Saṅkalpa</span>
      <span className="mt-1 block text-sm leading-6 text-ink-soft">{!data ? 'Opening…' : data.length === 0 ? 'Add commitments for a season you choose.' : inForce > 0 ? `${inForce} ${inForce === 1 ? 'commitment' : 'commitments'} in force today.` : 'No commitment is in force today.'}</span></span>
    <ChevronRight size={18} className="shrink-0 text-primary" />
  </button>;
}
