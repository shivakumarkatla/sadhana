import { test } from 'node:test';
import assert from 'node:assert/strict';

/** A fresh copy of the module for every test (the query string makes it a new instance), so one test's leftover failures can never leak into another. */
let instance = 0;
async function fresh() { const module = await import(`../src/lib/pendingSaves.ts?test=${(instance += 1)}`) as typeof import('../src/lib/pendingSaves.ts'); return { trackSave: module.trackSave, settleTrackedSaves: module.settleTrackedSaves }; }

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
/** A save whose completion the test controls. */
function manual<T = void>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { run: () => promise, resolve, reject };
}
let counter = 0; const keyOf = () => `key-${(counter += 1)}`; // keys are unique per test, so tests never share tracker state

test('settle waits for a write that is still in flight', async () => {
  const { trackSave, settleTrackedSaves } = await fresh();
  const save = manual(); const key = keyOf();
  void trackSave(key, save.run);
  let settled = false; const settling = settleTrackedSaves().then((result) => { settled = true; return result; });
  await tick(20); assert.equal(settled, false, 'still waiting');
  save.resolve(); assert.equal(await settling, true);
});

test('with nothing tracked, settle returns true straight away', async () => {
  const { settleTrackedSaves } = await fresh();
  assert.equal(await settleTrackedSaves(), true);
});

test('a failed save is retried once, and a retry that works returns true', async () => {
  const { trackSave, settleTrackedSaves } = await fresh();
  const key = keyOf(); let calls = 0;
  void trackSave(key, async () => { calls += 1; if (calls === 1) throw new Error('disk full'); }).catch(() => undefined);
  assert.equal(await settleTrackedSaves(), true); assert.equal(calls, 2, 'one original attempt and exactly one retry');
  assert.equal(await settleTrackedSaves(), true); assert.equal(calls, 2, 'a recovered save is not retried again');
});

test('a retry that still fails returns false, without rejecting, and the retry stays available for the next settle', async () => {
  const { trackSave, settleTrackedSaves } = await fresh();
  const key = keyOf(); let calls = 0; let works = false;
  void trackSave(key, async () => { calls += 1; if (!works) throw new Error('offline'); }).catch(() => undefined);
  assert.equal(await settleTrackedSaves(), false); assert.equal(calls, 2, 'original plus one retry in that call');
  works = true;
  assert.equal(await settleTrackedSaves(), true); assert.equal(calls, 3);
});

test('the newest save for a key supersedes an older failed one: only the newest is retried', async () => {
  const { trackSave, settleTrackedSaves } = await fresh();
  const key = keyOf(); const ran: string[] = [];
  const first = trackSave(key, async () => { ran.push('old'); throw new Error('x'); }); first.catch(() => undefined);
  await tick(5);
  void trackSave(key, async () => { ran.push('new'); throw new Error('y'); }).catch(() => undefined);
  await tick(5); ran.length = 0;
  assert.equal(await settleTrackedSaves(), false); assert.deepEqual(ran, ['new'], 'the older retry is gone');
});

test('a newer successful save clears an obsolete failure', async () => {
  const { trackSave, settleTrackedSaves } = await fresh();
  const key = keyOf(); const ran: string[] = [];
  void trackSave(key, async () => { ran.push('old'); throw new Error('x'); }).catch(() => undefined);
  await tick(5);
  await trackSave(key, async () => { ran.push('new'); });
  ran.length = 0;
  assert.equal(await settleTrackedSaves(), true); assert.deepEqual(ran, [], 'nothing was retried');
});

test('an older save that fails AFTER a newer one started cannot record a failure, and cannot hide the newer one', async () => {
  const { trackSave, settleTrackedSaves } = await fresh();
  const key = keyOf(); const older = manual(); const newer = manual(); const ran: string[] = [];
  void trackSave(key, async () => { ran.push('old'); return older.run(); }).catch(() => undefined);
  void trackSave(key, async () => { ran.push('new'); return newer.run(); }).catch(() => undefined);
  older.reject(new Error('late failure')); await tick(5);
  newer.resolve(); ran.length = 0;
  assert.equal(await settleTrackedSaves(), true); assert.deepEqual(ran, [], 'the late old failure was ignored');
});

test('the tracker never rejects, and an ignored failing save never becomes an unhandled rejection', async () => {
  const { trackSave, settleTrackedSaves } = await fresh();
  const unhandled: unknown[] = []; const listener = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', listener);
  try {
    void trackSave(keyOf(), async () => { throw new Error('ignored by the caller'); });
    void trackSave(keyOf(), () => { throw new Error('thrown synchronously'); });
    const result = await settleTrackedSaves();
    await tick(20);
    assert.equal(result, false); assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', listener); }
});

test('a save started while settling is awaited too', async () => {
  const { trackSave, settleTrackedSaves } = await fresh();
  const first = manual(); const second = manual(); const keyA = keyOf(); const keyB = keyOf();
  void trackSave(keyA, first.run);
  let settled = false; const settling = settleTrackedSaves().then((result) => { settled = true; return result; });
  await tick(5);
  void trackSave(keyB, second.run); // started during settling
  first.resolve(); await tick(20); assert.equal(settled, false, 'the new save is still pending');
  second.resolve(); assert.equal(await settling, true);
});

test('a new failure that appears while settling makes the result false', async () => {
  const { trackSave, settleTrackedSaves } = await fresh();
  const first = manual(); const second = manual(); const keyA = keyOf(); const keyB = keyOf(); let secondCalls = 0;
  void trackSave(keyA, first.run);
  const settling = settleTrackedSaves();
  await tick(5);
  void trackSave(keyB, async () => { secondCalls += 1; return second.run(); }).catch(() => undefined);
  first.resolve(); await tick(5);
  second.reject(new Error('late')); // the retry will fail as well, because the same manual promise stays rejected
  assert.equal(await settling, false); assert.equal(secondCalls, 2, 'one attempt and one retry');
});

test('concurrent settle calls both wait, never return true early, and agree', async () => {
  const { trackSave, settleTrackedSaves } = await fresh();
  const save = manual(); const key = keyOf(); let calls = 0;
  void trackSave(key, async () => { calls += 1; return save.run(); });
  const results: boolean[] = [];
  const a = settleTrackedSaves().then((r) => results.push(r)); const b = settleTrackedSaves().then((r) => results.push(r));
  await tick(20); assert.deepEqual(results, [], 'neither call returned while the write was pending');
  save.resolve(); await Promise.all([a, b]); assert.deepEqual(results, [true, true]); assert.equal(calls, 1, 'no extra retries');
});

test('concurrent settle calls on a failed save do not run the retry twice at the same time', async () => {
  const { trackSave, settleTrackedSaves } = await fresh();
  const key = keyOf(); let calls = 0; let active = 0; let overlapped = false;
  void trackSave(key, async () => { calls += 1; active += 1; if (active > 1) overlapped = true; await tick(10); active -= 1; if (calls === 1) throw new Error('first fails'); }).catch(() => undefined);
  const [one, two] = await Promise.all([settleTrackedSaves(), settleTrackedSaves()]);
  assert.deepEqual([one, two], [true, true]); assert.equal(overlapped, false); assert.equal(calls, 2);
});
