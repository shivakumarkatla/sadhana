/**
 * Minimal Chrome DevTools Protocol driver for browser-level tests. No dependencies: it uses the installed Chrome, Node's built-in
 * WebSocket and fetch. Each Browser gets a brand-new profile directory, so IndexedDB/localStorage start empty (a "fresh browser context").
 * Run via `npm run test:browser`. Erasable TypeScript only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long one CDP call may wait for Chrome's answer before it is reported as failed instead of waiting forever. */
export const EVALUATE_TIMEOUT_MS = 25_000;
export const CALL_TIMEOUT_MS = 20_000;

export class Connection {
  ws: WebSocket;
  nextId = 1;
  pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  events: { method: string; params: Record<string, unknown> }[] = [];
  /** Set once the session can no longer answer (detached, crashed or closed). Every later call then fails at once with this reason. */
  dead: string | null = null;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('close', (event) => this.fail(`websocket closed (code ${(event as { code?: number }).code ?? 'unknown'})`));
    ws.addEventListener('error', () => this.fail('websocket error'));
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } };
      if (message.id === undefined) {
        if (message.method) {
          this.events.push({ method: message.method, params: message.params ?? {} });
          // Chrome reports a lost page this way; calls already waiting would otherwise never get an answer.
          if (message.method === 'Inspector.detached' || message.method === 'Inspector.targetCrashed') this.fail(`${message.method} ${JSON.stringify(message.params ?? {})}`);
        }
        return;
      }
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
    });
  }
  /** Marks the session unusable and rejects every call still waiting, each with the reason. */
  fail(reason: string): void {
    if (this.dead) return;
    this.dead = reason;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const waiter of waiting) waiter.reject(new Error(`CDP session unusable: ${reason}`));
  }
  static async open(url: string): Promise<Connection> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => resolve()); ws.addEventListener('error', () => reject(new Error('CDP connection failed'))); });
    return new Connection(ws);
  }
  /** One CDP call. Never waits longer than `timeoutMs`: the timer is its own, separate from Chrome's answer, so an unanswered call cannot block it. */
  send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs: number = method === 'Runtime.evaluate' ? EVALUATE_TIMEOUT_MS : CALL_TIMEOUT_MS): Promise<T> {
    if (this.dead) return Promise.reject(new Error(`CDP session unusable (${this.dead}) when calling ${method}`));
    const id = this.nextId; this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP call timed out after ${timeoutMs} ms: ${method}`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value as T); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }
}

/** Helpers that run INSIDE the page. Stringified and evaluated there, so they may only use page globals. */
function pageHelpers() {
  const norm = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
  const visible = (element: Element) => !!((element as HTMLElement).offsetParent || element.getClientRects().length);
  const buttons = () => [...document.querySelectorAll('button')].filter(visible);
  const findButton = (text: string, exact: boolean) => buttons().find((button) => {
    const label = norm(button.textContent); const aria = button.getAttribute('aria-label') ?? '';
    return exact ? label === text || aria === text : label.includes(text) || aria === text;
  });
  const labels = () => [...document.querySelectorAll('label')].filter(visible);
  const setNative = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  };
  return {
    text: () => document.body.innerText,
    hasText: (needle: string) => document.body.innerText.includes(needle),
    hasButton: (text: string, exact = false) => { const button = findButton(text, exact); return !!button && !(button as HTMLButtonElement).disabled; },
    click: (text: string, exact = false) => {
      const button = findButton(text, exact) as HTMLButtonElement | undefined;
      if (!button) throw new Error(`button not found: ${text}`);
      if (button.disabled) throw new Error(`button disabled: ${text}`);
      button.click(); return true;
    },
    fill: (labelText: string, value: string) => {
      const label = labels().find((candidate) => norm(candidate.textContent).startsWith(labelText));
      const field = label?.querySelector('input,textarea,select') as HTMLInputElement | undefined;
      if (!field) throw new Error(`field not found: ${labelText}`);
      setNative(field, value); return true;
    },
    check: (labelText: string) => {
      const label = labels().find((candidate) => norm(candidate.textContent).includes(labelText) && candidate.querySelector('input[type=checkbox]'));
      const box = label?.querySelector('input[type=checkbox]') as HTMLInputElement | undefined;
      if (!box) throw new Error(`checkbox not found: ${labelText}`);
      if (!box.checked) box.click(); return true;
    },
    fillSelector: (selector: string, value: string) => {
      const field = document.querySelector(selector) as HTMLInputElement | undefined;
      if (!field) throw new Error(`element not found: ${selector}`);
      setNative(field, value); return true;
    },
    valueOf: (selector: string) => (document.querySelector(selector) as HTMLInputElement | null)?.value ?? null,
    textOf: (selector: string) => document.querySelector(selector)?.textContent ?? null,
    exists: (selector: string) => !!document.querySelector(selector),
    clickSelector: (selector: string) => {
      const element = document.querySelector(selector) as HTMLElement | null;
      if (!element) throw new Error('element not found: ' + selector);
      element.click(); return true;
    },
  };
}
export type UiMethod = keyof ReturnType<typeof pageHelpers>;

export class Page {
  conn: Connection;
  constructor(conn: Connection) { this.conn = conn; }
  async eval<T>(expression: string): Promise<T> {
    const result = await this.conn.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.split('\n')[0] ?? result.exceptionDetails.text);
    return result.result.value;
  }
  /** Runs one page helper, e.g. page.ui('click', 'Continue'). */
  ui<T = unknown>(method: UiMethod, ...args: unknown[]): Promise<T> {
    return this.eval<T>(`(${pageHelpers.toString()})().${method}(...${JSON.stringify(args)})`);
  }
  /** Runs an async function in the page with JSON-serialisable arguments (it may `await import('/src/lib/db.ts')`). */
  run<T>(fn: (...args: never[]) => unknown, ...args: unknown[]): Promise<T> {
    return this.eval<T>(`(${fn.toString()})(...${JSON.stringify(args)})`);
  }
  async goto(url: string): Promise<void> {
    await this.conn.send('Page.navigate', { url });
    await this.waitFor(() => this.eval<boolean>('document.readyState === "complete"'), 'page load');
    await sleep(300);
  }
  async reload(): Promise<void> {
    await this.conn.send('Page.reload', { ignoreCache: true });
    await sleep(500);
    await this.waitFor(() => this.eval<boolean>('document.readyState === "complete"'), 'page reload');
    await sleep(300);
  }
  async waitFor(condition: () => Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      try { if (await condition()) return; } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
      // A lost page can never satisfy the condition, so report it now instead of polling until the deadline.
      if (this.conn.dead) throw new Error(`Cannot wait for: ${label}. The browser page is no longer reachable: ${this.conn.dead}`);
      await sleep(120);
    }
    const body = await this.conn.send<{ result: { value: string } }>('Runtime.evaluate', { expression: 'document.body.innerText.slice(0, 600)', returnByValue: true }, 3000).then((result) => result.result.value).catch(() => '(page unreadable)');
    throw new Error(`Timed out waiting for: ${label}${lastError ? ` (${lastError})` : ''}\n--- page text ---\n${body}`);
  }
  waitText(needle: string, timeoutMs?: number): Promise<void> { return this.waitFor(() => this.ui<boolean>('hasText', needle), `text "${needle}"`, timeoutMs); }
  async waitGone(needle: string, timeoutMs?: number): Promise<void> { await this.waitFor(async () => !(await this.ui<boolean>('hasText', needle)), `text "${needle}" to disappear`, timeoutMs); }
  async waitButton(text: string, exact = false): Promise<void> { await this.waitFor(() => this.ui<boolean>('hasButton', text, exact), `button "${text}"`); }
  async click(text: string, exact = false): Promise<void> { await this.waitButton(text, exact); await this.ui('click', text, exact); await sleep(120); }
  async fill(labelText: string, value: string): Promise<void> { await this.waitFor(() => this.ui<boolean>('fill', labelText, value), `field "${labelText}"`); await sleep(60); }
  async setFile(selector: string, path: string): Promise<void> {
    const object = await this.conn.send<{ result: { objectId: string } }>('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
    await this.conn.send('DOM.setFileInputFiles', { files: [path], objectId: object.result.objectId });
  }
  /** Waits for a CDP event (e.g. 'Page.javascriptDialogOpening') raised after `sinceIndex` events had been seen. */
  async waitEvent(method: string, sinceIndex: number, timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.conn.events.slice(sinceIndex).find((event) => event.method === method);
      if (found) return found.params;
      await sleep(100);
    }
    throw new Error(`event ${method} did not occur`);
  }
  eventCount(): number { return this.conn.events.length; }
  /** A real mouse click gives the page sticky user activation, which Chrome requires before it shows a beforeunload prompt. */
  async realClick(x: number, y: number): Promise<void> {
    await this.conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  /** Starts a navigation without waiting for it (it may be held by a beforeunload dialog). */
  startNavigation(url: string): void { this.conn.send('Page.navigate', { url }).catch(() => undefined); }
  /** Starts a reload without waiting for it (it may be held by a beforeunload dialog). */
  startReload(): void { this.conn.send('Page.reload', { ignoreCache: true }).catch(() => undefined); }
  handleDialog(accept: boolean): Promise<unknown> { return this.conn.send('Page.handleJavaScriptDialog', { accept }); }
  /** Emulated phone viewport. This is emulation in desktop Chrome, NOT a physical device. */
  async emulateMobile(width: number, height: number): Promise<void> {
    await this.conn.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
    await this.conn.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  }
  async cpuSlowdown(rate: number): Promise<void> { await this.conn.send('Emulation.setCPUThrottlingRate', { rate }); }
  async screenshot(): Promise<string> { return (await this.conn.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })).data; }
}

export class BrowserSession {
  process: ChildProcess;
  profileDir: string;
  downloadDir: string;
  port: number;
  browserConn!: Connection;
  page!: Page;
  constructor(process: ChildProcess, profileDir: string, downloadDir: string, port: number) { this.process = process; this.profileDir = profileDir; this.downloadDir = downloadDir; this.port = port; }

  static async launch(port: number): Promise<BrowserSession> {
    const executable = CHROME_PATHS.find((path) => existsSync(path));
    if (!executable) throw new Error('No Chrome/Edge installation found for browser tests.');
    // A leftover browser on this port (e.g. from a killed run) would silently mix old state into this run, so refuse to start.
    if (await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false)) throw new Error(`Port ${port} is already in use by a leftover browser. Close it and run again.`);
    const profileDir = mkdtempSync(join(tmpdir(), 'sadhana-profile-'));
    const downloadDir = join(profileDir, 'downloads'); mkdirSync(downloadDir);
    const child = spawn(executable, [
      '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking', '--disable-gpu', '--window-size=430,1000', '--remote-allow-origins=*', 'about:blank',
    ], { stdio: 'ignore' });
    const session = new BrowserSession(child, profileDir, downloadDir, port);
    let version: { webSocketDebuggerUrl: string } | undefined;
    for (let attempt = 0; attempt < 80 && !version; attempt += 1) {
      try { version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }; } catch { await sleep(250); }
    }
    if (!version) { session.close(); throw new Error('Browser did not start.'); }
    session.browserConn = await Connection.open(version.webSocketDebuggerUrl);
    await session.browserConn.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    const target = targets.find((item) => item.type === 'page');
    if (!target) { session.close(); throw new Error('No page target.'); }
    session.page = new Page(await Connection.open(target.webSocketDebuggerUrl));
    await session.page.conn.send('Page.enable'); await session.page.conn.send('Runtime.enable'); await session.page.conn.send('DOM.enable');
    await session.page.conn.send('Inspector.enable').catch(() => undefined); // lets Chrome tell us when the page is lost (Inspector.detached / targetCrashed)
    return session;
  }

  close(): void {
    try { this.page?.conn.ws.close(); this.browserConn?.ws.close(); } catch { /* already closed */ }
    this.process.kill();
    setTimeout(() => { try { rmSync(this.profileDir, { recursive: true, force: true }); } catch { /* profile still locked: harmless temp data */ } }, 1500);
  }
}
