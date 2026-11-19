/**
 * The Claude route's per-build policy (docs/dev/node-generator.md). ONE
 * variable, FS_LLM_CLOUD_ORIGINS, both widens the page's connect-src and turns
 * the option on (`__FS_LLM_CLOUD__`), so the option never shows where the
 * policy would refuse it, and a forgotten env HIDES the feature rather than
 * widening a policy.
 *
 * Every target is checked through the REAL config: Vite's own
 * `loadConfigFromFile` loads vite.config.ts under the env that target's own
 * script sets (read from the script, never restated here), and the test reads
 * the CSP meta the html plugin writes, the define the plugin returns and the
 * chunk the SDK lands in. The dev server's proxy is run against a stand-in
 * model server on loopback. The deploy scripts' verify steps curl a live host,
 * so those are pinned as text.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { loadConfigFromFile, type Plugin, type UserConfig } from 'vite';
import { SANDBOX_CSP, XR_CSP } from '@/engine/tslToPreviewHTML';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
const API = 'https://api.anthropic.com';

/** The env vars the config reads that a target may set; anything unnamed is cleared, so the runner's shell cannot leak in. */
const CLEARED = { FS_DESKTOP: '', TAURI_ENV_PLATFORM: '', FS_EVAL_UPLOAD_URL: '', FS_LLM_CLOUD_ORIGINS: '' };

async function loadConfig(env: Record<string, string>, command: 'build' | 'serve' = 'build'): Promise<UserConfig> {
  for (const [k, v] of Object.entries({ ...CLEARED, ...env })) vi.stubEnv(k, v);
  try {
    const mode = command === 'build' ? 'production' : 'development';
    const loaded = await loadConfigFromFile({ command, mode }, path.join(ROOT, 'vite.config.ts'), ROOT, 'silent');
    return loaded!.config;
  } finally {
    vi.unstubAllEnvs();
  }
}

const pluginsOf = (c: UserConfig) => (c.plugins ?? []).flat(Infinity as 1).filter(Boolean) as Plugin[];
const pluginNamed = (c: UserConfig, name: string) => pluginsOf(c).find((p) => p.name === name);

/** The page policy a build writes into every HTML entry, or null when it writes none. */
function pagePolicy(c: UserConfig, command: 'build' | 'serve' = 'build'): string | null {
  const p = pluginNamed(c, 'fs-csp-html');
  if (!p || (p.apply && p.apply !== command)) return null;
  const html = (p.transformIndexHtml as (h: string) => string)('<head></head>');
  return html.match(/content="([^"]*)"/)?.[1] ?? null;
}
const connectSrc = (policy: string) => policy.match(/connect-src ([^;]*)/)?.[1] ?? '';

/** `__FS_LLM_CLOUD__` as the build sees it: from the define plugin's config hook. */
function cloudDefine(c: UserConfig, command: 'build' | 'serve' = 'build'): boolean {
  expect((c.define ?? {}) as Record<string, unknown>, 'one source: no second, top-level define').not.toHaveProperty('__FS_LLM_CLOUD__');
  const p = pluginNamed(c, 'fs-llm-cloud-define');
  expect(p, 'the define plugin').toBeTruthy();
  const out = (p!.config as (u: UserConfig, e: { command: string; mode: string }) => UserConfig)({}, { command, mode: '' });
  return JSON.parse(String(out.define!.__FS_LLM_CLOUD__)) as boolean;
}

function sdkChunk(c: UserConfig): unknown {
  const output = c.build!.rollupOptions!.output as { manualChunks: (id: string) => unknown };
  return output.manualChunks('/x/node_modules/@anthropic-ai/sdk/index.mjs');
}

/** `NAME=value \` lines directly above a script's `npm run build`. */
function shellBuildEnv(sh: string): Record<string, string> {
  const block = sh.match(/\n((?:[ \t]*FS_\w+=[^\n]*\\\n)+)[ \t]*npm run build/)?.[1];
  expect(block, 'the build command').toBeTruthy();
  return Object.fromEntries(block!.trim().split('\n').map((l) => {
    const m = l.match(/^\s*(FS_\w+)=(\S*)\s*\\$/);
    expect(m, l).toBeTruthy();
    return [m![1], m![2]];
  }));
}

/** The `env:` of release.yml's web job's `npm run build` step ({} when it sets none). */
function releaseWebEnv(): Record<string, string> {
  const yml = read('.github/workflows/release.yml');
  const web = yml.slice(yml.indexOf('\n  web:'));
  expect(web, 'the web job builds').toContain('- run: npm run build\n');
  const block = web.match(/- run: npm run build\n\s+env:\n((?:\s+[A-Z_]+: .*\n)+)/)?.[1];
  if (!block) return {};
  return Object.fromEntries(block.trim().split('\n').map((l) => l.trim().split(/: /, 2) as [string, string]));
}

/** The `NAME=value` prefixes of `npm run deploy`'s `npm run build`. */
function pagesDeployEnv(): Record<string, string> {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  const m = pkg.scripts.deploy.match(/(?:^|&&\s*)((?:FS_\w+=\S*\s+)*)npm run build/);
  expect(m, 'npm run deploy builds').toBeTruthy();
  return Object.fromEntries(m![1].trim().split(/\s+/).filter(Boolean).map((a) => a.split('=', 2) as [string, string]));
}

describe('the policy each build ships, and the option it offers', () => {
  const NO_API = "'self' blob: https://alvis1.github.io https://alvismisjuns.lv";
  const WITH_API = `${NO_API} ${API}`;

  // No hosted build offers the Claude route (owner, 2026-11-19): only the
  // desktop app and the dev server do. Offering it on a host is one value.
  it.each([
    ['GitHub Pages, release.yml', releaseWebEnv, NO_API],
    ['GitHub Pages, npm run deploy', pagesDeployEnv, NO_API],
    ['alvismisjuns.lv', () => shellBuildEnv(read('scripts/deploy-alvismisjuns.sh')), NO_API],
    ['fs.sferas.lv, the study host', () => shellBuildEnv(read('scripts/deploy-sferas.sh')), NO_API],
    ['a plain npm run build', () => ({}), NO_API],
    ['a build that names the API', () => ({ FS_LLM_CLOUD_ORIGINS: API }), WITH_API],
  ])('%s', async (_name, envOf, expected) => {
    const config = await loadConfig(envOf());
    const policy = pagePolicy(config);
    expect(policy).not.toBeNull();
    expect(connectSrc(policy!)).toBe(expected);
    // The CSP entry and the option appear and disappear TOGETHER.
    const names = expected.includes(API);
    expect(cloudDefine(config)).toBe(names);
    expect(sdkChunk(config)).toBe(names ? 'vendor-anthropic' : undefined);
    if (!names) expect(policy).not.toContain('anthropic');
  });

  it('every deploy run from a shell sets it EMPTY, so a stale shell export cannot widen a hosted build', () => {
    for (const sh of ['scripts/deploy-sferas.sh', 'scripts/deploy-alvismisjuns.sh']) {
      expect(shellBuildEnv(read(sh)), sh).toHaveProperty('FS_LLM_CLOUD_ORIGINS', '');
    }
    expect(pagesDeployEnv()).toHaveProperty('FS_LLM_CLOUD_ORIGINS', '');
    expect(releaseWebEnv()).not.toHaveProperty('FS_LLM_CLOUD_ORIGINS');
  });

  it('the desktop app has no page policy and offers the route; the SDK keeps its own chunk', async () => {
    const config = await loadConfig({ FS_DESKTOP: '1' });
    expect(pagePolicy(config)).toBeNull();
    expect(cloudDefine(config)).toBe(true);
    expect(sdkChunk(config)).toBe('vendor-anthropic');
  });

  it('the dev server has no page policy and offers the route', async () => {
    const config = await loadConfig({}, 'serve');
    expect(pagePolicy(config, 'serve')).toBeNull();
    expect(cloudDefine(config, 'serve')).toBe(true);
  });

  it('every entry is exactly https://<host>, or the BUILD fails', async () => {
    for (const bad of ['http://api.anthropic.com', 'https://api.anthropic.com/', 'https://api.anthropic.com:443', 'https://*.anthropic.com', "https://api.anthropic.com'"]) {
      await expect(loadConfig({ FS_LLM_CLOUD_ORIGINS: bad }), bad).rejects.toThrow(/FS_LLM_CLOUD_ORIGINS/);
    }
    // Repeats are listed once; another https host joins the policy but offers nothing.
    const config = await loadConfig({ FS_LLM_CLOUD_ORIGINS: ` ${API}  ${API} https://example.org ` });
    expect(connectSrc(pagePolicy(config)!)).toBe(`${WITH_API} https://example.org`);
    const other = await loadConfig({ FS_LLM_CLOUD_ORIGINS: 'https://example.org' });
    expect(cloudDefine(other)).toBe(false);
  });
});

describe('the deploy scripts check what the host SERVES', () => {
  it('alvismisjuns fails if the served page names the API at all', () => {
    const sh = read('scripts/deploy-alvismisjuns.sh');
    expect(sh).toContain(`LLM_ABSENT="$(printf '%s' "$PAGE" | grep -cF 'api.anthropic.com' || true)"`);
    const verify = sh.slice(sh.indexOf('LLM_ABSENT="'));
    expect(verify).toMatch(/if \[ "\$LLM_ABSENT" -eq 0 \]; then[\s\S]*?else[\s\S]*?exit 1\s*\nfi/);
  });

  it('the study host fails if the served page names the API at all, beside every check it already had', () => {
    const sh = read('scripts/deploy-sferas.sh');
    expect(sh).toContain(`LLM_ABSENT="$(printf '%s' "$PAGE" | grep -cF 'api.anthropic.com' || true)"`);
    const gate = sh.slice(sh.lastIndexOf('[ "$SERVED" = "$EXPECTED" ]'));
    for (const check of [
      '[ "$SERVED" = "$EXPECTED" ]',
      '[ "$EVALP" = "200" ]',
      '[ "$CSP_OK" -ge 1 ]',
      '[ "$LLM_ABSENT" -eq 0 ]',
      '[ "$COMPARE_CODE" = "200" ]',
      '[ "$COMPARE_VER" = "$EXPECTED" ]',
      '[ "$COMPARE_OK" -ge 1 ]',
    ]) expect(gate.slice(0, gate.indexOf('fs.sferas.lv live')), check).toContain(check);
    expect(gate).toContain('exit 1');
  });
});

describe('shader code never inherits it', () => {
  it('the sandboxed documents and the VR popup carry their own connect-src, which names no origin', () => {
    expect(SANDBOX_CSP).toMatch(/connect-src blob: data:;/);
    expect(XR_CSP).toMatch(/connect-src 'self' blob: data:;/);
    for (const p of [SANDBOX_CSP, XR_CSP]) expect(p).not.toMatch(/anthropic|https?:/);
  });
});

describe("the dev server's proxy to a model server on this computer", () => {
  interface Seen { path: string; headers: http.IncomingHttpHeaders }
  const seen: Seen[] = [];
  let upstream: http.Server;
  let front: http.Server;
  let frontPort = 0;
  let targetHost = '';

  const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

  type Middleware = (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void;
  /** The plugin's middleware, as `configureServer` registers it under FS_LLM_DEV_TARGET=`target`. */
  async function proxyMiddleware(target: string): Promise<Middleware> {
    const config = await loadConfig({}, 'serve');
    const plugin = pluginNamed(config, 'fs-llm-dev-proxy');
    expect(plugin?.apply, 'dev server only').toBe('serve');
    let mw: Middleware | null = null;
    const server = { middlewares: { use: (fn: Middleware) => { mw = fn; } } };
    vi.stubEnv('FS_LLM_DEV_TARGET', target);
    try {
      (plugin!.configureServer as (s: unknown) => void)(server);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(mw, 'one middleware').not.toBeNull();
    return mw!;
  }

  function ask(p: string, headers: Record<string, string>, method = 'GET'): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: frontPort, path: p, method, headers }, (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end(method === 'POST' ? '{"x":1}' : undefined);
    });
  }

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      seen.push({ path: req.url ?? '', headers: req.headers });
      req.resume();
      req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":[]}'); });
    });
    targetHost = `127.0.0.1:${await listen(upstream)}`;
    const mw = await proxyMiddleware(`http://${targetHost}`);
    front = http.createServer((req, res) => mw(req, res, () => { res.writeHead(404); res.end('next'); }));
    frontPort = await listen(front);
  });

  afterAll(async () => {
    await Promise.all([front, upstream].map((s) => new Promise((r) => (s ? s.close(r) : r(null)))));
  });

  it("forwards the model routes from the dev server's own pages, with no Origin of its own", async () => {
    const host = `localhost:${frontPort}`;
    for (const [p, method] of [['/v1/models', 'GET'], ['/api/v1/models', 'GET'], ['/v1/chat/completions', 'POST']] as const) {
      seen.length = 0;
      const r = await ask(p, { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, method);
      expect(r, p).toEqual({ status: 200, body: '{"data":[]}' });
      expect(seen.map((s) => s.path)).toEqual([p]);
      expect(seen[0].headers.host).toBe(targetHost);
      expect(seen[0].headers).not.toHaveProperty('origin');
      expect(seen[0].headers).not.toHaveProperty('sec-fetch-site');
    }
    // A loopback name other than the one the page used, no browser headers (curl).
    for (const h of [`127.0.0.1:${frontPort}`, `[::1]:${frontPort}`, 'localhost']) {
      expect((await ask('/v1/models', { host: h })).status, h).toBe(200);
    }
  });

  it('refuses another site, and DNS rebinding — a same-origin request whose Host is not a loopback name', async () => {
    seen.length = 0;
    const host = `localhost:${frontPort}`;
    const refused: Record<string, string>[] = [
      { host: 'rebind.attacker.example:5899', origin: 'http://rebind.attacker.example:5899', 'sec-fetch-site': 'same-origin' },
      { host: 'localhost.evil.com' },
      { host: '127.0.0.1.nip.io' },
      { host: `0.0.0.0:${frontPort}` },
      { host, origin: 'https://evil.example' },
      { host, 'sec-fetch-site': 'cross-site' },
      { host, 'sec-fetch-site': 'same-site' },
      { host, origin: 'null' },
    ];
    for (const headers of refused) {
      const r = await ask('/v1/chat/completions', headers, 'POST');
      expect(r.status, JSON.stringify(headers)).toBe(403);
    }
    expect(seen).toEqual([]);
  });

  it('leaves every other path to the rest of the dev server', async () => {
    seen.length = 0;
    for (const p of ['/v1/completions', '/api/chat', '/api/tags', '/v1/models/x', '/', '/FastShaders/']) {
      expect(await ask(p, { host: `localhost:${frontPort}` }), p).toEqual({ status: 404, body: 'next' });
    }
    expect(seen).toEqual([]);
  });

  it('forwards only to a loopback http base, LM Studio by default', async () => {
    for (const bad of ['http://example.com:1234', 'https://127.0.0.1:1234', 'http://127.0.0.1:1234/v1', 'http://192.168.1.2:1234', 'not a url']) {
      await expect(proxyMiddleware(bad), bad).rejects.toThrow(/FS_LLM_DEV_TARGET/);
    }
    // Unset or empty is LM Studio's default address.
    await expect(proxyMiddleware('')).resolves.toBeTypeOf('function');
    expect(read('vite.config.ts')).toContain("process.env.FS_LLM_DEV_TARGET || 'http://127.0.0.1:1234'");
  });
});
