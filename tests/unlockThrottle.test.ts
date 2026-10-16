import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THROTTLE_MAX_MS, createUnlockThrottle, delayAfterFailures, type StorageLike } from '../src/lib/unlockThrottle.ts';

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } };
}

test('the first two mistakes are free, then delays escalate to a two-minute cap', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 50].map(delayAfterFailures), [0, 0, 0, 5000, 10000, 30000, 60000, 120000, 120000, 120000]);
  assert.equal(THROTTLE_MAX_MS, 120000);
});

test('failures block attempts for the escalating delay and the wait counts down', () => {
  let clock = 1_000_000;
  const throttle = createUnlockThrottle(memoryStorage(), () => clock);
  assert.equal(throttle.remainingMs(), 0);
  throttle.recordFailure(); throttle.recordFailure();
  assert.equal(throttle.remainingMs(), 0);
  assert.equal(throttle.recordFailure(), 5000);
  assert.equal(throttle.remainingMs(), 5000);
  clock += 3000; assert.equal(throttle.remainingMs(), 2000);
  clock += 2500; assert.equal(throttle.remainingMs(), 0);
  assert.equal(throttle.recordFailure(), 10000);
  clock += 10000;
  assert.equal(throttle.recordFailure(), 30000);
  assert.equal(throttle.failures(), 5);
});

test('a successful unlock resets everything', () => {
  const clock = 5_000;
  const store = memoryStorage();
  const throttle = createUnlockThrottle(store, () => clock);
  for (let index = 0; index < 5; index += 1) throttle.recordFailure();
  assert.ok(throttle.remainingMs() > 0);
  throttle.reset();
  assert.equal(throttle.remainingMs(), 0);
  assert.equal(throttle.failures(), 0);
  assert.equal(store.data.size, 0);
  assert.equal(throttle.recordFailure(), 0);
});

test('the delay survives a reload (same storage) but never exceeds the cap, even if storage is tampered with', () => {
  const clock = 10_000;
  const store = memoryStorage();
  const first = createUnlockThrottle(store, () => clock);
  for (let index = 0; index < 4; index += 1) first.recordFailure();
  const reloaded = createUnlockThrottle(store, () => clock);
  assert.equal(reloaded.remainingMs(), 10000);
  store.data.set('sadhana.diary.unlockThrottle', JSON.stringify({ failures: 99, until: clock + 10 ** 12 }));
  assert.equal(reloaded.remainingMs(), THROTTLE_MAX_MS); // no permanent lockout
  store.data.set('sadhana.diary.unlockThrottle', '{not json');
  assert.equal(reloaded.remainingMs(), 0);
  store.data.set('sadhana.diary.unlockThrottle', JSON.stringify({ failures: 'x', until: null }));
  assert.equal(reloaded.remainingMs(), 0);
});

test('blocked or missing storage falls back to an in-memory delay', () => {
  let clock = 0;
  const broken: StorageLike = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  const throttle = createUnlockThrottle(broken, () => clock);
  assert.doesNotThrow(() => { throttle.recordFailure(); throttle.reset(); });
  const none = createUnlockThrottle(null, () => clock);
  none.recordFailure(); none.recordFailure(); none.recordFailure();
  assert.equal(none.remainingMs(), 5000);
  clock += 5000; assert.equal(none.remainingMs(), 0);
});
