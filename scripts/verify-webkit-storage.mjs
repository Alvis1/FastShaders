#!/usr/bin/env node
/**
 * Manual proof, against a REAL WebKit engine, that `fs:graph` / `fs:savedGroups`
 * written through `src/utils/asciiStorage.ts` fit WebKit's localStorage quota
 * where the unescaped JSON does not. Not part of `npm test`: vitest's `node`
 * environment cannot see whether a string is stored 8-bit or 16-bit, which is
 * the whole question.
 *
 *   npm run dev            # or any dev server serving the app
 *   PLAYWRIGHT_CORE=~/.npm/_npx/776af783dbecb618/node_modules/playwright-core \
 *     node scripts/verify-webkit-storage.mjs
 *
 * PLAYWRIGHT_CORE must name a playwright-core whose browsers.json matches an
 * INSTALLED WebKit (1.62.x uses webkit-2336). The npx cache directory hash is
 * not stable, hence the variable. FS_DEV_URL overrides the app URL
 * (default http://localhost:5173/FastShaders/).
 *
 * Playwright's WebKit is WebKit, not Safari. For Safari 26.x or the macOS
 * .dmg (WKWebView), paste Stage 1's page body into Web Inspector with
 * `toAsciiStorageJson` inlined: a production build cannot import a .ts file.
 *
 * STAGE 1 runs the real util in the page. Its CONTROL write (the plain
 * stringify of a 3.5M-character value holding one U+0101) MUST throw
 * QuotaExceededError; if it saves, this engine does not charge 16-bit strings
 * double and the run proves nothing (exit 2). STAGE 2 is end to end: a 3.5M
 * image payload plus a Latvian file name through the store's own autosave,
 * then a reload.
 *
 * Every non-ASCII character is built with String.fromCharCode, because the
 * shell this is usually launched from rejects raw non-ASCII in a command.
 */
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

const require = createRequire(import.meta.url);
const spec = (process.env.PLAYWRIGHT_CORE ?? 'playwright-core').replace(/^~(?=\/|$)/, homedir());
let pw;
try {
  pw = require(spec);
} catch {
  console.error(
    `playwright-core not found at "${spec}".\n` +
      'Run with PLAYWRIGHT_CORE=~/.npm/_npx/776af783dbecb618/node_modules/playwright-core ' +
      '(playwright-core 1.62.x, whose WebKit is webkit-2336).',
  );
  process.exit(1);
}

const BASE = (process.env.FS_DEV_URL ?? 'http://localhost:5173/FastShaders/').replace(/\/?$/, '/');
const BASE_PATH = new URL(BASE).pathname;
const QUOTA_BYTES = 5_242_880; // measured in WebKit 26.5: per origin, key + value

const rows = [];
const check = (name, pass, detail = '') => rows.push({ name, pass: !!pass, detail });

/** The live store module URL. Importing the bare path after an HMR update
 *  yields a SECOND, empty store (the `?t=` trap in CLAUDE.md). */
async function storeUrlOf(page) {
  await page.waitForFunction(
    () => performance.getEntriesByType('resource').some((e) => e.name.includes('/src/store/useAppStore.ts')),
    null,
    { timeout: 60_000 },
  ).catch(() => {});
  const found = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/src/store/useAppStore.ts')),
  );
  return found ?? new URL('src/store/useAppStore.ts', BASE).href;
}

const browser = await pw.webkit.launch();
let exitCode = 0;
try {
  console.log(`WebKit ${browser.version()} against ${BASE}`);

  // ---------- STAGE 1: the real util under JSC ----------
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'load' });
    const s1 = await page.evaluate(async ({ basePath, quota }) => {
      const m = await import(basePath + 'src/utils/asciiStorage.ts');
      const U0101 = String.fromCharCode(0x0101);
      const v = {
        nodes: [{ label: 'Z' + U0101 + 'le ' + String.fromCodePoint(0x1f600), big: 'x'.repeat(3_500_000) }],
        edges: [],
      };
      const set = (k, val) => {
        const t0 = performance.now();
        try {
          localStorage.setItem(k, val);
          return { ok: true, ms: performance.now() - t0 };
        } catch (e) {
          return { ok: false, name: e && e.name, ms: performance.now() - t0 };
        }
      };
      const out = {};
      // Everything below runs synchronously after the import, so the app's own
      // debounced autosave cannot land between a clear and a write.
      localStorage.clear();
      out.control = set('fs:probe', JSON.stringify(v));
      localStorage.clear();
      const t0 = performance.now();
      const enc = m.toAsciiStorageJson(v);
      out.encodeMs = performance.now() - t0;
      out.escaped = set('fs:probe', enc);
      const back = localStorage.getItem('fs:probe');
      out.ascii = back != null && /^[\x00-\x7f]*$/.test(back);
      out.roundTrip = back != null && JSON.stringify(JSON.parse(back)) === JSON.stringify(v);
      localStorage.clear();
      const cap = quota - 'fs:probe'.length;
      out.capFits = set('fs:probe', 'x'.repeat(cap));
      localStorage.clear();
      out.capPlusOne = set('fs:probe', 'x'.repeat(cap + 1));
      localStorage.clear();
      return out;
    }, { basePath: BASE_PATH, quota: QUOTA_BYTES });

    if (s1.control.ok) {
      console.error('CONTROL write SAVED: this engine does not charge 16-bit strings double - the run proves nothing.');
      exitCode = 2;
    }
    check('control: plain stringify (3.5M + one U+0101) is refused', !s1.control.ok,
      `${s1.control.name ?? 'saved'}, ${s1.control.ms.toFixed(1)} ms`);
    check('toAsciiStorageJson value saves', s1.escaped.ok,
      `setItem ${s1.escaped.ms.toFixed(1)} ms, encode ${s1.encodeMs.toFixed(1)} ms`);
    check('stored value is pure ASCII', s1.ascii);
    check('stored value parses back deep-equal', s1.roundTrip);
    check(`8-bit capacity: ${QUOTA_BYTES} - key length saves`, s1.capFits.ok, `${s1.capFits.ms.toFixed(1)} ms`);
    check('8-bit capacity: one more character is refused', !s1.capPlusOne.ok, s1.capPlusOne.name ?? 'saved');
    await ctx.close();
  }

  // ---------- STAGE 2: the store's own autosave, end to end ----------
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'load' });
    const url1 = await storeUrlOf(page);
    const s2 = await page.evaluate(async ({ url }) => {
      const m = await import(url);
      const st = m.useAppStore.getState();
      const liveNodes = st.nodes.length; // 0 would mean a second, empty store instance
      const node = {
        id: 'wk1',
        type: 'shader',
        position: { x: 0, y: 0 },
        data: {
          registryType: 'imageNode',
          label: 'Image',
          cost: 10,
          values: {
            imageB64: 'data:image/png;base64,' + 'A'.repeat(3_500_000),
            width: 1,
            height: 1,
            fileName: 'z' + String.fromCharCode(0x0101) + 'le.png',
            colorSpace: 'color',
          },
        },
      };
      st.setNodes([...st.nodes, node], 'graph');
      await new Promise((r) => setTimeout(r, 2000));
      const raw = localStorage.getItem('fs:graph') ?? '';
      return {
        liveNodes,
        len: raw.length,
        ascii: /^[\x00-\x7f]*$/.test(raw),
        hasNode: raw.includes('"wk1"'),
        notices: m.useAppStore.getState().pendingLimitNotices.map((n) => n.kind),
      };
    }, { url: url1 });
    check('stage 2 drives the LIVE store (demo graph present)', s2.liveNodes > 0, `${s2.liveNodes} nodes`);
    check('autosave wrote fs:graph over 3.5M characters', s2.len > 3_500_000 && s2.hasNode, `${s2.len} chars`);
    check('autosaved fs:graph is pure ASCII', s2.ascii);
    check('no storage-quota notice', !s2.notices.includes('storage-quota'), s2.notices.join(', ') || 'none');

    await page.reload({ waitUntil: 'load' });
    const url2 = await storeUrlOf(page);
    const r = await page.evaluate(async ({ url }) => {
      const m = await import(url);
      const deadline = performance.now() + 30_000;
      let n;
      while (performance.now() < deadline) {
        n = m.useAppStore.getState().nodes.find((x) => x.id === 'wk1');
        if (n) break;
        await new Promise((res) => setTimeout(res, 100));
      }
      if (!n) return { found: false, notices: [] };
      const v = n.data.values;
      return {
        found: true,
        macron: String(v.fileName).includes(String.fromCharCode(0x0101)),
        b64Len: String(v.imageB64).length,
        notices: m.useAppStore.getState().pendingLimitNotices.map((x) => x.kind),
      };
    }, { url: url2 });
    check('after reload the image node is back', r.found);
    check('its file name kept U+0101', r.macron);
    check('its payload is intact (3,500,022 characters)', r.b64Len === 3_500_022, String(r.b64Len));
    check('no images-stripped-on-load notice', !r.notices.includes('images-stripped-on-load'), r.notices.join(', ') || 'none');
    await ctx.close();
  }
} finally {
  await browser.close();
}

const w = Math.max(...rows.map((x) => x.name.length));
for (const x of rows) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name.padEnd(w)}  ${x.detail}`);
if (exitCode === 0 && rows.some((x) => !x.pass)) exitCode = 1;
console.log(exitCode === 0 ? 'ALL PASS' : `exit ${exitCode}`);
process.exit(exitCode);
