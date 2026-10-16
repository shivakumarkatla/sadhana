import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStore, SAVE_FAILED_MESSAGE } from '../src/lib/diaryDrafts.ts';
import { attemptLock } from '../src/lib/diaryRules.ts';

const SECRET = 'disposable-private-text-12345';
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(options: { failing?: Set<string> } = {}) {
  const saved = new Map<string, string[]>();
  const failing = options.failing ?? new Set<string>();
  const store = createDraftStore({
    delayMs: 5,
    save: async (key, text) => {
      await tick(2);
      if (failing.has(key)) throw new Error(`disk full while saving ${text}`); // the underlying error may contain text; the store must not surface it
      saved.set(key, [...(saved.get(key) ?? []), text]);
    },
  });
  return { store, saved, failing };
}

test('a failed save keeps the draft, reports a text-free error, and a retry saves the exact text', async () => {
  const { store, saved, failing } = harness({ failing: new Set(['2026-10-16']) });
  store.set('2026-10-16', SECRET);
  await assert.rejects(store.flush());
  assert.equal(store.get('2026-10-16'), SECRET);
  assert.deepEqual(store.keys(), ['2026-10-16']);
  assert.equal(store.error(), SAVE_FAILED_MESSAGE);
  assert.equal(String(store.error()).includes(SECRET), false);
  failing.clear();
  await store.flush();
  assert.deepEqual(saved.get('2026-10-16'), [SECRET]);
  assert.deepEqual(store.keys(), []);
  assert.equal(store.error(), null);
});

test('leaving the editor (navigation) cannot lose text: the draft outlives the component', async () => {
  const { store, failing } = harness({ failing: new Set(['2026-10-16']) });
  store.set('2026-10-16', SECRET);
  await tick(40); // the debounced background save fails silently
  assert.equal(store.get('2026-10-16'), SECRET); // a remounted editor reads this instead of the disk
  assert.equal(store.error(), SAVE_FAILED_MESSAGE);
  failing.clear();
  await store.flush();
  assert.equal(store.get('2026-10-16'), undefined);
});

test('switching dates keeps each date draft separate', async () => {
  const { store, saved, failing } = harness({ failing: new Set(['2026-10-15']) });
  store.set('2026-10-15', 'yesterday text'); store.set('2026-10-16', 'today text');
  await assert.rejects(store.flush());
  assert.equal(store.get('2026-10-15'), 'yesterday text'); // the failed one is kept
  assert.equal(store.get('2026-10-16'), undefined); // the other one saved
  assert.deepEqual(saved.get('2026-10-16'), ['today text']);
  assert.equal(saved.has('2026-10-15'), false);
  failing.clear();
  await store.flush();
  assert.deepEqual(saved.get('2026-10-15'), ['yesterday text']);
});

test('text typed while a save is in flight is not dropped and the newest text is saved last', async () => {
  const { store, saved } = harness();
  store.set('d', 'first');
  const flushing = store.flush();
  await tick(1);
  store.set('d', 'first and more');
  await flushing.catch(() => undefined);
  await store.flush();
  assert.equal(saved.get('d')!.at(-1), 'first and more');
  assert.deepEqual(store.keys(), []);
});

test('only an explicit discard removes unsaved text', async () => {
  const { store } = harness({ failing: new Set(['d']) });
  store.set('d', SECRET);
  await assert.rejects(store.flush());
  await assert.rejects(store.flush());
  assert.equal(store.get('d'), SECRET);
  store.discard();
  assert.equal(store.get('d'), undefined);
  assert.equal(store.error(), null);
});

test('locking: a failed save keeps the key and decrypted state; success clears text before the key', async () => {
  const { store, failing } = harness({ failing: new Set(['d']) });
  const calls: string[] = [];
  const deps = { flush: () => store.flush(), hasUnsaved: () => store.keys().length > 0, clearDecrypted: () => calls.push('clear'), dropKey: () => calls.push('drop') };
  store.set('d', SECRET);
  assert.deepEqual(await attemptLock(deps), { ok: false });
  assert.deepEqual(calls, []); // nothing cleared, key still held
  assert.equal(store.get('d'), SECRET);
  failing.clear();
  assert.deepEqual(await attemptLock(deps), { ok: true });
  assert.deepEqual(calls, ['clear', 'drop']);
});

test('locking aborts if text arrives during the flush', async () => {
  const { store } = harness();
  store.set('d', 'a');
  const calls: string[] = [];
  const result = await attemptLock({ flush: async () => { await store.flush(); store.set('d', 'typed during lock'); }, hasUnsaved: () => store.keys().length > 0, clearDecrypted: () => calls.push('clear'), dropKey: () => calls.push('drop') });
  assert.deepEqual(result, { ok: false });
  assert.deepEqual(calls, []);
  assert.equal(store.get('d'), 'typed during lock');
});
