import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateWatcher, type ControllerContainer } from '../src/lib/appUpdate.ts';

function fakeContainer(controller: unknown = null) {
  const listeners = new Set<() => void>();
  const container: ControllerContainer & { controller: unknown } = {
    controller,
    addEventListener: (_type, listener) => { listeners.add(listener); },
    removeEventListener: (_type, listener) => { listeners.delete(listener); },
  };
  return { container, fire: () => [...listeners].forEach((listener) => listener()), count: () => listeners.size };
}

test('the first time a worker takes control of an uncontrolled page is the initial install, not an update', () => {
  const { container, fire } = fakeContainer(null); let updates = 0;
  createUpdateWatcher(container, () => { updates += 1; });
  container.controller = {}; fire();
  assert.equal(updates, 0);
});

test('a later controller change on that page is an update', () => {
  const { container, fire } = fakeContainer(null); let updates = 0;
  createUpdateWatcher(container, () => { updates += 1; });
  container.controller = {}; fire(); assert.equal(updates, 0);
  fire(); assert.equal(updates, 1);
});

test('a controller that is replaced on an already-controlled page is an update straight away', () => {
  const { container, fire } = fakeContainer({}); let updates = 0;
  createUpdateWatcher(container, () => { updates += 1; });
  fire(); assert.equal(updates, 1);
});

test('repeated controller changes notify once', () => {
  const { container, fire } = fakeContainer({}); let updates = 0;
  createUpdateWatcher(container, () => { updates += 1; });
  fire(); fire(); fire(); assert.equal(updates, 1);
});

test('stopping the watcher removes its listener', () => {
  const { container, fire, count } = fakeContainer({}); let updates = 0;
  const stop = createUpdateWatcher(container, () => { updates += 1; });
  assert.equal(count(), 1); stop(); assert.equal(count(), 0); fire(); assert.equal(updates, 0);
});

test('browsers without service workers do not crash and never notify', () => {
  for (const missing of [undefined, null, {} as unknown as ControllerContainer]) {
    let updates = 0;
    const stop = createUpdateWatcher(missing, () => { updates += 1; });
    assert.equal(typeof stop, 'function'); stop(); assert.equal(updates, 0);
  }
});
