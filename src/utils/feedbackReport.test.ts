import { describe, it, expect } from 'vitest';
import {
  FEEDBACK_EMAIL,
  MAILTO_SAFE_CHARS,
  buildMailtoUrl,
  buildReportText,
  buildSubject,
  countProject,
  envLines,
  formatBytes,
  kindLabel,
  mailtoTooLong,
  previewBackend,
  type FeedbackEnv,
  type FeedbackProject,
} from './feedbackReport';
import { tslToPreviewHTML } from '@/engine/tslToPreviewHTML';
import { makeEdge, makeNode } from '@/test-utils';
import type { AppEdge, AppNode } from '@/types';

const ENV: FeedbackEnv = {
  version: '0.3.13',
  build: 'web',
  address: 'https://alvis1.github.io/FastShaders/',
  userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15',
  platform: 'MacIntel',
  gpuExposed: true,
  previewBackend: 'WebGL2 (forced — Safari/WebKit)',
  display: '2560×1440 · window 1512×850 · DPR 2',
  uiLanguage: 'en',
  timestamp: '2026-08-01T09:30:00.000Z',
};

/** UA samples spanning every branch of the force-WebGL2 rule. */
const UA_CASES: { name: string; ua: string; platform: string; touch: number; forced: boolean }[] = [
  {
    name: 'iPhone Safari',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
    platform: 'iPhone', touch: 5, forced: true,
  },
  {
    name: 'Chrome on iOS (still WKWebView)',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/120.0 Mobile/15E148 Safari/604.1',
    platform: 'iPhone', touch: 5, forced: true,
  },
  {
    name: 'iPadOS desktop mode (reports as Macintosh)',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
    platform: 'MacIntel', touch: 5, forced: true,
  },
  {
    name: 'desktop Safari',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
    platform: 'MacIntel', touch: 0, forced: true,
  },
  {
    name: 'desktop Chrome (WebKit token present, Chrome wins)',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    platform: 'MacIntel', touch: 0, forced: false,
  },
  {
    name: 'desktop Firefox',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0',
    platform: 'MacIntel', touch: 0, forced: false,
  },
  {
    name: 'Quest Browser (Android Chromium)',
    ua: 'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/33.0 SamsungBrowser/4.0 Chrome/126.0 Safari/537.36',
    platform: 'Linux x86_64', touch: 0, forced: false,
  },
  {
    name: 'Edge on Windows',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0',
    platform: 'Win32', touch: 0, forced: false,
  },
];

describe('feedbackReport — report text', () => {
  it('starts with the message and puts the technical block last', () => {
    const text = buildReportText({
      kind: 'bug',
      message: 'The preview goes blank when I add a voronoi node.',
      includeEnv: true,
      env: ENV,
    });
    expect(text.startsWith('The preview goes blank')).toBe(true);
    expect(text.indexOf('--- Technical details ---')).toBeGreaterThan(0);
  });

  it('carries no sender field — the report arrives as email, which already has one', () => {
    const text = buildReportText({
      kind: 'idea', message: 'A grid snap would help.', includeEnv: true, env: ENV,
    });
    expect(text).not.toMatch(/^From:/m);
  });

  it('trims surrounding whitespace off the message', () => {
    expect(
      buildReportText({ kind: 'idea', message: '  \n A grid snap.  \n', includeEnv: false, env: ENV }),
    ).toBe('A grid snap.');
  });

  it('omits the technical block when the user unticks it', () => {
    const text = buildReportText({
      kind: 'comment', message: 'Nice tool.', includeEnv: false, env: ENV,
    });
    expect(text).not.toContain('Technical details');
    expect(text).not.toContain(ENV.userAgent);
  });

  it('technical block reports every environment fact, aligned', () => {
    const lines = envLines(ENV);
    const joined = lines.join('\n');
    expect(joined).toContain('0.3.13 (web)');
    expect(joined).toContain('https://alvis1.github.io/FastShaders/');
    expect(joined).toContain(ENV.userAgent);
    expect(joined).toContain('WebGL2 (forced — Safari/WebKit)');
    expect(joined).toContain('exposed');
    expect(joined).toContain('DPR 2');
    // Values line up in a monospace paste: every value starts at the same column.
    const cols = lines.map((l) => l.indexOf(l.trimEnd().split(/:\s+/)[1] ?? ''));
    expect(new Set(cols).size).toBe(1);
  });

  it('"not exposed" is distinguishable from "exposed" (substring trap)', () => {
    const off = envLines({ ...ENV, gpuExposed: false }).find((l) => l.startsWith('WebGPU'));
    expect(off).toContain('not exposed');
  });

  it('subject carries the kind and version', () => {
    expect(buildSubject('bug', '0.3.13')).toBe('FastShaders Bug — v0.3.13');
    expect(buildSubject('idea', '1.0.0')).toBe('FastShaders Idea — v1.0.0');
    expect(kindLabel('comment')).toBe('Comment');
  });
});

describe('feedbackReport — mailto URL', () => {
  it('encodes the header separators that would otherwise split the URL', () => {
    const url = buildMailtoUrl(FEEDBACK_EMAIL, 'S & T', 'a?b&c#d\ne');
    expect(url.startsWith(`mailto:${FEEDBACK_EMAIL}?subject=`)).toBe(true);
    // Exactly one '?' (the header separator) and one '&' (between subject/body).
    expect(url.split('?').length - 1).toBe(1);
    expect(url.split('&').length - 1).toBe(1);
    expect(url).toContain('%23'); // '#' — would otherwise start a fragment
    expect(url).toContain('%0A'); // newline survives as a line break
  });

  it('round-trips the body through decodeURIComponent unchanged', () => {
    const body = buildReportText({
      kind: 'bug', message: 'Ā ž ē — ünïcode & "quotes" +plus', includeEnv: true, env: ENV,
    });
    const url = buildMailtoUrl(FEEDBACK_EMAIL, 'x', body);
    const encoded = url.slice(url.indexOf('&body=') + '&body='.length);
    expect(decodeURIComponent(encoded)).toBe(body);
  });

  it('flags over-long URLs so the modal can steer to the clipboard', () => {
    const short = buildMailtoUrl(FEEDBACK_EMAIL, 'x', 'hello');
    expect(mailtoTooLong(short)).toBe(false);
    const long = buildMailtoUrl(FEEDBACK_EMAIL, 'x', 'x'.repeat(MAILTO_SAFE_CHARS + 1));
    expect(mailtoTooLong(long)).toBe(true);
  });

  it('a report with the technical block still fits a normal message', () => {
    // 500 characters is a generous bug report; the env block must not be what
    // pushes a realistic message over the handler limit.
    const body = buildReportText({
      kind: 'bug', message: 'x'.repeat(500), includeEnv: true, env: ENV,
    });
    expect(mailtoTooLong(buildMailtoUrl(FEEDBACK_EMAIL, buildSubject('bug', '0.3.13'), body))).toBe(false);
  });
});

/** `makeNode` only builds shader/output nodes; groups and notes are their own types. */
const chromeNode = (id: string, type: 'group' | 'note'): AppNode =>
  ({ id, type, position: { x: 0, y: 0 }, data: { registryType: type, label: id, values: {} } } as unknown as AppNode);

const PROJECT: FeedbackProject = {
  nodes: 42, connected: 38, connections: 51, groups: 3, notes: 2,
  totalCost: 1830, headset: 'Meta Quest 3', budget: 200,
  geometry: 'sphere', mesh: null,
};

describe('feedbackReport — project counts', () => {
  it('counts shader nodes, connected ones, wires, groups and notes separately', () => {
    const nodes: AppNode[] = [
      makeNode('a', 'mul'), makeNode('b', 'add'), makeNode('c', 'sin'), makeNode('out', 'output'),
      chromeNode('g1', 'group'), chromeNode('n1', 'note'), chromeNode('n2', 'note'),
    ];
    const edges: AppEdge[] = [makeEdge('a', 'out', 'b', 'a'), makeEdge('b', 'out', 'out', 'color')];
    expect(countProject(nodes, edges)).toEqual({
      nodes: 4, connected: 3, connections: 2, groups: 1, notes: 2,
    });
  });

  it('an empty canvas reports zeroes rather than throwing', () => {
    expect(countProject([], [])).toEqual({ nodes: 0, connected: 0, connections: 0, groups: 0, notes: 0 });
  });

  it('counts each node once however many wires it carries', () => {
    const nodes: AppNode[] = [makeNode('a', 'mul'), makeNode('b', 'add'), makeNode('c', 'sin')];
    const edges: AppEdge[] = [
      makeEdge('a', 'out', 'b', 'a'), makeEdge('a', 'out', 'c', 'a'), makeEdge('b', 'out', 'c', 'b'),
    ];
    const r = countProject(nodes, edges);
    expect(r.connected).toBe(3);
    expect(r.connections).toBe(3);
  });

  it('renders graph, cost and geometry rows, flagging an over-budget shader', () => {
    const joined = envLines(ENV, PROJECT).join('\n');
    expect(joined).toContain('42 nodes (38 connected) · 51 connections · 3 groups · 2 notes');
    expect(joined).toContain('1,830 / 200 pts · Meta Quest 3 · OVER BUDGET');
    expect(joined).toContain('sphere (built-in)');
  });

  it('omits the group/note tail when there are none, and OVER BUDGET when within', () => {
    const joined = envLines(ENV, {
      ...PROJECT, groups: 0, notes: 0, totalCost: 120, budget: 200,
    }).join('\n');
    expect(joined).toContain('42 nodes (38 connected) · 51 connections\n');
    expect(joined).not.toContain('groups');
    expect(joined).not.toContain('OVER BUDGET');
  });

  it('reports a custom mesh by name, vertex count and size', () => {
    const joined = envLines(ENV, {
      ...PROJECT, geometry: 'custom',
      mesh: { name: 'statue.glb', bytes: 4_404_019, vertices: 148_732 },
    }).join('\n');
    expect(joined).toContain('statue.glb · 148,732 vertices · 4.2 MB');
  });

  it('says so plainly when the vertex count could not be derived', () => {
    const joined = envLines(ENV, {
      ...PROJECT, geometry: 'custom',
      mesh: { name: 'statue.glb', bytes: 2048, vertices: null },
    }).join('\n');
    expect(joined).toContain('statue.glb · vertex count unavailable · 2.0 KB');
  });

  it('project rows are dropped entirely when no project is passed', () => {
    const joined = envLines(ENV).join('\n');
    expect(joined).not.toContain('Graph:');
    expect(joined).not.toContain('Cost:');
    expect(joined).not.toContain('Mesh:');
  });

  it('project rows ride the same include-technical-details switch', () => {
    const off = buildReportText({ kind: 'bug', message: 'x', includeEnv: false, env: ENV, project: PROJECT });
    expect(off).toBe('x');
    const on = buildReportText({ kind: 'bug', message: 'x', includeEnv: true, env: ENV, project: PROJECT });
    expect(on).toContain('42 nodes');
  });

  it('the fuller block still fits a realistic message inside the mailto limit', () => {
    const body = buildReportText({
      kind: 'bug', message: 'x'.repeat(500), includeEnv: true, env: ENV,
      project: { ...PROJECT, geometry: 'custom', mesh: { name: 'statue.glb', bytes: 4_404_019, vertices: 148_732 } },
    });
    expect(mailtoTooLong(buildMailtoUrl(FEEDBACK_EMAIL, buildSubject('bug', '0.3.13'), body))).toBe(false);
  });

  it('formats byte sizes at a readable unit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(4_404_019)).toBe('4.2 MB');
  });
});

describe('feedbackReport — preview backend', () => {
  it('names the forced-WebGL2 reason per platform', () => {
    expect(previewBackend(UA_CASES[0].ua, 'iPhone', 5, true)).toContain('iOS WebKit');
    expect(previewBackend(UA_CASES[2].ua, 'MacIntel', 5, true)).toContain('iPadOS');
    expect(previewBackend(UA_CASES[3].ua, 'MacIntel', 0, true)).toContain('Safari/WebKit');
  });

  it('reports WebGL2 on a Chromium build with no navigator.gpu', () => {
    expect(previewBackend(UA_CASES[4].ua, 'MacIntel', 0, false)).toBe('WebGL2 (no navigator.gpu)');
  });

  it('reports WebGPU-pending on a Chromium build that exposes navigator.gpu', () => {
    expect(previewBackend(UA_CASES[4].ua, 'MacIntel', 0, true)).toContain('WebGPU');
  });

  it('reports the preview GLSL toggle, but only below the platform rules', () => {
    // Chromium with WebGPU: the toggle is the operative cause.
    expect(previewBackend(UA_CASES[4].ua, 'MacIntel', 0, true, true))
      .toBe('WebGL2 (forced — preview GLSL toggle)');
    // Safari forces regardless of the toggle — the platform reason keeps
    // naming the more fundamental cause.
    expect(previewBackend(UA_CASES[3].ua, 'MacIntel', 0, true, true)).toContain('Safari/WebKit');
  });

  /**
   * DRIFT GUARD. `previewBackend` restates the rule that
   * `tslToPreviewHTML` emits as source text into the preview iframe
   * (`__fsForceWebGL2`). The emitted copy cannot be imported, so instead we
   * pull it out of the generated HTML, evaluate it against the same UA table,
   * and require both to agree. Change the rule in one file and this fails.
   */
  it('agrees with the __fsForceWebGL2 rule emitted into the preview iframe', () => {
    const html = tslToPreviewHTML(
      "import { Fn, vec3 } from 'three/tsl';\nconst s = Fn(() => vec3(1,0,0));\nexport default s;\n",
      { geometry: 'sphere' },
    );
    const start = html.indexOf('function __fsForceWebGL2() {');
    expect(start, 'emitted preview no longer defines __fsForceWebGL2').toBeGreaterThan(-1);
    const end = html.indexOf('\n    }', start);
    expect(end).toBeGreaterThan(start);
    const src = html.slice(start, end + '\n    }'.length);

    const emitted = new Function('navigator', `${src}\nreturn __fsForceWebGL2();`) as (
      nav: { userAgent: string; platform: string; maxTouchPoints: number },
    ) => boolean;

    for (const c of UA_CASES) {
      const iframeForces = emitted({ userAgent: c.ua, platform: c.platform, maxTouchPoints: c.touch });
      expect(iframeForces, `iframe rule disagrees with the fixture for ${c.name}`).toBe(c.forced);
      const reported = previewBackend(c.ua, c.platform, c.touch, true).startsWith('WebGL2');
      expect(reported, `feedback report disagrees with the iframe for ${c.name}`).toBe(iframeForces);
    }
  });
});
