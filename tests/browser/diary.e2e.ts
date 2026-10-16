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
  try { await body(); results.push({ name, ok: true }); console.log(`  PASS  ${name}`); }
  catch (error) { const detail = error instanceof Error ? error.message : String(error); results.push({ name, ok: false, detail }); console.log(`  FAIL  ${name}\n        ${detail.split('\n').slice(0, 14).join('\n        ')}`); }
}

// ---- helpers that run inside the page against the real database ----
interface Dump { sessions: unknown[]; offerings: unknown[]; sadhana: { id: number; date: string; reflection: string; rounds: number }[]; encryptionMeta: { state: string; lockTimeoutMinutes: number }[]; privateContent: { id: string; rev: number }[] }
const dump = (page: Page) => page.run<Dump>(async () => {
  const { db } = await import('/src/lib/db.ts');
  return { sessions: await db.sessions.toArray(), offerings: await db.offerings.toArray(), sadhana: await db.sadhana.toArray(), encryptionMeta: await db.encryptionMeta.toArray(), privateContent: await db.privateContent.toArray() } as never;
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
const seedPlain = (page: Page) => page.run(async (dates: string[], seeds: string[]) => {
  const { db, saveSadhanaForDate } = await import('/src/lib/db.ts');
  for (let index = 0; index < dates.length; index += 1) {
    await saveSadhanaForDate({ date: dates[index], rounds: 10 + index, targetRounds: 16, earlyRounds: 4, sixteenthRoundTime: '', wakeUp: '4:15 AM', bedtime: '10:00 PM', sleepOnset: '10:20 PM', mangalaArati: 'Attended', qualityTags: ['Good focus'], reflection: seeds[index] } as never);
  }
  await db.sessions.add({ date: dates[0], kind: 'Study', title: 'SEED Srimad-Bhagavatam study', minutes: 45, note: 'seed' });
  await db.offerings.add({ date: dates[0], kind: 'Calling Service', minutes: 30, description: 'SEED calls' });
}, DATES, SEEDS);
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
    let key1 = ''; let key2 = ''; let backupAfterPath = '';

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
      assert.deepEqual(Object.keys(backup.stores).sort(), ['encryptionMeta', 'offerings', 'privateContent', 'sadhana', 'sessions']);
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

    await step('11. encrypted backup: all five stores, wrapped keys, ciphertext only, no secrets', async () => {
      await openSettings(page); const before = snapshotDir(a.downloadDir); await page.click('Export full backup'); await page.waitText('Backup created and checked');
      backupAfterPath = await waitFile(a.downloadDir, /^sadhana-backup-\d/, before);
      const stable = join(a.downloadDir, 'backup1-copy.json'); copyFileSync(backupAfterPath, stable); backupAfterPath = stable; // later downloads may reuse the original name
      const text = readFileSync(backupAfterPath, 'utf8'); const backup = JSON.parse(text) as { diaryState: string; containsPlaintextReflections: boolean; counts: Record<string, number>; stores: { encryptionMeta: Record<string, unknown>[] } };
      assert.equal(backup.diaryState, 'enabled'); assert.equal(backup.containsPlaintextReflections, false);
      assert.deepEqual(backup.counts, { sessions: 1, offerings: 1, sadhana: 3, encryptionMeta: 1, privateContent: 3 });
      assert.ok(backup.stores.encryptionMeta[0].passphraseWrap && backup.stores.encryptionMeta[0].recoveryWrap, 'wrapped keys included');
      for (const forbidden of ['TESTSECRET', P1, P2, P3, P4, key1, key2, key2.replace(/-/g, '')]) assert.equal(text.includes(forbidden), false, `backup leaks ${forbidden.slice(0, 8)}…`);
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
          if (args[0] === 'rw' && Array.isArray(args[1]) && args[1].length === 5) {
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
      const data = await dump(page); assert.deepEqual([data.sessions.length, data.offerings.length, data.sadhana.length, data.encryptionMeta.length, data.privateContent.length], [0, 0, 0, 0, 0]);
      await page.waitText('Set up private diary'); await nav(page, 'Sessions'); assert.equal(await page.ui('hasText', 'SEED Srimad-Bhagavatam study'), false);
      await nav(page, 'Preaching'); assert.equal(await page.ui('hasText', 'SEED calls'), false);
      await nav(page, 'Sādhana'); await page.waitFor(async () => (await textareaValue(page, PLAIN_TEXTAREA)) === '', 'blank plain reflection after Delete All');
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
          if (args[0] === 'r' && Array.isArray(args[1]) && args[1].length === 5) {
            win.__reads = (win.__reads ?? 0) + 1;
            if (win.__reads === 2) return promise.then((stores) => { win.__mid = JSON.stringify(stores); const copy = JSON.parse(win.__mid) as typeof stores; copy.sessions = copy.sessions.map((row) => ({ ...row, minutes: Number(row.minutes) + 1 })); return copy; });
          }
          return promise;
        };
      });
      await pageB.setFile('input[type=file]', backup3Path); await pageB.waitText('Restore this backup?'); await pageB.click('Replace my data');
      await pageB.waitText('put back unchanged'); assert.equal(await pageB.ui('hasText', 'Backup restored and verified'), false);
      const mid = JSON.parse(await pageB.eval<string>('window.__mid')) as Record<string, unknown[]>;
      for (const name of ['sessions', 'offerings', 'sadhana', 'encryptionMeta', 'privateContent']) assert.deepEqual(mid[name], backup3.stores[name], `${name}: the restored data really was written before the rollback`);
      const after = await dump(pageB);
      for (const name of ['sessions', 'offerings', 'sadhana', 'encryptionMeta', 'privateContent'] as const) assert.deepEqual(after[name], original[name], `${name} identical after rollback`);
      assert.equal(JSON.stringify(after), JSON.stringify(original));
      await pageB.run(async () => { const { db } = await import('/src/lib/db.ts'); (db as unknown as { transaction: unknown }).transaction = (window as unknown as { __origTxB: unknown }).__origTxB; });
      await nav(pageB, 'Sādhana'); await pageB.waitText('Your diary is locked'); assert.equal(await textareaValue(pageB), null);
    });

    await step('21b. rollback after a REAL stored mismatch (a stray row and an altered row written after the restore) returns every store exactly, checked in raw IndexedDB', async () => {
      await reloadAndWait(pageB); await openSettings(pageB);
      const originalApp = await dump(pageB); const originalRaw = await rawDump(pageB);
      assert.deepEqual(Object.keys(originalRaw).sort(), ['encryptionMeta', 'offerings', 'privateContent', 'sadhana', 'sessions'], 'raw dump covers the five stores');
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
          if (args[0] === 'rw' && Array.isArray(args[1]) && args[1].length === 5) {
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
      for (const name of ['sessions', 'offerings', 'sadhana', 'encryptionMeta', 'privateContent'] as const) {
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
  } finally {
    b?.close(); a.close(); server.kill();
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} browser steps passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
