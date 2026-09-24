#!/usr/bin/env node
// Open FastShaders in REAL Chrome (Playwright `channel: 'chrome'` — no browser
// download; the Playwright cache on this machine has webkit/firefox, no
// chromium) and print what a human would check first, as JSON.
//
//   node .claude/skills/fs-run/drive.mjs [url] [--shot out.png] [--wait ms] [--headed]
//
// url defaults to the dev server, http://localhost:5173/FastShaders/.
// Import it for scripted checks: `const { open } = await import(...)` returns
// { browser, page, preview } where `preview` is the SANDBOXED preview frame —
// Playwright crosses its opaque origin, the parent page cannot.
import { createRequire } from 'node:module';
import { readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not a project dep */ }
  const npx = join(homedir(), '.npm/_npx');
  for (const d of existsSync(npx) ? readdirSync(npx) : []) {
    const p = join(npx, d, 'node_modules/playwright');
    if (existsSync(p)) return createRequire(pathToFileURL(join(p, 'package.json')))('playwright');
  }
  throw new Error('playwright not found — run `npx -y playwright@1.49.1 --version` once to cache it');
}

export async function open(url = 'http://localhost:5173/FastShaders/', { headed = false, wait = 4000 } = {}) {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ channel: 'chrome', headless: !headed });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.react-flow__node', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(wait);
  // The preview is a sandboxed srcdoc iframe: the one frame that is neither
  // the main page nor about:blank-without-a-scene.
  const preview = page.frames().find((f) => f !== page.mainFrame() && f.url() !== 'about:blank')
    ?? page.frames().find((f) => f !== page.mainFrame()) ?? null;
  return { browser, page, preview, errors };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const headed = args.includes('--headed') && !!args.splice(args.indexOf('--headed'), 1);
  const shot = flag('--shot');
  const wait = Number(flag('--wait') ?? 4000);
  const { browser, page, preview, errors } = await open(args[0], { headed, wait });
  const summary = await page.evaluate(() => ({
    title: document.title,
    version: document.querySelector('meta[name="version"]')?.getAttribute('content') ?? null,
    nodes: document.querySelectorAll('.react-flow__node').length,
    edges: document.querySelectorAll('.react-flow__edge').length,
  }));
  summary.previewEntity = preview
    ? await preview.evaluate(() => {
        const e = document.querySelector('#preview-entity');
        return e ? Object.fromEntries([...e.attributes].map((a) => [a.name, a.value.slice(0, 120)])) : null;
      }).catch((e) => `unreadable: ${e.message}`)
    : null;
  summary.consoleErrors = errors;
  if (shot) { await page.screenshot({ path: shot }); summary.screenshot = shot; }
  console.log(JSON.stringify(summary, null, 2));
  await browser.close();
}
