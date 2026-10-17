/**
 * "A newer version is ready" detection. With registerType 'autoUpdate' a new service worker installs and takes control by itself (there is no
 * waiting state), so the only signal an open tab gets is `controllerchange`. That event also fires once when a worker first claims a page that
 * had none (the very first install), which is not an update, so a change only counts once the page already had a controller.
 * Pure watcher + a tiny store for useSyncExternalStore. Erasable TypeScript only.
 */

export interface ControllerContainer {
  controller: unknown;
  addEventListener(type: 'controllerchange', listener: () => void): void;
  removeEventListener?(type: 'controllerchange', listener: () => void): void;
}

/** Calls `onUpdate` at most once, the first time an existing controller is replaced. Returns a function that stops listening. */
export function createUpdateWatcher(container: ControllerContainer | undefined | null, onUpdate: () => void): () => void {
  if (!container || typeof container.addEventListener !== 'function') return () => undefined;
  let controlled = Boolean(container.controller);
  let notified = false;
  const listener = () => {
    if (!controlled) { controlled = true; return; } // first control of an uncontrolled page: the initial install, not an update
    if (notified) return;
    notified = true;
    onUpdate();
  };
  container.addEventListener('controllerchange', listener);
  return () => container.removeEventListener?.('controllerchange', listener);
}

let available = false;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

export function markUpdateAvailable(): void {
  if (available) return;
  available = true;
  listeners.forEach((listener) => listener());
}
export const getUpdateSnapshot = (): boolean => available;
export function subscribeUpdate(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** Starts the real listener once. Safe to call again and in browsers without service workers. */
export function startUpdateWatch(): void {
  if (stop) return;
  const container = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : undefined;
  stop = createUpdateWatcher(container, markUpdateAvailable);
}
