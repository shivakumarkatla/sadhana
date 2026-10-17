/**
 * Browser-level verification of the private diary against the REAL app and REAL IndexedDB in a real (headless) Chrome.
 * Starts the Vite dev server, uses brand-new browser profiles, and only disposable test text ("TESTSECRET-...").
 * Run: npm run test:browser
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession, Page, sleep } from './cdp.ts';

const APP_PORT = 5199;
const URL = `http://127.0.0.1:${APP_PORT}/`;
const P1 = 'first test passphrase one'; const P2 = 'second test passphrase two'; const P3 = 'third test passphrase three'; const P4 = 'fourth test passphrase four';
const TEXTAREA = 'textarea[aria-label="Daily reflection"]';
const PLAIN_TEXTAREA = 'textarea[placeholder^="Record any insight"]';

const pad = (value: number) => String(value).padStart(2, '0');
const localDate = (offsetDays: number) => { const date = new Date(); date.setDate(date.getDate() + offsetDays); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; };
const DATES = [localDate(0), localDate(-1), localDate(-2)];
const SEEDS = ['  TESTSECRET-0 Śrī Kṛṣṇa 🙏🏽  \n  second line  ', 'TESTSECRET-1 yesterday’s note', 'TESTSECRET-2 two days ago — सत्यं'];

const results: { name: string; ok: boolean; detail?: string }[] = [];
async function step(name: string, body: () => Promise<void>): Promise<void> {
  // Development shortcut only: E2E_ONLY='^(24|25)\.' runs just the matching steps. The real gate is always the full run.
  if (process.env.E2E_ONLY && !new RegExp(process.env.E2E_ONLY).test(name)) return;
  try { await body(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (error) { const detail = error instanceof Error ? error.message : String(error); results.push({ name, ok: false, detail }); console.log(`  FAIL  ${name}\n        ${detail.split('\n').slice(0, 14).join('\n        ')}`); }
}

// ---- helpers that run inside the page against the real database ----
interface Snapshot { rounds: number; source: string; vowId?: string; vowName?: string; morningCutoff?: string }
interface Dump { sessions: unknown[]; offerings: unknown[]; sadhana: { id: number; date: string; reflection: string; rounds: number; targetRounds: number; targetSnapshot?: Snapshot }[]; encryptionMeta: { state: string; lockTimeoutMinutes: number }[]; privateContent: { id: string; rev: number }[]; seasonalVows: { id: string; type: string; status: string; name: string; endedOn?: string; config: Record<string, unknown> }[]; vowLogs: { id: string; vowId: string; date: string; completed?: boolean; createdAt: string; snapshot: { name: string } }[] }
const dump = (page: Page) => page.run<Dump>(async () => {
  const { db } = await import('/src/lib/db.ts');
  return { sessions: await db.sessions.toArray(), offerings: await db.offerings.toArray(), sadhana: await db.sadhana.toArray(), encryptionMeta: await db.encryptionMeta.toArray(), privateContent: await db.privateContent.toArray(), seasonalVows: await db.seasonalVows.toArray(), vowLogs: await db.vowLogs.toArray() } as never;
});
/** Every store of the real database, read through the raw IndexedDB API (not the app's Dexie object), with primary keys. */
const rawDump = (page: Page) => page.run<Record<string, { key: unknown; value: unknown }[]>>(async () => {
  const connection = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('sadhana-devotional-companion'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  try {
    const out: Record<string, { key: unknown; value: unknown }[]> = {};
    for (const name of Array.from(connection.objectStoreNames)) {
      out[name] = await new Promise((resolve, reject) => {
        const tx = connection.transaction(name, 'readonly'); const store = tx.objectStore(name); const keys = store.getAllKeys(); const values = store.getAll();
        tx.oncomplete = () => resolve(keys.result.map((key, index) => ({ key, value: values.result[index] }))); tx.onerror = () => reject(tx.error);
      });
    }
    return out;
  } finally { connection.close(); }
});
const seedPlain = (page: Page) => page.run(async (dates: string[], seeds: string[], seasonEnd: string) => {
  const { db, saveSadhanaForDate } = await import('/src/lib/db.ts');
  const seasonal = await import('/src/lib/seasonalService.ts');
  // Seasonal commitments first, so the daily rows saved below pick up their target snapshots through the real save path.
  const japa = await seasonal.createSeasonalVow({ type: 'japa', seasonName: 'TEST season', name: 'SEED extra japa', startDate: dates[2], endDate: seasonEnd, config: { targetRounds: 20 } });
  await seasonal.changeVowStatus(japa.id, 'activate');
  const lamp = await seasonal.createSeasonalVow({ type: 'lamps', seasonName: 'TEST season', name: 'SEED evening lamp', startDate: dates[2], endDate: seasonEnd, config: {} });
  await seasonal.changeVowStatus(lamp.id, 'activate');
  await seasonal.saveVowLog(lamp.id, dates[1], { completed: true });
  for (let index = 0; index < dates.length; index += 1) {
    await saveSadhanaForDate({ date: dates[index], rounds: 10 + index, targetRounds: 16, earlyRounds: 4, sixteenthRoundTime: '', wakeUp: '4:15 AM', bedtime: '10:00 PM', sleepOnset: '10:20 PM', mangalaArati: 'Attended', qualityTags: ['Good focus'], reflection: seeds[index] } as never);
  }
  await db.sessions.add({ date: dates[0], kind: 'Study', title: 'SEED Srimad-Bhagavatam study', minutes: 45, note: 'seed' });
  await db.offerings.add({ date: dates[0], kind: 'Calling Service', minutes: 30, description: 'SEED calls' });
}, DATES, SEEDS, localDate(20));
const nav = async (page: Page, label: string) => { await page.click(label, true); await sleep(250); };
const openSettings = async (page: Page) => { await page.click('Open settings', true); await page.waitText('Private diary'); };
const clean = (page: Page) => page.run(async () => { localStorage.removeItem('sadhana.diary.unlockThrottle'); });
const reloadAndWait = async (page: Page) => { await page.reload(); await page.waitFor(() => page.ui<boolean>('exists', 'main'), 'app render'); await sleep(400); };
const noSecret = (dumpData: Dump, ...needles: string[]) => { const text = JSON.stringify(dumpData); for (const needle of needles) assert.equal(text.includes(needle), false, `IndexedDB contains readable "${needle}"`); };
const textareaValue = (page: Page, selector = TEXTAREA) => page.ui<string | null>('valueOf', selector);
const unlockOnSadhana = async (page: Page, passphrase: string) => {
  await nav(page, 'Sādhana'); await page.waitText('Your diary is locked');
  await page.fill('Diary passphrase', passphrase); await page.click('Unlock diary');
  await page.waitFor(() => page.ui<boolean>('exists', 'textarea[aria-label="Daily reflection"]:not([disabled])'), 'diary unlocked and the editor finished decrypting');
};
/** name -> last-modified time, so a download that reuses an existing file name is still noticed. */
const snapshotDir = (dir: string) => new Map(readdirSync(dir).map((name) => [name, statSync(join(dir, name)).mtimeMs] as const));
const waitFile = async (dir: string, pattern: RegExp, before: Map<string, number>): Promise<string> => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const found = readdirSync(dir).find((name) => pattern.test(name) && !name.endsWith('.crdownload') && (!before.has(name) || before.get(name) !== statSync(join(dir, name)).mtimeMs));
    if (found) { await sleep(300); return join(dir, found); }
    await sleep(150);
  }
  throw new Error(`download matching ${pattern} did not arrive`);
};
const failTransactions = (page: Page, mode: 'always' | 'after-first') => page.run(async (failureMode: string) => {
  const { db } = await import('/src/lib/db.ts');
  const win = window as unknown as { __origTx?: typeof db.transaction; __txCalls?: number };
  if (!win.__origTx) win.__origTx = db.transaction;
  const original = win.__origTx; win.__txCalls = 0;
  (db as unknown as { transaction: unknown }).transaction = function (this: unknown, ...args: unknown[]) {
    const touches = args.some((arg) => arg === db.privateContent || (Array.isArray(arg) && arg.includes(db.privateContent)));
    if (touches) { win.__txCalls = (win.__txCalls ?? 0) + 1; if (failureMode === 'always' || (win.__txCalls ?? 0) > 1) return Promise.reject(new Error('simulated storage failure')); }
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  };
}, mode);
const restoreTransactions = (page: Page) => page.run(async () => {
  const { db } = await import('/src/lib/db.ts');
  const win = window as unknown as { __origTx?: unknown };
  if (win.__origTx) (db as unknown as { transaction: unknown }).transaction = win.__origTx;
});

async function startServer(): Promise<ChildProcess> {
  if (await fetch(URL).then(() => true, () => false)) throw new Error(`Port ${APP_PORT} is already serving something. Stop it and run again so the test uses a fresh server.`);
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--port', String(APP_PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' });
  for (let attempt = 0; attempt < 120; attempt += 1) { try { if ((await fetch(URL)).ok) return server; } catch { await sleep(250); } }
  server.kill(); throw new Error('Vite dev server did not start.');
}

async function main() {
  const server = await startServer();
  const a = await BrowserSession.launch(9331);
  let b: BrowserSession | undefined;
  const page = a.page;
  try {
    await page.goto(URL); await sleep(4000); await page.goto(URL); // first load can trigger Vite dependency optimisation
    await page.waitFor(() => page.ui<boolean>('exists', 'main'), 'app render');
    let key1 = ''; let key2 = ''; let backupAfterPath = ''; let seasonalSnapshotAtBackup = '';

    console.log('\nProfile A: setup, locking, failed saves');
    await step('1. plain mode: seed data, reflection shows and plain autosave still works', async () => {
      await seedPlain(page); await reloadAndWait(page); await nav(page, 'Sādhana');
      await page.waitFor(async () => (await textareaValue(page, PLAIN_TEXTAREA)) === SEEDS[0], 'seed reflection in plain textarea');
      await page.ui('fillSelector', PLAIN_TEXTAREA, `${SEEDS[0]} edited`); await sleep(600);
      const data = await dump(page); assert.equal(data.sadhana.find((row) => row.date === DATES[0])!.reflection, `${SEEDS[0]} edited`);
      await page.ui('fillSelector', PLAIN_TEXTAREA, SEEDS[0]); await sleep(600);
      assert.equal((await dump(page)).sadhana.find((row) => row.date === DATES[0])!.reflection, SEEDS[0]);
    });

    await step('2. setup wizard: verified backup, recovery key, migration encrypts exactly', async () => {
      await openSettings(page); await page.click('Set up private diary'); await page.waitText('will be encrypted after your consent'); await page.click('I agree, continue');
      const before = snapshotDir(a.downloadDir); await page.click('Create and download backup'); await page.waitText('Backup created and checked');
      const beforeFile = await waitFile(a.downloadDir, /before-encryption/, before);
      const backup = JSON.parse(readFileSync(beforeFile, 'utf8')) as { containsPlaintextReflections: boolean; counts: Record<string, number>; stores: Record<string, unknown[]> };
      assert.equal(backup.containsPlaintextReflections, true); assert.equal(backup.counts.sadhana, 3); assert.equal(backup.counts.sessions, 1);
      assert.deepEqual(Object.keys(backup.stores).sort(), ['encryptionMeta', 'offerings', 'privateContent', 'sadhana', 'seasonalVows', 'sessions', 'vowLogs']);
      await page.ui('check', 'I saved the backup file'); await page.click('Continue', true);
      await page.fill('Passphrase', P1); await page.fill('Repeat passphrase', P1); await page.click('Continue', true);
      await page.waitText('Step 3'); key1 = (await page.ui<string>('textOf', '[aria-label="Recovery key"]')).trim();
      assert.match(key1, /^([0-9A-Z]{4}-){13}[0-9A-Z]{4}$/);
      await page.ui('check', 'I have saved this recovery key'); await page.click('Continue', true);
      await page.fill('Recovery key', key1); await page.click('Verify and encrypt'); await page.waitText('Private diary is on', 60_000);
      const data = await dump(page);
      assert.equal(data.encryptionMeta[0].state, 'enabled'); assert.equal(data.privateContent.length, 3);
      assert.ok(data.sadhana.every((row) => row.reflection === ''), 'plaintext cleared from every Sādhana row');
      noSecret(data, 'TESTSECRET', P1, key1);
      assert.equal(data.sadhana.length, 3); assert.deepEqual(data.sadhana.map((row) => row.rounds).sort(), [10, 11, 12]); // non-reflection fields intact
      await nav(page, 'Sādhana'); await page.waitFor(async () => (await textareaValue(page)) === SEEDS[0], 'decrypted reflection equals the original exactly');
    });

    await step('3. reload locks; wrong passphrase refused; correct passphrase unlocks to exact text', async () => {
      await reloadAndWait(page); await nav(page, 'Sādhana'); await page.waitText('Your diary is locked');
      assert.equal(await textareaValue(page), null); noSecret(await dump(page), 'TESTSECRET');
      await page.fill('Diary passphrase', 'definitely wrong passphrase'); await page.click('Unlock diary'); await page.waitText('incorrect');
      assert.equal(await textareaValue(page), null);
      await page.fill('Diary passphrase', P1); await page.click('Unlock diary');
      await page.waitFor(async () => (await textareaValue(page)) === SEEDS[0], 'exact text after unlock');
    });

    await step('4. typing then locking immediately saves the text first', async () => {
      const before = (await dump(page)).privateContent.find((record) => record.id === `reflection:${DATES[0]}`)!.rev;
      await page.ui('fillSelector', TEXTAREA, 'TESTSECRET-typed-then-lock'); await page.click('Lock diary');
      await page.waitText('Your diary is locked');
      const data = await dump(page); noSecret(data, 'TESTSECRET');
      assert.ok(data.privateContent.find((record) => record.id === `reflection:${DATES[0]}`)!.rev > before, 'encrypted entry was re-saved before locking');
      await page.fill('Diary passphrase', P1); await page.click('Unlock diary');
      await page.waitFor(async () => (await textareaValue(page)) === 'TESTSECRET-typed-then-lock', 'typed text survived the lock');
    });

    await step('5. failed save: text kept, notice on every screen, lock refused, date switch, beforeunload, retry', async () => {
      await failTransactions(page, 'always');
      await page.ui('fillSelector', TEXTAREA, 'TESTSECRET-unsaved-draft'); await page.waitText('Not saved yet');
      noSecret(await dump(page), 'TESTSECRET-unsaved');
      await nav(page, 'Today'); await page.waitText('Private diary text is not saved yet');
      await nav(page, 'Sādhana'); assert.equal(await textareaValue(page), 'TESTSECRET-unsaved-draft', 'draft restored after navigating away and back');
      await page.ui('clickSelector', 'button[aria-label^="Previous day"]'); await page.waitFor(async () => (await textareaValue(page)) === SEEDS[1], 'other date shows its own saved text');
      await page.ui('clickSelector', 'button[aria-label^="Next day"]'); await page.waitFor(async () => (await textareaValue(page)) === 'TESTSECRET-unsaved-draft', 'draft is back after returning to its date');
      await openSettings(page); await page.click('Lock diary now'); await page.waitText('stays unlocked'); await page.waitText('Unlocked');
      assert.equal(await page.eval<boolean>('(() => { const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })()'), true, 'browser is asked before closing with unsaved text');
      await restoreTransactions(page); await page.click('Retry saving'); await page.waitGone('Private diary text is not saved yet');
      const data = await dump(page); noSecret(data, 'TESTSECRET');
      await reloadAndWait(page); await unlockOnSadhana(page, P1);
      assert.equal(await textareaValue(page), 'TESTSECRET-unsaved-draft', 'retry persisted the text');
    });

    await step('5b. stale plaintext can never be written back once the diary is on', async () => {
      await page.run(async (date: string) => { const { saveSadhanaForDate, loadSadhanaForDate } = await import('/src/lib/db.ts'); const record = await loadSadhanaForDate(date); await saveSadhanaForDate({ ...record, rounds: 14, reflection: 'TESTSECRET-STALE-PLAINTEXT' }); }, DATES[0]);
      let data = await dump(page); noSecret(data, 'STALE-PLAINTEXT');
      assert.ok(data.sadhana.every((row) => row.reflection === ''), 'a direct write with plaintext was neutralised');
      assert.equal(data.sadhana.find((row) => row.date === DATES[0])!.rounds, 14, 'its other fields were still saved');
      await page.click('Add one round', true); await sleep(500); // the screen still holds the pre-write value (10), so this saves 11
      data = await dump(page); noSecret(data, 'STALE-PLAINTEXT');
      assert.ok(data.sadhana.every((row) => row.reflection === ''), 'a normal autosave from stale screen state wrote no plaintext');
      assert.equal(data.sadhana.find((row) => row.date === DATES[0])!.rounds, 11, 'normal autosave of other fields still works');
    });

    console.log('\nProfile A: throttling, recovery, passphrase change');
    await step('6. throttle after 3 wrong passphrases; survives reload; recovery key still unlocks and resets it', async () => {
      await page.click('Open settings', true); await page.click('Lock diary now'); await page.waitText('Locked');
      for (let attempt = 0; attempt < 3; attempt += 1) { await page.fill('Diary passphrase', `wrong passphrase number ${attempt}`); await page.click('Unlock diary'); await sleep(200); await page.waitButton('Unlock diary'); }
      await page.fill('Diary passphrase', P1); await page.click('Unlock diary'); await page.waitText('Too many incorrect attempts');
      assert.match(await page.eval<string>('localStorage.getItem("sadhana.diary.unlockThrottle") ?? ""'), /"failures":3/);
      await reloadAndWait(page); await openSettings(page); await page.fill('Diary passphrase', P1); await page.click('Unlock diary'); await page.waitText('Too many incorrect attempts');
      await page.click('Forgot your passphrase'); await page.fill('Recovery key', key1.toLowerCase()); await page.fill('New passphrase (12+ characters)', P2); await page.fill('Repeat new passphrase', P2);
      await page.click('Recover', true); await page.waitText('Unlocked', 60_000);
      assert.equal(await page.eval<string>('localStorage.getItem("sadhana.diary.unlockThrottle") ?? "cleared"'), 'cleared');
      await nav(page, 'Sādhana'); await page.waitFor(async () => (await textareaValue(page)) === 'TESTSECRET-unsaved-draft', 'entries unchanged by recovery');
    });

    await step('7. change passphrase: old one stops working, new one works, entries untouched', async () => {
      const before = JSON.stringify((await dump(page)).privateContent);
      await openSettings(page); await page.click('Change passphrase'); await page.fill('Current passphrase', P2); await page.fill('New passphrase (12+ characters)', P3); await page.fill('Repeat new passphrase', P3);
      await page.click('Change passphrase'); await page.waitText('Passphrase changed', 60_000);
      assert.equal(JSON.stringify((await dump(page)).privateContent), before, 'no entry was re-encrypted');
      await page.click('Lock diary now'); await reloadAndWait(page); await openSettings(page);
      await page.fill('Diary passphrase', P2); await page.click('Unlock diary'); await page.waitText('incorrect');
      await page.fill('Diary passphrase', P3); await page.click('Unlock diary'); await page.waitText('Unlocked', 60_000);
    });

    await step('8. replace recovery key: old key rejected, new key verified and works', async () => {
      await page.click('New recovery key'); await page.fill('Current passphrase', P3); await page.click('Create new key'); await page.waitText('Save this key');
      key2 = (await page.ui<string>('textOf', '[aria-label="Recovery key"]')).trim(); assert.notEqual(key2, key1);
      await page.ui('check', 'I have saved the new recovery key'); await page.fill('Type the new key to confirm', key2); await page.click('Confirm new key');
      await page.waitText('New recovery key confirmed'); await page.click('Lock diary now'); await reloadAndWait(page); await openSettings(page);
      await page.click('Forgot your passphrase'); await page.fill('Recovery key', key1); await page.fill('New passphrase (12+ characters)', P4); await page.fill('Repeat new passphrase', P4); await page.click('Recover', true);
      await page.waitText('does not unlock this diary');
      await page.fill('Recovery key', key2); await page.click('Recover', true); await page.waitText('Unlocked', 60_000);
    });

    console.log('\nProfile A: inactivity lock');
    await step('9. resume after the inactivity period locks; the idle timer locks too', async () => {
      await page.fill('Lock after inactivity', '1'); await sleep(500);
      assert.equal((await dump(page)).encryptionMeta[0].lockTimeoutMinutes, 1);
      await page.eval('(() => { const real = Date.now.bind(Date); Date.now = () => real() + 3 * 60_000; Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); })()');
      await page.waitText('Locked'); await reloadAndWait(page); await openSettings(page);
      await page.fill('Diary passphrase', P4); await page.click('Unlock diary'); await page.waitText('Unlocked', 60_000);
      const started = Date.now(); await page.waitText('Locked', 100_000); // no activity events: the 1-minute timer must fire
      assert.ok(Date.now() - started >= 45_000, `locked too early (${Date.now() - started} ms)`);
    });

    console.log('\nProfile A: regular features while locked, backup');
    await step('10. while locked: Today, Sessions, Preaching, Insights and Sādhana tracking all work; text stays hidden', async () => {
      await reloadAndWait(page);
      await nav(page, 'Today'); await page.waitText('Today'); await nav(page, 'Sessions'); await page.waitText('SEED Srimad-Bhagavatam study');
      await nav(page, 'Preaching'); await page.waitText('Preaching & Outreach'); await page.waitText('SEED calls');
      await nav(page, 'Insights'); await page.waitText('Insights'); await page.waitText('ROUNDS CHANTED'); // innerText applies the uppercase label style
      await nav(page, 'Sādhana'); await page.waitText('Your diary is locked');
      const rounds = (await dump(page)).sadhana.find((row) => row.date === DATES[0])!.rounds;
      await page.click('Add one round', true); await sleep(600);
      const data = await dump(page); assert.equal(data.sadhana.find((row) => row.date === DATES[0])!.rounds, rounds + 1); noSecret(data, 'TESTSECRET');
      assert.equal(await textareaValue(page), null); assert.equal(await page.ui('hasText', 'TESTSECRET'), false);
    });

    await step('11. encrypted backup: all seven stores, wrapped keys, ciphertext only, no secrets', async () => {
      await openSettings(page); const before = snapshotDir(a.downloadDir); await page.click('Export full backup'); await page.waitText('Backup created and checked');
      backupAfterPath = await waitFile(a.downloadDir, /^sadhana-backup-\d/, before);
      const stable = join(a.downloadDir, 'backup1-copy.json'); copyFileSync(backupAfterPath, stable); backupAfterPath = stable; // later downloads may reuse the original name
      const text = readFileSync(backupAfterPath, 'utf8'); const backup = JSON.parse(text) as { diaryState: string; containsPlaintextReflections: boolean; counts: Record<string, number>; stores: { encryptionMeta: Record<string, unknown>[] } };
      assert.equal(backup.diaryState, 'enabled'); assert.equal(backup.containsPlaintextReflections, false);
      assert.deepEqual(backup.counts, { sessions: 1, offerings: 1, sadhana: 3, encryptionMeta: 1, privateContent: 3, seasonalVows: 2, vowLogs: 1 });
      const seasonalAtBackup = JSON.stringify({ vows: (await dump(page)).seasonalVows, logs: (await dump(page)).vowLogs }); seasonalSnapshotAtBackup = seasonalAtBackup;
      assert.ok(backup.stores.encryptionMeta[0].passphraseWrap && backup.stores.encryptionMeta[0].recoveryWrap, 'wrapped keys included');
      for (const forbidden of ['TESTSECRET', P1, P2, P3, P4, key1, key2, key2.replace(/-/g, '')]) assert.equal(text.includes(forbidden), false, `backup leaks ${forbidden.slice(0, 8)}…`);
    });

    console.log('\nProfile A: Seasonal Saṅkalpa data layer (real IndexedDB)');
    await step('11b. seasonal commitments: day snapshots, stable history, conflicts, no duplicate logs, confirmed deletion', async () => {
      const before = await dump(page);
      assert.equal(before.sadhana.length, 3);
      for (const row of before.sadhana) { assert.equal(row.targetRounds, 16, 'the regular target was never overwritten'); assert.deepEqual([row.targetSnapshot?.source, row.targetSnapshot?.rounds], ['seasonal', 20], 'each day records the seasonal target that applied'); }
      const closedBefore = before.sadhana.filter((row) => row.date !== DATES[0]).map((row) => ({ date: row.date, snapshot: row.targetSnapshot }));
      // Edit, pause, resume, complete and archive the Japa commitment, then save the days again through the real autosave path.
      const outcome = await page.run<{ status: string; endedOn?: string; effectiveClosed: { rounds: number; source: string }; effectiveFuture: { rounds: number; source: string } }>(async (yesterday: string, future: string) => {
        const seasonal = await import('/src/lib/seasonalService.ts'); const { loadSadhanaForDate, saveSadhanaForDate } = await import('/src/lib/db.ts');
        const japa = (await seasonal.listVows()).find((vow) => vow.type === 'japa')!;
        await seasonal.editSeasonalVow(japa.id, { config: { targetRounds: 30 } });
        for (const action of ['pause', 'resume', 'complete', 'archive'] as const) await seasonal.changeVowStatus(japa.id, action);
        const record = await loadSadhanaForDate(yesterday); await saveSadhanaForDate({ ...record, rounds: record.rounds + 1 });
        const finished = (await seasonal.listVows()).find((vow) => vow.id === japa.id)!;
        return { status: finished.status, endedOn: finished.endedOn, effectiveClosed: await seasonal.getEffectiveTarget(yesterday, 16), effectiveFuture: await seasonal.getEffectiveTarget(future, 16) } as never;
      }, DATES[1], localDate(5));
      assert.equal(outcome.status, 'archived'); assert.ok(outcome.endedOn);
      const after = await dump(page);
      assert.deepEqual(after.sadhana.filter((row) => row.date !== DATES[0]).map((row) => ({ date: row.date, snapshot: row.targetSnapshot })), closedBefore, 'closed days keep their snapshots after the commitment was edited, paused, completed and archived, even when saved again');
      assert.equal(after.sadhana.find((row) => row.date === DATES[1])!.rounds, before.sadhana.find((row) => row.date === DATES[1])!.rounds + 1, 'the re-save really happened');
      assert.ok(after.sadhana.every((row) => row.targetRounds === 16));
      assert.deepEqual([outcome.effectiveClosed.rounds, outcome.effectiveClosed.source], [20, 'seasonal'], 'a past day still reports the target it was recorded against');
      assert.deepEqual([outcome.effectiveFuture.rounds, outcome.effectiveFuture.source], [16, 'regular'], 'once the commitment is archived the regular target applies again, unchanged');
      // Conflicts, duplicate prevention and confirmed deletion.
      const checks = await page.run<Record<string, unknown>>(async (start: string, end: string, lampDate: string) => {
        const seasonal = await import('/src/lib/seasonalService.ts'); const { db } = await import('/src/lib/db.ts'); const out: Record<string, unknown> = {};
        const first = await seasonal.createSeasonalVow({ type: 'japa', seasonName: 'TEST', name: 'Conflict A', startDate: start, endDate: end, config: { targetRounds: 18 } });
        await seasonal.changeVowStatus(first.id, 'activate');
        const second = await seasonal.createSeasonalVow({ type: 'japa', seasonName: 'TEST', name: 'Conflict B', startDate: start, endDate: end, config: { targetRounds: 22 } });
        try { await seasonal.changeVowStatus(second.id, 'activate'); out.conflict = 'accepted'; } catch (error) { out.conflict = (error as Error).message; }
        out.secondStatus = (await db.seasonalVows.get(second.id))?.status;
        const lamp = (await seasonal.listVows()).find((vow) => vow.type === 'lamps')!;
        const original = await db.vowLogs.get(`${lamp.id}|${lampDate}`);
        await seasonal.saveVowLog(lamp.id, lampDate, { completed: false }); await seasonal.saveVowLog(lamp.id, lampDate, { completed: false });
        const rows = await db.vowLogs.where('vowId').equals(lamp.id).toArray();
        out.logRows = rows.filter((row) => row.date === lampDate).length; out.completedNow = rows.find((row) => row.date === lampDate)?.completed; out.createdKept = rows.find((row) => row.date === lampDate)?.createdAt === original?.createdAt;
        try { await seasonal.saveVowLog(lamp.id, '2999-01-01', { completed: true }); out.future = 'accepted'; } catch { out.future = 'refused'; }
        try { await seasonal.deleteSeasonalVow(first.id, { confirmed: false }); out.unconfirmed = 'deleted'; } catch { out.unconfirmed = 'refused'; }
        out.stillThere = !!(await db.seasonalVows.get(first.id));
        await seasonal.saveVowLog(lamp.id, lampDate, { completed: true });
        await seasonal.deleteSeasonalVow(first.id, { confirmed: true }); await seasonal.deleteSeasonalVow(second.id, { confirmed: true });
        out.goneAfterConfirm = !(await db.seasonalVows.get(first.id)) && !(await db.seasonalVows.get(second.id));
        return out;
      }, localDate(30), localDate(40), DATES[1]);
      assert.match(String(checks.conflict), /Only one seasonal Japa target/); assert.equal(checks.secondStatus, 'draft', 'the conflicting commitment stayed a draft');
      assert.equal(checks.logRows, 1, 'logging twice never creates a second row'); assert.equal(checks.completedNow, false); assert.equal(checks.createdKept, true);
      assert.equal(checks.future, 'refused'); assert.equal(checks.unconfirmed, 'refused'); assert.equal(checks.stillThere, true); assert.equal(checks.goneAfterConfirm, true);
      const end = await dump(page);
      assert.equal(end.seasonalVows.length, 2, 'only the two seeded commitments remain'); assert.equal(end.vowLogs.length, 1);
      assert.equal(end.sadhana.every((row) => row.targetRounds === 16), true);
      noSecret(end, 'TESTSECRET');
    });

    console.log('\nProfile B (fresh browser profile): restore');
    b = await BrowserSession.launch(9332);
    const pageB = b.page;
    await pageB.goto(URL); await sleep(1500); await pageB.goto(URL); await pageB.waitFor(() => pageB.ui<boolean>('exists', 'main'), 'app render (B)');
    let snapshotB = '';
    await step('12. fresh profile starts empty; invalid files are rejected and change nothing', async () => {
      const empty = await dump(pageB); assert.equal(empty.sadhana.length + empty.sessions.length + empty.privateContent.length, 0);
      await seedPlain(pageB); snapshotB = JSON.stringify(await dump(pageB)); await openSettings(pageB);
      const good = JSON.parse(readFileSync(backupAfterPath, 'utf8')) as Record<string, unknown> & { stores: { sessions: Record<string, unknown>[] } };
      const bad: [string, string, string][] = [
        ['not json', '{ not json', 'not valid JSON'],
        ['legacy export', JSON.stringify({ sessions: [], offerings: [], exportedAt: 'x' }), 'older, incomplete export'],
        ['tampered', JSON.stringify({ ...good, stores: { ...good.stores, sessions: [{ ...good.stores.sessions[0], minutes: 999 }] } }), 'checksum does not match'],
        ['wrong app', JSON.stringify({ ...good, app: 'other' }), 'not created by this app'],
      ];
      for (const [name, content, expected] of bad) {
        const path = join(b!.downloadDir, `bad-${name.replace(/ /g, '-')}.json`); writeFileSync(path, content);
        await pageB.setFile('input[type=file]', path); await pageB.waitText(expected); await pageB.waitText('Nothing was changed');
        assert.equal(JSON.stringify(await dump(pageB)), snapshotB, `${name}: database changed`);
      }
    });

    await step('13. a restore that fails midway leaves the previous data exactly as it was', async () => {
      await pageB.run(async () => {
        const { db } = await import('/src/lib/db.ts');
        const original = db.transaction; (window as unknown as { __txB: unknown }).__txB = original;
        (db as unknown as { transaction: unknown }).transaction = function (this: unknown, ...args: unknown[]) {
          if (args[0] === 'rw' && Array.isArray(args[1]) && args[1].length === 7) {
            (db as unknown as { transaction: unknown }).transaction = original;
            return (original as (...a: unknown[]) => unknown).call(this, 'rw', args[1], async () => { await db.sessions.clear(); await db.sadhana.clear(); throw new Error('simulated failure after clearing'); });
          }
          return (original as (...a: unknown[]) => unknown).apply(this, args);
        };
      });
      await pageB.setFile('input[type=file]', backupAfterPath); await pageB.waitText('Restore this backup?'); await pageB.click('Replace my data');
      await pageB.waitText('could not be completed'); assert.equal(JSON.stringify(await dump(pageB)), snapshotB, 'previous data preserved after a mid-restore failure');
      await pageB.run(async () => { const { db } = await import('/src/lib/db.ts'); (db as unknown as { transaction: unknown }).transaction = (window as unknown as { __txB: unknown }).__txB; });
    });

    await step('14. valid restore into the fresh profile, then unlock with passphrase and (after lock) with recovery key', async () => {
      await pageB.setFile('input[type=file]', backupAfterPath); await pageB.waitText('Restore this backup?'); await pageB.click('Replace my data'); await pageB.waitText('Backup restored and verified');
      const data = await dump(pageB); assert.equal(data.sadhana.length, 3); assert.equal(data.privateContent.length, 3); assert.equal(data.encryptionMeta[0].state, 'enabled'); noSecret(data, 'TESTSECRET');
      assert.equal(JSON.stringify({ vows: data.seasonalVows, logs: data.vowLogs }), seasonalSnapshotAtBackup, 'seasonal commitments and logs survived export and restore exactly');
      assert.ok(data.sadhana.every((row) => row.targetSnapshot?.source === 'seasonal' && row.targetSnapshot.rounds === 20 && row.targetRounds === 16), 'per-day target snapshots survived too, and the regular target is still 16');
      await reloadAndWait(pageB); await unlockOnSadhana(pageB, P4);
      assert.equal(await textareaValue(pageB), 'TESTSECRET-unsaved-draft');
      await pageB.ui('clickSelector', 'button[aria-label^="Previous day"]'); await pageB.waitFor(async () => (await textareaValue(pageB)) === SEEDS[1], 'older restored entry decrypts');
      await reloadAndWait(pageB); await openSettings(pageB); await pageB.click('Forgot your passphrase'); await pageB.fill('Recovery key', key2);
      await pageB.fill('New passphrase (12+ characters)', 'restored profile new pass'); await pageB.fill('Repeat new passphrase', 'restored profile new pass'); await pageB.click('Recover', true); await pageB.waitText('Unlocked', 60_000);
      await nav(pageB, 'Sādhana'); await pageB.waitFor(async () => (await textareaValue(pageB)) === 'TESTSECRET-unsaved-draft', 'recovery key unlocks the restored diary');
    });

    console.log('\nProfile A: Delete All and interrupted migration');
    await step('15. Delete All empties every store and the visible UI', async () => {
      await reloadAndWait(page); await openSettings(page); await page.click('Delete all local records');
      await page.waitText('Delete all local records?'); await page.click('Delete', true); await page.waitText('All local records were deleted');
      const data = await dump(page); assert.deepEqual([data.sessions.length, data.offerings.length, data.sadhana.length, data.encryptionMeta.length, data.privateContent.length, data.seasonalVows.length, data.vowLogs.length], [0, 0, 0, 0, 0, 0, 0], 'Delete All cleared every store, including the seasonal ones');
      await page.waitText('Set up private diary'); await nav(page, 'Sessions'); assert.equal(await page.ui('hasText', 'SEED Srimad-Bhagavatam study'), false);
      await nav(page, 'Preaching'); assert.equal(await page.ui('hasText', 'SEED calls'), false);
      await nav(page, 'Sādhana'); await page.waitFor(async () => (await textareaValue(page, PLAIN_TEXTAREA)) === '', 'blank plain reflection after Delete All');
    });

    await step('15b. a recorded day keeps its morning cutoff (real IndexedDB and screen); editing, pausing, completing or deleting the commitment cannot change it', async () => {
      const [today, yesterday, dayBefore] = DATES;
      const made = await page.run<{ vowId: string; yesterday?: Snapshot; today?: Snapshot }>(async (dates: string[], end: string) => {
        const seasonal = await import('/src/lib/seasonalService.ts'); const { saveSadhanaForDate, db } = await import('/src/lib/db.ts');
        const vow = await seasonal.createSeasonalVow({ type: 'japa', seasonName: 'TEST cutoff', name: 'CUTOFF japa', startDate: dates[1], endDate: end, config: { targetRounds: 22, morningCutoff: '06:30' } });
        await seasonal.changeVowStatus(vow.id, 'activate');
        const base = { rounds: 10, targetRounds: 16, earlyRounds: 4, sixteenthRoundTime: '', wakeUp: '', bedtime: '', sleepOnset: '', mangalaArati: 'Unrecorded', reflection: '' };
        const savedYesterday = await saveSadhanaForDate({ ...base, date: dates[1] } as never); // a past day entered now: the rule in force at entry
        const savedToday = await saveSadhanaForDate({ ...base, date: dates[0] } as never);     // an open day
        await db.sadhana.add({ ...base, date: dates[2], targetSnapshot: { rounds: 22, source: 'seasonal', vowId: vow.id, vowName: 'CUTOFF japa' } } as never); // a day saved before cutoffs were stored
        return { vowId: vow.id, yesterday: savedYesterday, today: savedToday } as never;
      }, DATES, localDate(10));
      const recorded: Snapshot = { rounds: 22, source: 'seasonal', vowId: made.vowId, vowName: 'CUTOFF japa', morningCutoff: '06:30' };
      assert.deepEqual(made.yesterday, recorded, 'the save returns the snapshot it stored, cutoff included'); assert.deepEqual(made.today, recorded);
      const rowOf = (data: Dump, date: string) => data.sadhana.find((row) => row.date === date)!;
      let data = await dump(page);
      assert.deepEqual(rowOf(data, yesterday).targetSnapshot, recorded, 'the stored row has the target and the cutoff'); assert.deepEqual(rowOf(data, today).targetSnapshot, recorded);
      assert.ok(data.sadhana.every((row) => row.targetRounds === 16), 'the regular target was never overwritten');
      assert.equal('morningCutoff' in (rowOf(data, dayBefore).targetSnapshot as object), false, 'the older snapshot was not given a cutoff');
      const closedBefore = JSON.stringify([rowOf(data, yesterday).targetSnapshot, rowOf(data, dayBefore).targetSnapshot]);

      // The commitment is edited while today is still open; then time moves on two days, so today's row is a CLOSED day and is saved again.
      const afterClose = await page.run<{ resaved?: Snapshot; context: { rounds: number; morningCutoff: string; cutoffSource: string; cutoffNote: string | null } }>(async (id: string, dates: string[]) => {
        const seasonal = await import('/src/lib/seasonalService.ts'); const { loadSadhanaForDate, saveSadhanaForDate, db } = await import('/src/lib/db.ts'); const rules = await import('/src/lib/seasonal.ts');
        await seasonal.editSeasonalVow(id, { config: { targetRounds: 30, morningCutoff: '05:00' } });
        const RealDate = Date; const offset = 2 * 86_400_000;
        class ShiftedDate extends RealDate { constructor(...args: unknown[]) { if (args.length === 0) super(RealDate.now() + offset); else super(...(args as [number])); } static now() { return RealDate.now() + offset; } }
        (globalThis as unknown as { Date: unknown }).Date = ShiftedDate;
        try {
          const record = await loadSadhanaForDate(dates[0]);
          const resaved = await saveSadhanaForDate({ ...record, rounds: record.rounds + 1 });
          const vows = await db.seasonalVows.where('type').equals('japa').toArray();
          const reloaded = await loadSadhanaForDate(dates[0]);
          const context = rules.japaDayContext(reloaded, dates[0], rules.localDateString(), 16, vows);
          return { resaved, context: { rounds: context.rounds, morningCutoff: context.morningCutoff, cutoffSource: context.cutoffSource, cutoffNote: context.cutoffNote } } as never;
        } finally { (globalThis as unknown as { Date: unknown }).Date = RealDate; }
      }, made.vowId, DATES);
      assert.deepEqual(afterClose.resaved, recorded, 'saving a day that has since closed returns its stored snapshot: not the edited 30 rounds / 05:00');
      assert.deepEqual(afterClose.context, { rounds: 22, morningCutoff: '06:30', cutoffSource: 'seasonal', cutoffNote: null }, 'and it is what that closed day displays');

      // Pause, resume, complete, archive and finally delete the commitment, saving the closed days again each time.
      await page.run(async (id: string, dates: string[]) => {
        const seasonal = await import('/src/lib/seasonalService.ts'); const { loadSadhanaForDate, saveSadhanaForDate } = await import('/src/lib/db.ts');
        for (const action of ['pause', 'resume', 'complete', 'archive'] as const) { await seasonal.changeVowStatus(id, action); for (const date of [dates[1], dates[2]]) { const record = await loadSadhanaForDate(date); await saveSadhanaForDate(record); } }
        await seasonal.deleteSeasonalVow(id, { confirmed: true });
        for (const date of [dates[1], dates[2]]) { const record = await loadSadhanaForDate(date); await saveSadhanaForDate({ ...record, rounds: record.rounds + 1 }); }
      }, made.vowId, DATES);
      data = await dump(page);
      assert.equal(JSON.stringify([rowOf(data, yesterday).targetSnapshot, rowOf(data, dayBefore).targetSnapshot]), closedBefore, 'closed days keep exactly the snapshots they had, through edit, pause, resume, complete, archive and delete');
      assert.equal(rowOf(data, yesterday).rounds, 11, 'the final re-save really happened'); assert.ok(data.sadhana.every((row) => row.targetRounds === 16));

      // What the screen shows, from a fresh load, with the commitment gone.
      const targetNote = () => page.ui<string | null>('textOf', '[data-testid="sadhana-target-note"]');
      const cutoffNote = () => page.ui<string | null>('textOf', '[data-testid="sadhana-cutoff-note"]');
      await reloadAndWait(page); await nav(page, 'Sādhana');
      assert.equal(await targetNote(), null, 'today: the commitment is gone, so the regular target and no seasonal note'); assert.equal(await page.ui('hasText', 'before 7:00 AM'), true, 'today: the default cutoff');
      await page.ui('clickSelector', 'button[aria-label^="Previous day"]');
      await page.waitFor(async () => /target of 22 rounds/.test((await targetNote()) ?? ''), 'yesterday shows the target it was recorded with');
      assert.match((await targetNote()) ?? '', /before 6:30 AM/); assert.equal(await cutoffNote(), null, 'no apology note: the cutoff was saved');
      assert.equal(await page.ui('hasText', 'before 6:30 AM'), true, 'the early-rounds label uses the recorded cutoff');
      await page.click('Add one round', true); await sleep(600); // saving again must neither change nor contradict what is shown
      assert.equal(await page.ui('hasText', 'before 6:30 AM'), true, 'still the recorded cutoff after saving');
      assert.deepEqual(rowOf(await dump(page), yesterday).targetSnapshot, recorded);
      await page.ui('clickSelector', 'button[aria-label^="Previous day"]');
      await page.waitFor(async () => /target of 22 rounds/.test((await targetNote()) ?? '') && (await cutoffNote()) !== null, 'the older day shows its target and the explanatory note');
      assert.match((await cutoffNote()) ?? '', /not saved with the day, so 7:00 AM is shown/); assert.equal(await page.ui('hasText', 'before 7:00 AM'), true, 'the established fallback');
      await page.click('Add one round', true); await sleep(600);
      assert.equal(await page.ui('hasText', 'before 7:00 AM'), true, 'saving the older day does not invent a cutoff');
      assert.equal('morningCutoff' in (rowOf(await dump(page), dayBefore).targetSnapshot as object), false, 'and none was written to it');
      await page.run(async () => { const { db } = await import('/src/lib/db.ts'); await db.sadhana.clear(); await db.seasonalVows.clear(); await db.vowLogs.clear(); }); // leave the database empty for the next step
    });

    await step('16. interrupted migration keeps plaintext, shows unfinished setup, and resumes to completion', async () => {
      await clean(page); await seedPlain(page); await reloadAndWait(page); await openSettings(page);
      await page.click('Set up private diary'); await page.click('I agree, continue'); await page.click('Create and download backup'); await page.waitText('Backup created and checked');
      await page.ui('check', 'I saved the backup file'); await page.click('Continue', true); await page.fill('Passphrase', P1); await page.fill('Repeat passphrase', P1); await page.click('Continue', true);
      await page.waitText('Step 3'); const key = (await page.ui<string>('textOf', '[aria-label="Recovery key"]')).trim();
      await page.ui('check', 'I have saved this recovery key'); await page.click('Continue', true); await page.fill('Recovery key', key);
      await failTransactions(page, 'after-first'); await page.click('Verify and encrypt'); await page.waitText('simulated storage failure', 60_000);
      let data = await dump(page); assert.equal(data.encryptionMeta[0].state, 'migrating'); assert.equal(data.privateContent.length, 1);
      assert.equal(data.sadhana.filter((row) => row.reflection !== '').length, 2, 'unfinished rows keep their original text');
      await reloadAndWait(page); await openSettings(page); await page.waitText('Setup was not finished');
      await nav(page, 'Sādhana'); await page.waitText('Private diary setup was not finished');
      await openSettings(page); await page.fill('Diary passphrase', P1); await page.click('Unlock diary'); await page.waitText('Resume encryption', 60_000); await page.click('Resume encryption'); await page.waitText('Private diary is on', 60_000);
      data = await dump(page); assert.equal(data.encryptionMeta[0].state, 'enabled'); assert.equal(data.privateContent.length, 3); noSecret(data, 'TESTSECRET');
      await nav(page, 'Sādhana'); await page.waitFor(async () => (await textareaValue(page)) === SEEDS[0], 'all text intact after resume');
    });

    console.log('\nProfile A: draft, discard and throttle gates');
    await step('17. Discard text: Keep text cancels, confirming removes the draft and the editor shows the saved text', async () => {
      await nav(page, 'Sādhana'); await page.waitFor(async () => (await textareaValue(page)) === SEEDS[0], 'saved text visible');
      await failTransactions(page, 'always');
      await page.ui('fillSelector', TEXTAREA, 'TESTSECRET-discard-me'); await page.waitText('Not saved yet');
      await nav(page, 'Today'); await page.waitText('Private diary text is not saved yet');
      await page.click('Discard text'); await page.waitButton('Yes, discard it'); await page.waitButton('Keep text');
      await page.click('Keep text'); await page.waitButton('Discard text'); await page.waitText('Private diary text is not saved yet');
      await nav(page, 'Sādhana'); assert.equal(await textareaValue(page), 'TESTSECRET-discard-me', 'cancelling kept the draft');
      await page.click('Discard text'); await page.click('Yes, discard it'); await page.waitGone('Private diary text is not saved yet');
      await page.waitFor(async () => (await textareaValue(page)) === SEEDS[0], 'editor shows the saved text after discarding');
      await restoreTransactions(page); noSecret(await dump(page), 'discard-me');
    });

    await step('17b. unsaved text is saved the moment the page is hidden, frozen or unloaded, without waiting for the 700 ms timer', async () => {
      await nav(page, 'Sādhana'); await page.waitFor(() => page.ui<boolean>('exists', `${TEXTAREA}:not([disabled])`), 'editor ready');
      const id = `reflection:${DATES[0]}`; const before = (await dump(page)).privateContent.find((record) => record.id === id)!.rev;
      const triggers = [
        '(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); })()',
        'window.dispatchEvent(new Event("pagehide"))',
        'document.dispatchEvent(new Event("freeze"))',
      ];
      for (const [index, trigger] of triggers.entries()) {
        await page.ui('fillSelector', TEXTAREA, `TESTSECRET-hide-${index}`); await page.eval(trigger);
        await page.waitFor(async () => (await dump(page)).privateContent.find((record) => record.id === id)!.rev > before + index, `encrypted save right after trigger ${index} (the debounce timer would take 700 ms)`, 600);
        await page.eval('Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })');
      }
      noSecret(await dump(page), 'TESTSECRET');
    });

    await step('18. two dates keep separate drafts; a real beforeunload prompt protects them; restore is refused while unsaved; retry saves both', async () => {
      await nav(page, 'Sādhana'); await failTransactions(page, 'always');
      await page.ui('fillSelector', TEXTAREA, 'TESTSECRET-draft-today'); await page.waitText('Not saved yet');
      await page.ui('clickSelector', 'button[aria-label^="Previous day"]'); await page.waitFor(async () => (await textareaValue(page)) === SEEDS[1], 'yesterday loads its own saved text');
      await page.ui('fillSelector', TEXTAREA, 'TESTSECRET-draft-yesterday');
      await nav(page, 'Sessions'); await nav(page, 'Sādhana');
      assert.equal(await textareaValue(page), 'TESTSECRET-draft-today', 'today draft kept after leaving the screen');
      await page.ui('clickSelector', 'button[aria-label^="Previous day"]'); await page.waitFor(async () => (await textareaValue(page)) === 'TESTSECRET-draft-yesterday', 'yesterday draft kept');
      const seen = page.eventCount(); await page.realClick(5, 5); page.startNavigation(URL);
      const dialog = await page.waitEvent('Page.javascriptDialogOpening', seen); assert.equal(dialog.type, 'beforeunload');
      await page.handleDialog(false); await sleep(600);
      assert.equal(await textareaValue(page), 'TESTSECRET-draft-yesterday', 'declining the prompt kept the page and its draft');
      const before = JSON.stringify(await dump(page));
      await openSettings(page); await page.setFile('input[type=file]', backupAfterPath); await page.waitText('Restore this backup?'); await page.click('Replace my data');
      await page.waitText('could not be saved'); assert.equal(JSON.stringify(await dump(page)), before, 'restore refused and nothing changed');
      await restoreTransactions(page); await page.click('Retry saving'); await page.waitGone('Private diary text is not saved yet');
      noSecret(await dump(page), 'TESTSECRET');
      await reloadAndWait(page); await unlockOnSadhana(page, P1);
      assert.equal(await textareaValue(page), 'TESTSECRET-draft-today');
      await page.ui('clickSelector', 'button[aria-label^="Previous day"]'); await page.waitFor(async () => (await textareaValue(page)) === 'TESTSECRET-draft-yesterday', 'both drafts persisted');
    });

    await step('19. the five-second unlock throttle really expires', async () => {
      await openSettings(page); await page.click('Lock diary now'); await page.waitText('Locked');
      for (let attempt = 0; attempt < 3; attempt += 1) { await page.fill('Diary passphrase', `wrong again ${attempt}`); await page.click('Unlock diary'); await sleep(200); await page.waitButton('Unlock diary'); }
      await page.fill('Diary passphrase', P1); await page.click('Unlock diary'); await page.waitText('Too many incorrect attempts');
      const until = Number(JSON.parse(await page.eval<string>('localStorage.getItem("sadhana.diary.unlockThrottle")')).until);
      assert.ok(until - Date.now() <= 5_100, 'delay is five seconds');
      await sleep(800); await page.click('Unlock diary'); await sleep(900);
      assert.equal(await page.ui('hasText', 'Unlocked'), false, 'still blocked before the delay ends');
      await sleep(Math.max(0, until - Date.now()) + 400);
      await page.click('Unlock diary'); await page.waitText('Unlocked', 60_000);
    });

    let backup3Path = '';
    await step('20. export a second, different encrypted backup', async () => {
      const before = snapshotDir(a.downloadDir); await page.click('Export full backup'); await page.waitText('Backup created and checked');
      const downloaded = await waitFile(a.downloadDir, /^sadhana-backup-\d/, before);
      backup3Path = join(a.downloadDir, 'backup3-copy.json'); copyFileSync(downloaded, backup3Path);
      assert.notEqual(backup3Path, backupAfterPath);
    });

    console.log('\nProfile A: real reload prompt');
    await step('20b. a REAL reload with unsaved private text asks first: declining keeps the text; accepting loses it (documented limitation) without leaving readable data', async () => {
      await nav(page, 'Sādhana'); await page.waitFor(() => page.ui<boolean>('exists', 'textarea[aria-label="Daily reflection"]:not([disabled])'), 'editor ready');
      const saved = await textareaValue(page); const marker = 'TESTSECRET-reload-draft';
      await failTransactions(page, 'always');
      await page.ui('fillSelector', TEXTAREA, marker); await page.waitText('Not saved yet'); noSecret(await dump(page), marker);
      await page.realClick(5, 5);
      let seen = page.eventCount(); page.startReload();
      assert.equal((await page.waitEvent('Page.javascriptDialogOpening', seen)).type, 'beforeunload', 'a real reload raises the browser prompt');
      await page.handleDialog(false); await sleep(700);
      assert.equal(await textareaValue(page), marker, 'declining the reload kept the page and the draft');
      assert.equal(await page.ui('hasText', 'Not saved yet'), true, 'and it is still flagged as not saved');
      noSecret(await dump(page), marker);
      seen = page.eventCount(); page.startReload(); await page.waitEvent('Page.javascriptDialogOpening', seen); await page.handleDialog(true);
      await sleep(800); await page.waitFor(() => page.ui<boolean>('exists', 'main'), 'app render after the accepted reload'); await sleep(400);
      noSecret(await dump(page), marker); // the lost draft left nothing behind, readable or otherwise
      await unlockOnSadhana(page, P1);
      assert.equal(await textareaValue(page), saved, 'after accepting, only the previously saved text remains (the unsaved draft is gone: unavoidable once the page is closed)');
    });

    console.log('\nProfile B: restore rollback');
    await step('21. restore rollback after a read-back mismatch returns every store exactly; diary stays locked', async () => {
      await reloadAndWait(pageB); await openSettings(pageB);
      const original = await dump(pageB);
      assert.ok(original.sessions.length > 0 && original.offerings.length > 0 && original.sadhana.length > 0 && original.encryptionMeta.length === 1 && original.privateContent.length > 0, 'original state spans all five stores');
      const backup3 = JSON.parse(readFileSync(backup3Path, 'utf8')) as { stores: Record<string, unknown[]> };
      assert.notEqual(JSON.stringify(backup3.stores.privateContent), JSON.stringify(original.privateContent), 'the backup has different ciphertext');
      assert.notEqual(JSON.stringify(backup3.stores.encryptionMeta), JSON.stringify(original.encryptionMeta), 'the backup has different key records');
      await pageB.run(async () => { // corrupt ONLY the verification read that follows the write (the 2nd five-store read transaction)
        const { db } = await import('/src/lib/db.ts');
        const win = window as unknown as { __origTxB?: unknown; __mid?: string; __reads?: number };
        win.__origTxB = db.transaction; win.__reads = 0; win.__mid = '';
        const original = db.transaction as (...a: unknown[]) => Promise<Record<string, Record<string, unknown>[]>>;
        (db as unknown as { transaction: unknown }).transaction = function (this: unknown, ...args: unknown[]) {
          const promise = original.apply(this, args);
          if (args[0] === 'r' && Array.isArray(args[1]) && args[1].length === 7) {
            win.__reads = (win.__reads ?? 0) + 1;
            if (win.__reads === 2) return promise.then((stores) => { win.__mid = JSON.stringify(stores); const copy = JSON.parse(win.__mid) as typeof stores; copy.sessions = copy.sessions.map((row) => ({ ...row, minutes: Number(row.minutes) + 1 })); return copy; });
          }
          return promise;
        };
      });
      await pageB.setFile('input[type=file]', backup3Path); await pageB.waitText('Restore this backup?'); await pageB.click('Replace my data');
      await pageB.waitText('put back unchanged'); assert.equal(await pageB.ui('hasText', 'Backup restored and verified'), false);
      const mid = JSON.parse(await pageB.eval<string>('window.__mid')) as Record<string, unknown[]>;
      for (const name of ['sessions', 'offerings', 'sadhana', 'encryptionMeta', 'privateContent', 'seasonalVows', 'vowLogs']) assert.deepEqual(mid[name], backup3.stores[name], `${name}: the restored data really was written before the rollback`);
      const after = await dump(pageB);
      for (const name of ['sessions', 'offerings', 'sadhana', 'encryptionMeta', 'privateContent', 'seasonalVows', 'vowLogs'] as const) assert.deepEqual(after[name], original[name], `${name} identical after rollback`);
      assert.equal(JSON.stringify(after), JSON.stringify(original));
      await pageB.run(async () => { const { db } = await import('/src/lib/db.ts'); (db as unknown as { transaction: unknown }).transaction = (window as unknown as { __origTxB: unknown }).__origTxB; });
      await nav(pageB, 'Sādhana'); await pageB.waitText('Your diary is locked'); assert.equal(await textareaValue(pageB), null);
    });

    await step('21b. rollback after a REAL stored mismatch (a stray row and an altered row written after the restore) returns every store exactly, checked in raw IndexedDB', async () => {
      await reloadAndWait(pageB); await openSettings(pageB);
      const originalApp = await dump(pageB); const originalRaw = await rawDump(pageB);
      assert.deepEqual(Object.keys(originalRaw).sort(), ['encryptionMeta', 'offerings', 'privateContent', 'sadhana', 'seasonalVows', 'sessions', 'vowLogs'], 'raw dump covers all seven stores');
      assert.ok(originalRaw.sessions.length > 0 && originalRaw.offerings.length > 0 && originalRaw.sadhana.length > 0 && originalRaw.encryptionMeta.length === 1 && originalRaw.privateContent.length > 0);
      const backup3 = JSON.parse(readFileSync(backup3Path, 'utf8')) as { stores: Record<string, unknown[]> };
      assert.notEqual(JSON.stringify(backup3.stores.privateContent), JSON.stringify(originalApp.privateContent));
      await pageB.run(async () => { // after the (real) replace transaction commits, persist a stray row and alter a row, before the app verifies
        const { db } = await import('/src/lib/db.ts');
        const win = window as unknown as { __origTxC?: unknown; __rwCalls?: number; __afterWrite?: string };
        win.__origTxC = db.transaction; win.__rwCalls = 0; win.__afterWrite = '';
        const original = db.transaction as (...a: unknown[]) => Promise<unknown>;
        (db as unknown as { transaction: unknown }).transaction = function (this: unknown, ...args: unknown[]) {
          const promise = original.apply(this, args);
          if (args[0] === 'rw' && Array.isArray(args[1]) && args[1].length === 7) {
            win.__rwCalls = (win.__rwCalls ?? 0) + 1;
            if (win.__rwCalls === 1) {
              return promise.then(async (value) => {
                await original.call(db, 'rw', [db.sessions, db.privateContent], async () => {
                  const first = await db.sessions.toCollection().first();
                  if (first) await db.sessions.update(first.id as number, { minutes: 987654 });
                  await db.privateContent.put({ id: 'reflection:1999-01-01', kind: 'reflection', refId: '1999-01-01', stray: true } as never);
                });
                win.__afterWrite = JSON.stringify({ sessions: await db.sessions.toArray(), privateContent: await db.privateContent.toArray() });
                return value;
              });
            }
          }
          return promise;
        };
      });
      await pageB.setFile('input[type=file]', backup3Path); await pageB.waitText('Restore this backup?'); await pageB.click('Replace my data');
      await pageB.waitText('put back unchanged'); assert.equal(await pageB.ui('hasText', 'Backup restored and verified'), false, 'the restore reported failure');
      const mismatched = JSON.parse(await pageB.eval<string>('window.__afterWrite')) as { sessions: { minutes: number }[]; privateContent: { id: string }[] };
      assert.ok(mismatched.sessions.some((row) => row.minutes === 987654) && mismatched.privateContent.some((row) => row.id === 'reflection:1999-01-01'), 'the mismatch really was persisted before the rollback');
      const afterApp = await dump(pageB); const afterRaw = await rawDump(pageB);
      for (const name of ['sessions', 'offerings', 'sadhana', 'encryptionMeta', 'privateContent', 'seasonalVows', 'vowLogs'] as const) {
        assert.deepEqual(afterApp[name], originalApp[name], `${name}: identical through the app after rollback`);
        assert.deepEqual(afterRaw[name], originalRaw[name], `${name}: identical keys and values in raw IndexedDB after rollback`);
      }
      assert.equal(JSON.stringify(afterRaw), JSON.stringify(originalRaw), 'no restored, stray or altered row remains anywhere');
      assert.equal(afterRaw.privateContent.some((row) => row.key === 'reflection:1999-01-01'), false);
      await pageB.run(async () => { const { db } = await import('/src/lib/db.ts'); (db as unknown as { transaction: unknown }).transaction = (window as unknown as { __origTxC: unknown }).__origTxC; });
      await nav(pageB, 'Sādhana'); await pageB.waitText('Your diary is locked'); assert.equal(await textareaValue(pageB), null);
      noSecret(await dump(pageB), 'TESTSECRET');
    });
    console.log('\nProfile A: emulated narrow screen and timing');
    const shotDir = join(tmpdir(), 'sadhana-mobile-shots'); mkdirSync(shotDir, { recursive: true });
    const fits = async (label: string) => {
      const report = await page.eval<{ doc: number; win: number; wide: string[] }>(`(() => { const win = window.innerWidth; const wide = [...document.querySelectorAll('main *')].filter((element) => element.getBoundingClientRect().right > win + 1).slice(0, 5).map((element) => element.tagName + ':' + (element.textContent || '').slice(0, 30)); return { doc: document.documentElement.scrollWidth, win, wide }; })()`);
      writeFileSync(join(shotDir, `${label}.png`), Buffer.from(await page.screenshot(), 'base64'));
      assert.ok(report.doc <= report.win + 1 && report.wide.length === 0, `${label}: horizontal overflow ${JSON.stringify(report)}`);
    };
    await step('22. diary screens fit a 390px-wide phone viewport (EMULATED in desktop Chrome, not a physical device)', async () => {
      await page.emulateMobile(390, 844); await reloadAndWait(page); await openSettings(page); await fits('settings-locked');
      await page.click('Forgot your passphrase'); await fits('recovery-form'); await page.click('Cancel', true);
      await page.fill('Diary passphrase', P1); await page.click('Unlock diary'); await page.waitText('Unlocked', 60_000); await fits('settings-unlocked');
      await page.click('New recovery key'); await page.fill('Current passphrase', P1); await page.click('Create new key'); await page.waitText('Save this key'); await fits('new-recovery-key'); await page.click('Cancel', true);
      await nav(page, 'Sādhana'); await failTransactions(page, 'always'); await page.ui('fillSelector', TEXTAREA, 'TESTSECRET-mobile-draft'); await page.waitText('Not saved yet'); await fits('sadhana-unsaved-draft');
      await nav(page, 'Today'); await page.waitText('Private diary text is not saved yet'); await fits('unsaved-warning-today');
      await restoreTransactions(page); await page.click('Retry saving'); await page.waitGone('Private diary text is not saved yet');
      await openSettings(page); await page.click('Delete all local records'); await page.click('Delete', true); await page.waitText('All local records were deleted');
      await page.click('Set up private diary'); await fits('wizard-intro'); await page.click('I agree, continue'); await fits('wizard-backup');
      await page.click('Create and download backup'); await page.waitText('Backup created and checked'); await page.ui('check', 'I saved the backup file'); await page.click('Continue', true);
      await page.fill('Passphrase', P1); await page.fill('Repeat passphrase', P1); await fits('wizard-passphrase'); await page.click('Continue', true);
      await page.waitText('Step 3'); await fits('wizard-recovery-key'); await page.ui('check', 'I have saved this recovery key'); await page.click('Continue', true); await fits('wizard-verify'); await page.click('Back', true);
      await page.click('Cancel', true);
    });

    await step('23. key-derivation time measured here (desktop headless Chrome; says nothing about phones)', async () => {
      const times = await page.run<number[]>(async () => {
        const crypto = await import('/src/lib/diaryCrypto.ts'); const key = await crypto.generateDek(); const kdf = crypto.newKdfParams(); const out: number[] = [];
        for (let index = 0; index < 3; index += 1) { const started = performance.now(); await crypto.wrapDekWithPassphrase(key, 'timing test passphrase', kdf); out.push(Math.round(performance.now() - started)); }
        return out;
      });
      console.log(`        PBKDF2 ${600_000} iterations, 3 runs on this desktop: ${times.join(', ')} ms`);
      assert.ok(times.every((time) => time > 0 && time < 30_000));
    });

    console.log('\nProfile A: Seasonal Saṅkalpa screens (real UI, real IndexedDB, emulated 390px viewport)');
    const inCard = (name: string, label: string) => page.eval<boolean>(`(() => { const heading = [...document.querySelectorAll('article h3')].find((h) => (h.textContent || '').trim() === ${JSON.stringify(name)}); const article = heading && heading.closest('article'); const button = [...(article ? article.querySelectorAll('button') : [])].find((b) => (b.textContent || '').trim().includes(${JSON.stringify(label)}) && !b.disabled); if (!button) throw new Error('card button not found: ' + ${JSON.stringify(label)} + ' on ' + ${JSON.stringify(name)}); button.click(); return true; })()`);
    const cardText = (name: string) => page.eval<string>(`(() => { const heading = [...document.querySelectorAll('article h3')].find((h) => (h.textContent || '').trim() === ${JSON.stringify(name)}); return heading && heading.closest('article') ? heading.closest('article').innerText : ''; })()`);
    const dialogClick = (label: string) => page.eval<boolean>(`(() => { const button = [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => (b.textContent || '').trim() === ${JSON.stringify(label)}); if (!button) throw new Error('dialog button not found: ' + ${JSON.stringify(label)}); button.click(); return true; })()`);
    const explanation = () => page.ui<string>('textOf', '[data-testid="target-explanation"]');
    const pickDay = async (date: string) => { await page.ui('fillSelector', 'input[aria-label="Choose day"]', date); await sleep(250); };
    const activeId = (selector: string) => page.eval<string>(`document.activeElement ? document.activeElement.id : ''`).then((id) => ({ selector, id }));

    await step('24. Today links to the screen; the overview shows seeded commitments and resolves the target for the SELECTED day', async () => {
      await seedPlain(page); await reloadAndWait(page);
      await nav(page, 'Today'); await page.waitButton('Seasonal Saṅkalpa'); await page.click('Seasonal Saṅkalpa'); // (labels are upper-cased by CSS, so match the button text, not innerText)
      await page.waitText('Add a commitment'); await page.waitText('SEED extra japa'); await page.waitText('SEED evening lamp');
      assert.equal(await page.ui('exists', 'nav'), true, 'bottom navigation is still there, and has no extra tab');
      assert.equal(await page.eval<number>('document.querySelectorAll("nav button").length'), 5);
      assert.match(await explanation(), /Seasonal target from “SEED extra japa”.*4 rounds above your regular target/, 'today: the seasonal target applies');
      assert.equal(await page.ui('hasText', '20 rounds'), true); assert.equal(await page.ui('hasText', '16 rounds'), true);
      await pickDay(DATES[1]); assert.match(await explanation(), /target that day was recorded with/, 'a recorded past day reports its own snapshot');
      await pickDay(localDate(30)); assert.equal(await explanation(), 'No seasonal Japa target applies on this day.', 'after the season: regular target, nothing assumed');
      assert.equal(await page.ui('hasText', 'is outside this commitment’s dates'), true);
      await pickDay(localDate(-10)); assert.equal(await explanation(), 'No seasonal Japa target applies on this day.', 'before the season starts');
      await pickDay(DATES[0]); assert.equal(await page.ui('hasText', 'TESTSECRET'), false, 'private reflection text never appears on this screen');
      await fits('sankalpa-overview');
      assert.deepEqual((await dump(page)).sadhana.map((row) => row.targetRounds), [16, 16, 16], 'viewing never changes the regular target');
    });

    await step('25. the form: inline validation with focus on the first problem, then creating, activating and the conflict error', async () => {
      await page.click('Add a commitment'); await page.waitText('New seasonal commitment');
      await page.click('Save as draft');
      for (const text of ['Give this season a name.', 'Give this commitment a name.', 'Enter the start date.', 'Enter the end date.', 'Enter a whole number from 1 to 64.']) await page.waitText(text);
      assert.equal((await activeId('')).id, 'vow-seasonName', 'focus moves to the first field that needs attention');
      assert.equal(await page.eval<string>('document.getElementById("vow-seasonName").getAttribute("aria-invalid")'), 'true');
      await page.ui('fillSelector', '#vow-seasonName', 'TEST season'); await page.ui('fillSelector', '#vow-name', 'Test study');
      await page.ui('fillSelector', '#vow-startDate', localDate(5)); await page.ui('fillSelector', '#vow-endDate', localDate(1));
      await page.ui('fillSelector', '#vow-type', 'study'); await sleep(200);
      await page.click('Save as draft'); await page.waitText('The end date cannot be before the start date.'); await page.waitText('Enter whole minutes from 1 to 1440.');
      assert.equal(await page.ui('hasText', 'Enter a whole number from 1 to 64.'), false, 'fields of another type are not validated');
      await page.ui('fillSelector', '#vow-startDate', localDate(-1)); await page.ui('fillSelector', '#vow-endDate', localDate(10));
      await page.ui('fillSelector', '#vow-minutesPerDay', '30'); await page.ui('fillSelector', '#vow-scripture', 'Test scripture'); await fits('sankalpa-form');
      await page.click('Save and activate'); await page.waitText('Commitment saved and activated.'); await page.waitText('Test study');
      assert.match(await cardText('Test study'), /30 minutes a day · Test scripture/);
      const created = (await dump(page)).seasonalVows.find((vow) => vow.name === 'Test study')!;
      assert.deepEqual([created.type, created.status, created.config], ['study', 'active', { minutesPerDay: 30, scripture: 'Test scripture' }]);
      // A Japa commitment that overlaps the active one with a different target: clear error, saved only as a draft.
      await page.click('Add a commitment'); await page.ui('fillSelector', '#vow-seasonName', 'TEST season'); await page.ui('fillSelector', '#vow-name', 'Conflicting japa');
      await page.ui('fillSelector', '#vow-startDate', localDate(0)); await page.ui('fillSelector', '#vow-endDate', localDate(5)); await page.ui('fillSelector', '#vow-targetRounds', '22');
      assert.equal(await page.ui('hasText', 'That is 6 rounds above your regular target.'), true, 'the form shows the difference from the regular target while typing');
      assert.equal(await page.eval<string>('document.getElementById("vow-morningCutoff").value'), '07:00', 'cutoff defaults to 7:00 AM');
      await page.click('Save and activate'); await page.waitText('could not be activated'); await page.waitText('Only one seasonal Japa target can apply on a day');
      const data = await dump(page); assert.equal(data.seasonalVows.find((vow) => vow.name === 'Conflicting japa')!.status, 'draft');
      assert.equal(await page.ui('hasText', 'Drafts'), true);
      assert.match(await explanation(), /Seasonal target from “SEED extra japa”/, 'the existing target still applies; the conflicting one was not silently chosen');
      await fits('sankalpa-conflict');
    });

    await step('26. daily logging, pause, resume, complete, archive, edit and confirmed deletion, all through the UI', async () => {
      const lamp = (await dump(page)).seasonalVows.find((vow) => vow.name === 'SEED evening lamp')!;
      await inCard('SEED evening lamp', 'Done'); await page.waitText('Recorded for');
      let logs = (await dump(page)).vowLogs.filter((log) => log.vowId === lamp.id && log.date === DATES[0]); assert.deepEqual(logs.map((log) => log.completed), [true]);
      await inCard('SEED evening lamp', 'Not today'); await sleep(500);
      logs = (await dump(page)).vowLogs.filter((log) => log.vowId === lamp.id && log.date === DATES[0]); assert.deepEqual(logs.map((log) => log.completed), [false], 'changing the answer updates the same row');
      assert.match(await cardText('SEED evening lamp'), /days? with recorded activity so far/);
      assert.doesNotMatch(await cardText('SEED evening lamp'), /streak/i);
      await pickDay(localDate(1)); assert.match(await cardText('SEED evening lamp'), /Future days cannot be logged yet/); await pickDay(DATES[0]);
      // pause / resume
      await inCard('SEED evening lamp', 'Pause'); await page.waitText('Paused. Your history is kept.');
      assert.match(await cardText('SEED evening lamp'), /nothing is recorded/); assert.equal((await dump(page)).seasonalVows.find((vow) => vow.id === lamp.id)!.status, 'paused');
      await inCard('SEED evening lamp', 'Resume'); await page.waitText('Resumed.');
      // pausing the Japa commitment must not touch closed-day history
      const before = (await dump(page)).sadhana.filter((row) => row.date !== DATES[0]).map((row) => ({ date: row.date, snapshot: row.targetSnapshot }));
      await inCard('SEED extra japa', 'Pause'); await page.waitText('Paused. Your history is kept.');
      assert.equal(await explanation(), 'No seasonal Japa target applies on this day.', 'while paused the regular target applies');
      await pickDay(DATES[1]); assert.match(await explanation(), /Seasonal target from “SEED extra japa”.*recorded with/, 'a closed day keeps the target it was recorded with');
      assert.deepEqual((await dump(page)).sadhana.filter((row) => row.date !== DATES[0]).map((row) => ({ date: row.date, snapshot: row.targetSnapshot })), before); await pickDay(DATES[0]);
      await inCard('SEED extra japa', 'Resume'); await page.waitText('Resumed.');
      // edit
      await inCard('Test study', 'Edit'); await page.waitText('Edit commitment');
      assert.equal(await page.ui<string>('valueOf', '#vow-name'), 'Test study'); assert.equal(await page.ui<string>('valueOf', '#vow-minutesPerDay'), '30');
      assert.equal(await page.eval<boolean>('document.getElementById("vow-type").disabled'), true, 'the type cannot change');
      await page.ui('fillSelector', '#vow-minutesPerDay', '45'); await page.click('Save changes'); await page.waitText('Changes saved.'); await page.waitText('45 minutes a day');
      // complete (confirmation, cancel first)
      await inCard('Test study', 'Complete'); await page.waitText('Complete this commitment?'); await page.click('Cancel', true); await page.waitGone('Complete this commitment?');
      assert.equal((await dump(page)).seasonalVows.find((vow) => vow.name === 'Test study')!.status, 'active');
      await inCard('Test study', 'Complete'); await dialogClick('Complete'); await page.waitText('Completed. Your history is kept.');
      const done = (await dump(page)).seasonalVows.find((vow) => vow.name === 'Test study')!; assert.deepEqual([done.status, done.endedOn], ['completed', DATES[0]]);
      await page.waitText('History (1)'); await page.eval('document.querySelector("details").open = true'); await page.waitText('Test study');
      assert.equal(await page.eval<boolean>('![...document.querySelectorAll("article h3")].find((h) => h.textContent.trim() === "Test study").closest("article").innerText.includes("Edit")'), true, 'completed commitments are read-only');
      // archive
      await inCard('Test study', 'Archive'); await page.waitText('Archive this commitment?'); await dialogClick('Archive'); await page.waitText('Archived. Your history is kept.');
      assert.equal((await dump(page)).seasonalVows.find((vow) => vow.name === 'Test study')!.status, 'archived');
      // permanent deletion: needs confirmation; cancel keeps everything; confirm removes the commitment and its logs only
      const lampBefore = (await dump(page)).vowLogs.filter((log) => log.vowId === lamp.id).length; assert.ok(lampBefore >= 1);
      await inCard('SEED evening lamp', 'Delete'); await page.waitText('Delete this commitment?'); await page.waitText('cannot be undone');
      await page.click('Cancel', true); await page.waitGone('Delete this commitment?');
      assert.equal((await dump(page)).vowLogs.filter((log) => log.vowId === lamp.id).length, lampBefore, 'cancel deleted nothing');
      await inCard('SEED evening lamp', 'Delete'); await page.click('Delete permanently'); await page.waitText('and its daily records were deleted');
      const after = await dump(page);
      assert.equal(after.seasonalVows.some((vow) => vow.id === lamp.id), false); assert.equal(after.vowLogs.some((log) => log.vowId === lamp.id), false);
      assert.ok(after.seasonalVows.some((vow) => vow.name === 'SEED extra japa') && after.sadhana.length === 3, 'nothing else was touched');
      assert.ok(after.sadhana.every((row) => row.targetRounds === 16), 'the regular target is still 16 everywhere');
      assert.equal(await page.ui('hasText', 'TESTSECRET'), false);
      await fits('sankalpa-after-actions');
    });

    await step('27. Back to Today works, the new route is not a navigation tab, and loading/empty states read honestly', async () => {
      await page.click('Back to Today'); await page.waitButton('Seasonal Saṅkalpa'); assert.equal(await page.eval<number>('document.querySelectorAll("nav button").length'), 5);
      await page.run(async () => { const { db } = await import('/src/lib/db.ts'); await db.vowLogs.clear(); await db.seasonalVows.clear(); });
      await page.click('Seasonal Saṅkalpa'); await page.waitText('No seasonal commitments yet'); assert.equal(await explanation(), 'No seasonal Japa target applies on this day.');
      assert.equal(await page.ui('hasText', 'Kārtika'), false, 'no season or festival is ever assumed');
      await fits('sankalpa-empty');
    });

    console.log('\nProfile A: Sādhana screen uses the effective Japa target and cutoff');
    const noteText = () => page.ui<string | null>('textOf', '[data-testid="sadhana-target-note"]');
    const prevDay = async () => { await page.ui('clickSelector', 'button[aria-label^="Previous day"]'); await sleep(450); };
    const nextDay = async () => { await page.ui('clickSelector', 'button[aria-label^="Next day"]'); await sleep(450); };
    const targetTotal = () => page.eval<string>(`(() => { const hit = [...document.querySelectorAll('span')].find((el) => /^\\/ \\d+ total$/.test((el.textContent || '').trim())); return hit ? hit.textContent.trim() : ''; })()`);
    const earlyLabel = () => page.eval<string>(`(() => { const input = document.querySelector('input[aria-label^="Rounds completed before"]'); return input ? input.getAttribute('aria-label') : ''; })()`);
    const japaVowId = () => page.run<string>(async () => { const seasonal = await import('/src/lib/seasonalService.ts'); return (await seasonal.listVows()).find((vow) => vow.type === 'japa')!.id; });

    await step('28. Sādhana shows the effective target with an explanation, the regular target separately, and the configured cutoff; the regular target is never rewritten', async () => {
      await page.run(async (start: string, end: string) => {
        const seasonal = await import('/src/lib/seasonalService.ts');
        const vow = await seasonal.createSeasonalVow({ type: 'japa', seasonName: 'TEST season', name: 'Cutoff japa', startDate: start, endDate: end, config: { targetRounds: 20, morningCutoff: '06:30' } });
        await seasonal.changeVowStatus(vow.id, 'activate');
      }, DATES[2], localDate(20));
      await reloadAndWait(page); await nav(page, 'Sādhana'); await page.waitFor(async () => (await noteText()) !== null, 'the seasonal note');
      const note = String(await noteText());
      assert.match(note, /Today’s target of 20 rounds is for your current Saṅkalpa, “Cutoff japa”\./);
      assert.match(note, /Early rounds are counted before 6:30 AM\./); assert.match(note, /Your regular target of 16 rounds is unchanged\./);
      assert.equal(await page.ui('hasText', 'Regular target'), true);
      assert.equal(await targetTotal(), '/ 20 total'); assert.equal(await earlyLabel(), 'Rounds completed before 6:30 AM'); assert.equal(await page.ui('hasText', 'before 6:30 AM'), true);
      assert.equal(await page.eval<string>('document.querySelector("label input[max=\\"64\\"]").value'), '16', 'the editable target is the regular one');
      const before = (await dump(page)).sadhana.find((row) => row.date === DATES[0])!;
      await page.click('Add one round', true); await sleep(600);
      const row = (await dump(page)).sadhana.find((entry) => entry.date === DATES[0])!;
      assert.equal(row.rounds, before.rounds + 1); assert.equal(row.targetRounds, 16, 'targetRounds still holds the regular target'); assert.deepEqual([row.targetSnapshot?.rounds, row.targetSnapshot?.source], [20, 'seasonal']);
      await page.ui('fillSelector', 'input[aria-label^="Rounds completed before"]', '99'); await sleep(500);
      const clamped = (await dump(page)).sadhana.find((entry) => entry.date === DATES[0])!;
      assert.equal(await page.ui<string>('valueOf', 'input[aria-label^="Rounds completed before"]'), String(clamped.rounds), 'early rounds are still capped at the total rounds');
      // A recorded past day: the target AND the cutoff it was recorded with. This seed commitment sets no cutoff, so the stored one is the 7:00 AM default and no apology is needed
      // (the older-record note is covered by step 15b and the unit tests).
      await prevDay(); assert.match(String(await noteText()), /This day’s target of 20 rounds is for the Saṅkalpa, “[^”]+”\./);
      assert.equal(await targetTotal(), '/ 20 total'); assert.equal(await earlyLabel(), 'Rounds completed before 7:00 AM');
      assert.equal(await page.ui('exists', '[data-testid="sadhana-cutoff-note"]'), false); assert.equal(await page.ui('hasText', 'was not saved with the day'), false);
      assert.match(String(await noteText()), /Early rounds are counted before 7:00 AM\./);
      // A day before the commitment began: regular everything.
      await prevDay(); await prevDay(); assert.equal(await noteText(), null); assert.equal(await targetTotal(), '/ 16 total'); assert.equal(await earlyLabel(), 'Rounds completed before 7:00 AM');
      assert.equal(await page.ui('exists', '[data-testid="sadhana-cutoff-note"]'), false); assert.equal(await page.ui('hasText', 'Regular target'), false, 'plain "Target" when no season applies');
      assert.equal((await dump(page)).sadhana.length, 3, 'merely looking at a day saves nothing');
      await fits('sadhana-seasonal-target');
    });

    await step('29. pausing, resuming and editing the commitment update today live, and never touch a closed day', async () => {
      await reloadAndWait(page); await nav(page, 'Sādhana'); await page.waitFor(async () => (await noteText()) !== null, 'the seasonal note');
      const closedBefore = JSON.stringify((await dump(page)).sadhana.filter((row) => row.date !== DATES[0]).map((row) => [row.date, row.targetRounds, row.targetSnapshot]));
      const id = await japaVowId();
      await page.run(async (vowId: string) => { const seasonal = await import('/src/lib/seasonalService.ts'); await seasonal.changeVowStatus(vowId, 'pause'); }, id);
      await page.waitFor(async () => (await noteText()) === null, 'the note disappears when the commitment is paused (live update)');
      assert.equal(await targetTotal(), '/ 16 total'); assert.equal(await earlyLabel(), 'Rounds completed before 7:00 AM'); assert.equal(await page.ui('hasText', 'Regular target'), false);
      await prevDay(); assert.equal(await targetTotal(), '/ 20 total', 'yesterday keeps the target it was recorded with while the commitment is paused'); await nextDay();
      await page.run(async (vowId: string) => { const seasonal = await import('/src/lib/seasonalService.ts'); await seasonal.changeVowStatus(vowId, 'resume'); await seasonal.editSeasonalVow(vowId, { config: { targetRounds: 30, morningCutoff: '05:15' } }); }, id);
      await page.waitFor(async () => (await targetTotal()) === '/ 30 total', 'today follows the edit');
      assert.equal(await earlyLabel(), 'Rounds completed before 5:15 AM'); assert.match(String(await noteText()), /target of 30 rounds.*before 5:15 AM/);
      await prevDay(); assert.equal(await targetTotal(), '/ 20 total', 'yesterday is unchanged by the edit'); assert.equal(await earlyLabel(), 'Rounds completed before 7:00 AM'); await nextDay();
      await page.click('Add one round', true); await sleep(600);
      const data = await dump(page); const today = data.sadhana.find((row) => row.date === DATES[0])!;
      assert.deepEqual([today.targetRounds, today.targetSnapshot?.rounds, today.targetSnapshot?.source], [16, 30, 'seasonal'], 'today’s open-day snapshot follows the live rule; the regular target stays 16');
      assert.equal(JSON.stringify(data.sadhana.filter((row) => row.date !== DATES[0]).map((row) => [row.date, row.targetRounds, row.targetSnapshot])), closedBefore, 'closed days are byte-for-byte unchanged');
    });

    await step('30. conflicting active Japa commitments: clear explanation, regular target, no cutoff chosen, nothing rewritten', async () => {
      const conflictId = await page.run<string>(async (start: string, end: string) => {
        const { db } = await import('/src/lib/db.ts'); const id = 'vow-test-conflict'; const now = new Date().toISOString();
        await db.seasonalVows.add({ id, type: 'japa', seasonName: 'TEST season', name: 'Imported conflict', startDate: start, endDate: end, status: 'active', config: { targetRounds: 24, morningCutoff: '05:00' }, configVersion: 1, createdAt: now, updatedAt: now });
        return id;
      }, localDate(-1), localDate(5));
      const rowBefore = JSON.stringify((await dump(page)).sadhana.find((row) => row.date === DATES[0]));
      await page.waitFor(async () => await page.ui<boolean>('exists', '[data-testid="sadhana-target-conflict"]'), 'the conflict explanation');
      const alert = await page.ui<string>('textOf', '[data-testid="sadhana-target-conflict"]');
      assert.match(alert, /different targets \((24 and 30|30 and 24) rounds\)/); assert.match(alert, /regular target of 16 rounds is used/);
      assert.equal(await noteText(), null, 'neither commitment is presented as the target'); assert.equal(await targetTotal(), '/ 16 total');
      assert.equal(await earlyLabel(), 'Rounds completed before 7:00 AM'); assert.equal(await page.ui('hasText', 'Regular target'), true);
      assert.equal(JSON.stringify((await dump(page)).sadhana.find((row) => row.date === DATES[0])), rowBefore, 'showing a conflict rewrites nothing');
      await fits('sadhana-seasonal-conflict');
      await page.run(async (id: string) => { const { db } = await import('/src/lib/db.ts'); await db.seasonalVows.delete(id); }, conflictId);
      await page.waitFor(async () => !(await page.ui<boolean>('exists', '[data-testid="sadhana-target-conflict"]')), 'the conflict clears once it is gone');
      assert.equal(await targetTotal(), '/ 30 total');
      await page.run(async () => { const { db } = await import('/src/lib/db.ts'); await db.vowLogs.clear(); await db.seasonalVows.clear(); });
      await page.waitFor(async () => (await targetTotal()) === '/ 16 total', 'back to the regular target when every commitment is gone');
    });

    await step('30b. an UNRECORDED past day shows the live target and cutoff with no "not saved" note, nothing flips when it is saved, and a later edit cannot change it', async () => {
      const past = localDate(-5);
      const id = await page.run<string>(async (start: string, end: string) => {
        const seasonal = await import('/src/lib/seasonalService.ts');
        const vow = await seasonal.createSeasonalVow({ type: 'japa', seasonName: 'TEST season', name: 'Late cutoff japa', startDate: start, endDate: end, config: { targetRounds: 21, morningCutoff: '05:45' } });
        await seasonal.changeVowStatus(vow.id, 'activate');
        return vow.id;
      }, localDate(-8), localDate(20));
      await reloadAndWait(page); await nav(page, 'Sādhana');
      await page.ui('fillSelector', 'input[aria-label="Choose date"]', past); await sleep(500);
      await page.waitFor(async () => (await noteText()) !== null, 'the seasonal note on the unrecorded past day');
      const expectLive = async (when: string) => {
        assert.match(String(await noteText()), /This day’s target of 21 rounds is for the Saṅkalpa, “Late cutoff japa”\./, `${when}: target note`);
        assert.match(String(await noteText()), /Early rounds are counted before 5:45 AM\./, `${when}: cutoff in the note`);
        assert.equal(await targetTotal(), '/ 21 total', `${when}: target`); assert.equal(await earlyLabel(), 'Rounds completed before 5:45 AM', `${when}: early-rounds label`);
        assert.equal(await page.ui('exists', '[data-testid="sadhana-cutoff-note"]'), false, `${when}: no apology note`); assert.equal(await page.ui('hasText', 'was not saved with the day'), false, `${when}: no apology text`);
      };
      await expectLive('before saving');
      assert.equal((await dump(page)).sadhana.some((row) => row.date === past), false, 'merely looking at the unrecorded day saved nothing');
      await page.click('Add one round', true); await sleep(800);
      const row = (await dump(page)).sadhana.find((entry) => entry.date === past)!;
      assert.deepEqual([row.targetRounds, row.targetSnapshot?.rounds, row.targetSnapshot?.source, row.targetSnapshot?.morningCutoff], [16, 21, 'seasonal', '05:45'], 'saving stored the target AND the cutoff that were displayed; the regular target stays 16');
      await expectLive('right after saving (no flip)');
      // The day is now recorded and closed: editing the commitment must not change what it shows or what is stored.
      await page.run(async (vowId: string) => { const seasonal = await import('/src/lib/seasonalService.ts'); await seasonal.editSeasonalVow(vowId, { config: { targetRounds: 30, morningCutoff: '04:30' } }); }, id);
      await sleep(700); await expectLive('after the commitment was edited');
      const after = (await dump(page)).sadhana.find((entry) => entry.date === past)!;
      assert.deepEqual(after.targetSnapshot, row.targetSnapshot, 'the stored snapshot is unchanged by the edit');
      await page.run(async () => { const { db } = await import('/src/lib/db.ts'); await db.vowLogs.clear(); await db.seasonalVows.clear(); });
    });

    console.log('\nProfile A: Today dashboard uses the effective Japa target and cutoff');
    // Today only ever shows the current day (it has no date picker), so recorded and unrecorded PAST days cannot appear here; those cases
    // are covered by the shared helper's unit tests and by the Sādhana-screen steps above (15b, 28-30b).
    const japaCard = () => page.eval<string>(`(() => { const h = [...document.querySelectorAll('h2')].find((el) => (el.textContent || '').trim() === 'Japa Meditation'); const section = h && h.closest('section'); return section ? section.innerText : ''; })()`);
    const todayNote = () => page.ui<string | null>('textOf', '[data-testid="today-target-note"]');
    const sadhanaRowsJson = async () => JSON.stringify((await dump(page)).sadhana);
    const makeJapa = (name: string, rounds: number, cutoff: string) => page.run<string>(async (title: string, target: number, time: string, start: string, end: string) => {
      const seasonal = await import('/src/lib/seasonalService.ts');
      const vow = await seasonal.createSeasonalVow({ type: 'japa', seasonName: 'TEST season', name: title, startDate: start, endDate: end, config: { targetRounds: target, morningCutoff: time } });
      await seasonal.changeVowStatus(vow.id, 'activate');
      return vow.id;
    }, name, rounds, cutoff, DATES[2], localDate(20));

    await step('31. Today without a seasonal commitment shows the plain regular target and the 7:00 AM cutoff', async () => {
      await reloadAndWait(page); await nav(page, 'Today');
      const todayRow = (await dump(page)).sadhana.find((row) => row.date === DATES[0])!; assert.ok(todayRow.rounds > 0, 'today has recorded rounds for this check');
      await page.waitFor(async () => (await japaCard()).includes('Target 16 rounds'), 'the regular target badge');
      const card = await japaCard();
      assert.match(card, /of 16 rounds/); assert.match(card, new RegExp(`${Math.min(todayRow.earlyRounds, todayRow.rounds)} rounds before 7:00 AM`));
      assert.equal(await todayNote(), null); assert.equal(await page.ui('exists', '[data-testid="today-target-conflict"]'), false); assert.doesNotMatch(card, /Saṅkalpa/);
      assert.deepEqual((await dump(page)).sadhana.map((row) => row.targetRounds), [16, 16, 16, 16], 'regular targets are untouched');
    });

    await step('32. an applicable commitment: Saṅkalpa target and cutoff shown, regular target kept distinct; pause, resume and completion update it live', async () => {
      await nav(page, 'Today'); const rowsBefore = await sadhanaRowsJson();
      const id = await makeJapa('Today japa', 25, '06:15');
      await page.waitFor(async () => (await todayNote()) !== null, 'the Saṅkalpa note appears without a reload');
      const card = await japaCard();
      assert.match(card, /Saṅkalpa target 25 rounds/); assert.match(card, /of 25 rounds/); assert.match(card, /rounds before 6:15 AM/); assert.doesNotMatch(card, /before 7:00 AM/);
      assert.equal(await todayNote(), 'Set by your Saṅkalpa, “Today japa”. Your regular target of 16 rounds is unchanged.');
      assert.equal(await sadhanaRowsJson(), rowsBefore, 'viewing Today changes no Sādhana record, and writes no seasonal target anywhere');
      assert.ok((await dump(page)).sadhana.every((row) => row.targetRounds === 16));
      await fits('today-seasonal');
      await page.run(async (vowId: string) => { const seasonal = await import('/src/lib/seasonalService.ts'); await seasonal.changeVowStatus(vowId, 'pause'); }, id);
      await page.waitFor(async () => (await todayNote()) === null, 'pausing removes the note live');
      let paused = await japaCard(); assert.match(paused, /Target 16 rounds/); assert.match(paused, /before 7:00 AM/); assert.doesNotMatch(paused, /Saṅkalpa/);
      await page.run(async (vowId: string) => { const seasonal = await import('/src/lib/seasonalService.ts'); await seasonal.changeVowStatus(vowId, 'resume'); }, id);
      await page.waitFor(async () => (await todayNote()) !== null, 'resuming brings it back');
      await page.run(async (vowId: string) => { const seasonal = await import('/src/lib/seasonalService.ts'); await seasonal.changeVowStatus(vowId, 'complete'); }, id);
      await page.waitFor(async () => (await todayNote()) === null, 'completing removes it');
      paused = await japaCard(); assert.match(paused, /Target 16 rounds/); assert.match(paused, /before 7:00 AM/);
      assert.equal(await sadhanaRowsJson(), rowsBefore, 'pause, resume and completion rewrote no recorded day');
      await page.run(async () => { const { db } = await import('/src/lib/db.ts'); await db.vowLogs.clear(); await db.seasonalVows.clear(); });
    });

    await step('33. conflicting active Japa commitments: a clear message, the regular target, no commitment chosen', async () => {
      await nav(page, 'Today'); await makeJapa('First japa', 25, '06:15');
      await page.run(async (start: string, end: string) => {
        const { db } = await import('/src/lib/db.ts'); const now = new Date().toISOString();
        await db.seasonalVows.add({ id: 'vow-today-conflict', type: 'japa', seasonName: 'TEST season', name: 'Second japa', startDate: start, endDate: end, status: 'active', config: { targetRounds: 24, morningCutoff: '05:00' }, configVersion: 1, createdAt: now, updatedAt: now });
      }, DATES[2], localDate(20));
      await page.waitFor(async () => await page.ui<boolean>('exists', '[data-testid="today-target-conflict"]'), 'the conflict message');
      const alert = await page.ui<string>('textOf', '[data-testid="today-target-conflict"]'); const card = await japaCard();
      assert.match(alert, /different targets \((25 and 24|24 and 25) rounds\)/); assert.match(alert, /regular target of 16 rounds is used/); assert.doesNotMatch(alert, /First japa|Second japa/);
      assert.equal(await todayNote(), null); assert.match(card, /Target 16 rounds/); assert.match(card, /before 7:00 AM/); assert.doesNotMatch(card, /Saṅkalpa target/);
      await page.run(async () => { const { db } = await import('/src/lib/db.ts'); await db.seasonalVows.delete('vow-today-conflict'); });
      await page.waitFor(async () => !(await page.ui<boolean>('exists', '[data-testid="today-target-conflict"]')) && (await todayNote()) !== null, 'the conflict clears and the remaining commitment applies');
      assert.match(await japaCard(), /Saṅkalpa target 25 rounds/);
      await page.run(async () => { const { db } = await import('/src/lib/db.ts'); await db.vowLogs.clear(); await db.seasonalVows.clear(); });
    });

    await step('34. the rest of Today is unchanged, private text never appears, and nothing seasonal was written', async () => {
      await makeJapa('Boundary japa', 25, '06:15'); await nav(page, 'Today'); await page.waitFor(async () => (await todayNote()) !== null, 'applicable commitment');
      const text = await page.ui<string>('text');
      assert.doesNotMatch(text, /TESTSECRET/, 'no reflection text on Today'); assert.doesNotMatch(text, /Daily reflection|reflection/i);
      assert.match(text, /5 of 5 core fields recorded today\./); assert.match(text, /SEED Srimad-Bhagavatam study/); assert.match(text, /1 offering today · 30 min/);
      assert.match(text, /This week · 30 min \/ 2h 00m/); assert.match(text, /Wake-up/i); assert.match(text, /4:15 AM/); assert.match(text, /Maṅgala Ārati/);
      const data = await dump(page);
      assert.ok(data.sadhana.every((row) => row.targetRounds === 16), 'the regular target is still 16 on every day');
      assert.equal(data.encryptionMeta.length, 0, 'the diary is off in this scenario, and Today still shows no private text');
      await fits('today-seasonal-boundaries');
      await page.run(async () => { const { db } = await import('/src/lib/db.ts'); await db.vowLogs.clear(); await db.seasonalVows.clear(); });
    });

    console.log('\nProfile A: Insights uses each day’s own Japa target and cutoff');
    // Not applicable to Insights: an UNRECORDED past day. Insights only counts days with rounds recorded, so such a day has no value to compare
    // against a target and no early-round count to label; missing days stay missing. Its live-cutoff rule is covered by the Sādhana steps and unit tests.
    const prevMonth = (day: number) => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(day)}`; };
    const insightsText = () => page.ui<string>('text');
    const row = (date: string, rounds: number, snapshot?: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ date, rounds, targetRounds: 16, earlyRounds: 4, sixteenthRoundTime: '', wakeUp: '', bedtime: '', sleepOnset: '', mangalaArati: 'Unrecorded', reflection: '', ...(snapshot ? { targetSnapshot: snapshot } : {}), ...extra });
    const seedInsights = (rows: Record<string, unknown>[], vows: { name: string; target: number; cutoff: string; start: string; end: string }[]) => page.run(async (data: Record<string, unknown>[], defs: { name: string; target: number; cutoff: string; start: string; end: string }[]) => {
      const { db } = await import('/src/lib/db.ts'); const seasonal = await import('/src/lib/seasonalService.ts');
      await db.sadhana.clear(); await db.vowLogs.clear(); await db.seasonalVows.clear();
      await db.sadhana.bulkAdd(data as never[]);
      for (const def of defs) { const vow = await seasonal.createSeasonalVow({ type: 'japa', seasonName: 'TEST season', name: def.name, startDate: def.start, endDate: def.end, config: { targetRounds: def.target, morningCutoff: def.cutoff } }); await seasonal.changeVowStatus(vow.id, 'activate'); }
    }, rows, vows);
    const openInsights = async (previousMonth: boolean) => {
      await reloadAndWait(page); await nav(page, 'Insights'); await page.waitText('ROUNDS CHANTED'); await page.click('Month', true);
      if (previousMonth) { await page.click('Previous month', true); await sleep(500); }
      await page.waitText('Chanting rounds'); await sleep(400);
    };
    const statCard = async (label: string) => { const text = await insightsText(); const at = text.indexOf(label); return at < 0 ? '' : text.slice(at, at + 160).replace(/\s+/g, ' '); };

    await step('35. historical days use their stored targets and cutoffs; a different live commitment, and any later edit, pause or deletion, change nothing', async () => {
      const closed = [row(prevMonth(10), 18, { rounds: 20, source: 'seasonal', vowId: 'old', vowName: 'Old', morningCutoff: '06:30' }, { reflection: 'TESTSECRET-insights-boundary' }),
        row(prevMonth(11), 22, { rounds: 20, source: 'seasonal', vowId: 'old', vowName: 'Old', morningCutoff: '06:30' }),
        row(prevMonth(12), 17, { rounds: 20, source: 'seasonal', vowId: 'old', vowName: 'Old' }), // saved before cutoffs were stored
        row(prevMonth(13), 16), // saved before snapshots existed
        row(prevMonth(14), 0, { rounds: 20, source: 'seasonal', vowId: 'old', vowName: 'Old', morningCutoff: '06:30' })]; // a saved zero: not a recorded day
      await seedInsights(closed, [{ name: 'Live distraction', target: 30, cutoff: '05:00', start: prevMonth(1), end: localDate(20) }]);
      await openInsights(true);
      const check = async (when: string) => {
        const text = await insightsText();
        assert.match(await statCard('TARGET REACHED'), /TARGET REACHED 2 of 4 recorded days · 3 against a Saṅkalpa target/, `${when}: 22 met its recorded 20 and 16 met 16; 18 did NOT meet its recorded 20 even though it beats the regular 16`);
        assert.match(await statCard('EARLY ROUNDS'), /EARLY ROUNDS 16 .*cutoff varies by day/, `${when}: days with different cutoffs get no single label`);
        assert.match(text, /target varies by day \(16–20\)/, `${when}: per-day targets`); assert.doesNotMatch(text, /\(16–30\)|BEFORE 5:00 AM|5:00 AM|\b30 rounds/, `${when}: the live commitment never leaks into history`);
        assert.equal(await page.ui<string>('textOf', '[data-testid="insights-cutoff-note"]'), '1 recorded day in this period used a seasonal commitment before its morning cutoff was saved, so 7:00 AM is used for it. Nothing is guessed.', `${when}: the explanatory note`);
        assert.match(await statCard('ROUNDS CHANTED'), /ROUNDS CHANTED 73 4 of \d+ days/, `${when}: the saved zero is not a day and nothing is estimated`);
        assert.doesNotMatch(text, /TESTSECRET/, `${when}: no private text`);
      };
      await check('with a different live commitment'); await fits('insights-historical');
      await page.run(async () => { const seasonal = await import('/src/lib/seasonalService.ts'); const vow = (await seasonal.listVows())[0]; await seasonal.editSeasonalVow(vow.id, { config: { targetRounds: 35, morningCutoff: '04:00' } }); });
      await sleep(700); await check('after the commitment was edited');
      await page.run(async () => { const seasonal = await import('/src/lib/seasonalService.ts'); const vow = (await seasonal.listVows())[0]; await seasonal.changeVowStatus(vow.id, 'pause'); await seasonal.changeVowStatus(vow.id, 'resume'); await seasonal.changeVowStatus(vow.id, 'complete'); await seasonal.changeVowStatus(vow.id, 'archive'); });
      await sleep(700); await check('after it was paused, resumed, completed and archived');
      await page.run(async () => { const { db } = await import('/src/lib/db.ts'); await db.seasonalVows.clear(); }); await sleep(700); await check('after it was deleted');
      assert.deepEqual((await dump(page)).sadhana.map((entry) => entry.targetRounds), [16, 16, 16, 16, 16], 'regular targets untouched');
    });

    await step('36. when every recorded day shares one seasonal target and cutoff, they are named plainly and no fallback note appears', async () => {
      const snap = { rounds: 20, source: 'seasonal', vowId: 'old', vowName: 'Old', morningCutoff: '06:30' };
      await seedInsights([row(prevMonth(10), 20, snap), row(prevMonth(11), 21, snap), row(prevMonth(12), 10, snap)], []);
      await openInsights(true);
      const text = await insightsText();
      assert.match(await statCard('TARGET REACHED'), /TARGET REACHED 2 of 3 recorded days · 3 against a Saṅkalpa target/);
      assert.match(await statCard('BEFORE 6:30 AM'), /BEFORE 6:30 AM 12 /); assert.match(text, /Rounds per day · target 20 \(Saṅkalpa\)/);
      assert.equal(await page.ui('exists', '[data-testid="insights-cutoff-note"]'), false); assert.match(text, /Each day is measured against the target it was recorded with; your regular target is never changed\./);
    });

    await step('37. today follows the live rule (and updates as the commitment changes); a conflict uses the regular target and says so', async () => {
      const todayRow = row(DATES[0], 25);
      await seedInsights([todayRow], [{ name: 'Live japa', target: 20, cutoff: '06:30', start: prevMonth(1), end: localDate(20) }]);
      await openInsights(false);
      assert.match(await statCard('TARGET REACHED'), /TARGET REACHED 1 of 1 recorded days · 1 against a Saṅkalpa target/, '25 meets the live seasonal 20');
      assert.match(await statCard('BEFORE 6:30 AM'), /BEFORE 6:30 AM/);
      await page.run(async () => { const seasonal = await import('/src/lib/seasonalService.ts'); const vow = (await seasonal.listVows())[0]; await seasonal.editSeasonalVow(vow.id, { config: { targetRounds: 30, morningCutoff: '05:00' } }); });
      await page.waitFor(async () => /TARGET REACHED 0 of 1/.test(await statCard('TARGET REACHED')), 'today follows the edited commitment live');
      assert.match(await statCard('BEFORE 5:00 AM'), /BEFORE 5:00 AM/);
      await page.run(async (start: string, end: string) => { const { db } = await import('/src/lib/db.ts'); const now = new Date().toISOString(); await db.seasonalVows.add({ id: 'vow-insights-conflict', type: 'japa', seasonName: 'TEST season', name: 'Imported conflict', startDate: start, endDate: end, status: 'active', config: { targetRounds: 24, morningCutoff: '04:00' }, configVersion: 1, createdAt: now, updatedAt: now }); }, prevMonth(1), localDate(20));
      await page.waitFor(async () => await page.ui<boolean>('exists', '[data-testid="insights-target-conflict"]'), 'the conflict explanation');
      const alert = await page.ui<string>('textOf', '[data-testid="insights-target-conflict"]');
      assert.match(alert, /^Today: More than one active seasonal Japa commitment covers this day with different targets \((30 and 24|24 and 30) rounds\), so your regular target of 16 rounds is used\./);
      assert.doesNotMatch(alert, /Live japa|Imported conflict/);
      assert.match(await statCard('TARGET REACHED'), /TARGET REACHED 1 of 1 recorded days(?! · )/, 'measured against the regular 16, with no seasonal day counted');
      assert.match(await statCard('BEFORE 7:00 AM'), /BEFORE 7:00 AM/); assert.match(await insightsText(), /Rounds per day · target 16(?! \()/);
      await page.run(async () => { const { db } = await import('/src/lib/db.ts'); await db.vowLogs.clear(); await db.seasonalVows.clear(); });
      await page.waitFor(async () => !(await page.ui<boolean>('exists', '[data-testid="insights-target-conflict"]')), 'the conflict clears');
      assert.deepEqual((await dump(page)).sadhana.map((entry) => entry.targetRounds), [16], 'viewing Insights wrote nothing seasonal');
    });
  } finally {
    b?.close(); a.close(); server.kill();
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} browser steps passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
