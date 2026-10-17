import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { CALL_TIMEOUT_MS, Connection, EVALUATE_TIMEOUT_MS, Page } from './browser/cdp.ts';

/** The smallest stand-in for a WebSocket that Connection needs. */
class FakeSocket {
  listeners = new Map<string, ((event: unknown) => void)[]>();
  sent: { id: number; method: string; params: Record<string, unknown> }[] = [];
  throwOnSend: Error | null = null;
  addEventListener(type: string, listener: (event: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  send(text: string) { if (this.throwOnSend) throw this.throwOnSend; this.sent.push(JSON.parse(text)); }
  emit(type: string, event: unknown = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  message(payload: unknown) { this.emit('message', { data: JSON.stringify(payload) }); }
}
const make = () => { const socket = new FakeSocket(); const connection = new Connection(socket as unknown as WebSocket); return { socket, connection }; };
const NEVER_ANSWERED = 'CDP call timed out after';

test('a successful call returns exactly what Chrome sent, and leaves nothing pending', async () => {
  const { socket, connection } = make();
  const call = connection.send<{ value: number }>('Runtime.evaluate', { expression: '1+1' });
  assert.equal(socket.sent[0].method, 'Runtime.evaluate'); assert.deepEqual(socket.sent[0].params, { expression: '1+1' });
  socket.message({ id: socket.sent[0].id, result: { value: 2 } });
  assert.deepEqual(await call, { value: 2 }); assert.equal(connection.pending.size, 0); assert.equal(connection.dead, null);
});

test('an error answer from Chrome still rejects with Chrome\'s message', async () => {
  const { socket, connection } = make();
  const call = connection.send('Page.navigate', { url: 'x' });
  socket.message({ id: socket.sent[0].id, error: { message: 'Cannot navigate' } });
  await assert.rejects(call, /Cannot navigate/); assert.equal(connection.pending.size, 0);
});

test('events are still recorded', () => {
  const { socket, connection } = make();
  socket.message({ method: 'Page.loadEventFired', params: { timestamp: 1 } });
  assert.deepEqual(connection.events, [{ method: 'Page.loadEventFired', params: { timestamp: 1 } }]); assert.equal(connection.dead, null);
});

test('Runtime.evaluate gives up after 25 s and every other call after 20 s, by its own timer', async () => {
  assert.equal(EVALUATE_TIMEOUT_MS, 25_000); assert.equal(CALL_TIMEOUT_MS, 20_000);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { connection } = make();
    const evaluate = connection.send('Runtime.evaluate', { expression: 'never answered' });
    const other = connection.send('Page.reload');
    const evaluateOutcome = assert.rejects(evaluate, new RegExp(`${NEVER_ANSWERED} 25000 ms: Runtime.evaluate`));
    const otherOutcome = assert.rejects(other, new RegExp(`${NEVER_ANSWERED} 20000 ms: Page.reload`));
    mock.timers.tick(19_999); assert.equal(connection.pending.size, 2, 'nothing has timed out yet');
    mock.timers.tick(1); await otherOutcome; assert.equal(connection.pending.size, 1, 'only the 20 s call has timed out');
    mock.timers.tick(5_000); await evaluateOutcome; assert.equal(connection.pending.size, 0);
  } finally { mock.timers.reset(); }
});

test('an explicit timeout overrides the default, and a late answer after a timeout is ignored', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { socket, connection } = make();
    const call = connection.send('Runtime.evaluate', {}, 100);
    const outcome = assert.rejects(call, /timed out after 100 ms/);
    mock.timers.tick(100); await outcome;
    socket.message({ id: socket.sent[0].id, result: { late: true } }); // arrives after the call was given up on
    assert.equal(connection.pending.size, 0); assert.equal(connection.dead, null, 'a timed-out call does not by itself kill the session');
  } finally { mock.timers.reset(); }
});

test('Inspector.detached rejects every waiting call at once, with the reason, and later calls fail immediately', async () => {
  const { socket, connection } = make();
  const first = connection.send('Runtime.evaluate', { expression: 'a' }); const second = connection.send('Page.reload');
  const results = Promise.allSettled([first, second]);
  socket.message({ method: 'Inspector.detached', params: { reason: 'Render process gone.' } });
  const settled = await results;
  for (const outcome of settled) { assert.equal(outcome.status, 'rejected'); assert.match(String((outcome as PromiseRejectedResult).reason.message), /CDP session unusable: Inspector\.detached .*Render process gone\./); }
  assert.equal(connection.pending.size, 0); assert.match(connection.dead ?? '', /Inspector\.detached/);
  const sentBefore = socket.sent.length;
  await assert.rejects(connection.send('Runtime.evaluate', { expression: 'b' }), /CDP session unusable \(Inspector\.detached .*\) when calling Runtime\.evaluate/);
  assert.equal(socket.sent.length, sentBefore, 'nothing was sent to a lost page');
});

test('Inspector.targetCrashed is treated the same way', async () => {
  const { socket, connection } = make();
  const waiting = connection.send('Runtime.evaluate', { expression: 'a' });
  const outcome = assert.rejects(waiting, /CDP session unusable: Inspector\.targetCrashed/);
  socket.message({ method: 'Inspector.targetCrashed', params: {} }); await outcome;
  await assert.rejects(connection.send('Page.enable'), /unusable/);
});

test('a closed or failed websocket rejects waiting calls and blocks new ones', async () => {
  for (const [event, reason] of [['close', /websocket closed \(code 1006\)/], ['error', /websocket error/]] as const) {
    const { socket, connection } = make();
    const waiting = connection.send('Runtime.evaluate', { expression: 'a' });
    const outcome = assert.rejects(waiting, new RegExp(`CDP session unusable: ${reason.source}`));
    socket.emit(event, { code: 1006 }); await outcome;
    await assert.rejects(connection.send('Page.enable'), /session unusable/); assert.equal(connection.pending.size, 0);
  }
});

test('failing a session twice keeps the first reason and does not throw', () => {
  const { socket, connection } = make();
  socket.message({ method: 'Inspector.detached', params: { reason: 'first' } });
  socket.emit('close', { code: 1000 });
  assert.match(connection.dead ?? '', /first/);
});

test('cleanup: no timer outlives a call, whether it was answered, failed or abandoned by a dead session', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { socket, connection } = make();
    const answered = connection.send('Page.enable'); socket.message({ id: socket.sent[0].id, result: {} }); await answered;
    const abandoned = connection.send('Runtime.evaluate', {}); const abandonedOutcome = assert.rejects(abandoned, /CDP session unusable/);
    socket.emit('close', { code: 1000 }); await abandonedOutcome;
    // If any timer were still armed, ticking past its deadline would now fire it and reject an already-settled promise or throw.
    mock.timers.tick(60_000); await Promise.resolve();
    assert.equal(connection.pending.size, 0);
  } finally { mock.timers.reset(); }
});

test('a send that throws rejects that call and leaves nothing pending', async () => {
  const { socket, connection } = make(); socket.throwOnSend = new Error('socket is closing');
  await assert.rejects(connection.send('Page.enable'), /socket is closing/); assert.equal(connection.pending.size, 0);
});

test('waitFor on a lost page fails at once with the reason, instead of polling until its deadline', async () => {
  const { socket, connection } = make();
  const page = new Page(connection);
  socket.message({ method: 'Inspector.detached', params: { reason: 'target_closed' } });
  const started = Date.now();
  await assert.rejects(page.waitFor(() => page.eval<boolean>('document.readyState === "complete"'), 'page reload', 20_000), /Cannot wait for: page reload\. The browser page is no longer reachable: Inspector\.detached .*target_closed/);
  assert.ok(Date.now() - started < 2_000, 'it did not wait for the 20 s deadline');
});

test('a successful waitFor is unchanged', async () => {
  const { socket, connection } = make();
  const page = new Page(connection); let polls = 0;
  await page.waitFor(async () => { polls += 1; return polls >= 3; }, 'three polls', 5_000);
  assert.equal(polls, 3); assert.equal(connection.dead, null); void socket;
});
