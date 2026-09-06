import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* Headless capture of the hero animation at a chosen timeline point.
   Usage: node tools/capture.mjs <targetMs> <outPath> [--reduced] [--url http://…]
   --reduced  skips the ?motion=full hook so the prefers-reduced-motion path renders.
   Drives Chrome over CDP, polls the page's own animation clock (performance.now()-t0)
   until the target lands, then screenshots. `--virtual-time-budget` is dead in
   Chrome 152 headless (measured 2026-09-06) — it freezes the page at t<300ms. */

const [, , targetMsArg, outPath, ...flags] = process.argv;
const targetMs = Number(targetMsArg);
const reduced = flags.includes('--reduced');
const urlArg = flags.indexOf('--url');
const BASE = urlArg >= 0 ? flags[urlArg + 1] : 'http://localhost:8731/';
const URL = BASE + (BASE.includes('?') ? '&' : '?') + (reduced ? 'reduced' : 'motion=full');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PROFILE = mkdtempSync(join(tmpdir(), 'hero-cap-'));

const proc = spawn(CHROME, [
  '--headless', '--disable-gpu', '--no-first-run',
  `--user-data-dir=${PROFILE}`,
  '--remote-debugging-port=0',
  '--window-size=1440,900',
  '--hide-scrollbars',
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });

let debugPort = null;
proc.stderr.on('data', d => {
  const m = String(d).match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);
  if (m) debugPort = Number(m[1]);
});

const hardKill = setTimeout(() => { console.log('TIMEOUT'); proc.kill('SIGKILL'); process.exit(2); }, 45000);
const cleanup = async () => { // chrome lingers a beat after SIGKILL — wait, then drop the profile
  await sleep(400);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
};

try {
  while (!debugPort) await sleep(50);
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(100);
    try {
      const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      target = list.find(t => t.type === 'page');
    } catch {}
  }
  if (!target) throw new Error('no page target');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    else if (m.method) events.push(m);
  };
  const send = (method, params = {}) => new Promise(res => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const waitEvent = async (method, timeoutMs = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const i = events.findIndex(e => e.method === method);
      if (i >= 0) return events.splice(i, 1)[0];
      await sleep(20);
    }
    throw new Error('event timeout: ' + method);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL });
  await waitEvent('Page.loadEventFired');

  // animation clock: t0 is the page's top-level let; read the real animation time
  const readT = async () => {
    const r = await send('Runtime.evaluate', { expression: 'performance.now() - t0', returnByValue: true });
    return r.result?.result?.value;
  };
  let t = await readT();
  if (typeof t !== 'number') throw new Error('cannot read animation clock');

  const deadline = Date.now() + 20000;
  while (t < targetMs && Date.now() < deadline) {
    await sleep(25);
    t = await readT();
  }
  // let the current frame paint
  await sleep(80);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(outPath, Buffer.from(shot.result.data, 'base64'));
  console.log(`OK animT=${Math.round(t)}ms target=${targetMs}ms url=${URL} -> ${outPath}`);
  clearTimeout(hardKill);
  proc.kill('SIGKILL');
  await cleanup();
  process.exit(0);
} catch (e) {
  console.log('FAIL: ' + e.message);
  clearTimeout(hardKill);
  proc.kill('SIGKILL');
  await cleanup();
  process.exit(1);
}
