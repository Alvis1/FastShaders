/**
 * The intro window's "What is a shader?" tab: its words, its links, its three
 * drawn spheres, and how the intro shows it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import lv from '@/i18n/lv.json';
import { TUTORIALS } from '@/tutorials/tutorialDefs';
import {
  COST_PARAGRAPH,
  FIRST_LESSON_TITLE,
  LESSONS_TAB_LABEL,
  NEXT_STEP,
  SHADER_LINKS,
  START_LABEL,
  explainerKeys,
  explainerParagraphs,
} from './shaderExplainerText';
import {
  CX,
  CY,
  LIGHT_ANGLE,
  LIT_CENTRE,
  ONE_COLOR,
  R,
  SPHERE_PATHS,
  STRIPE_DARK,
  STRIPE_LIGHT,
  VIEW,
  WAVE_AMPLITUDE,
  circleOutline,
  crescentPath,
  outlinePath,
  stripeBands,
  wavyOutline,
  type Outline,
} from './shaderFigure';

const UI = lv.ui as Record<string, string>;
const src = (rel: string) => readFileSync(path.join(__dirname, '..', rel), 'utf8');

/** The x,y pairs of a path made of M/L points (the sampled ones). */
const points = (d: string) =>
  [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));

describe('the words', () => {
  it('every string the window prints has its Latvian', () => {
    for (const k of explainerKeys()) expect(UI[k], k).toBeTruthy();
  });

  it('leaves the points paragraph out wherever the budget slide is left out', () => {
    expect(explainerParagraphs(true)).toContain(COST_PARAGRAPH);
    expect(explainerParagraphs(false)).not.toContain(COST_PARAGRAPH);
    expect(explainerParagraphs(true)).toHaveLength(explainerParagraphs(false).length + 1);
    // ("a corner point" in the first paragraph is a vertex, not a price.)
    for (const p of explainerParagraphs(false)) {
      expect(p).not.toMatch(/\b(points|budget|cost)\b/i);
      expect(UI[p]).not.toMatch(/punkt|budžet|izmaks/i);
    }
  });

  it('names the Start button, the lessons tab and the first lesson as the app labels them', () => {
    expect(FIRST_LESSON_TITLE).toBe(TUTORIALS[0].title);
    expect(src('intro/IntroWindow.tsx')).toContain(`t('${START_LABEL}', language)`);
    expect(src('components/NodeEditor/ContentBrowser.tsx')).toContain(`t('${LESSONS_TAB_LABEL}', language)`);
    for (const slot of ['{start}', '{tab}', '{lesson}']) {
      expect(NEXT_STEP).toContain(slot);
      expect(UI[NEXT_STEP]).toContain(slot);
    }
  });
});

describe('the reading links', () => {
  it('are https, and each address once', () => {
    const urls = SHADER_LINKS.map((l) => l.url);
    for (const u of urls) expect(new URL(u).protocol, u).toBe('https:');
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('send TSL readers to the page README.md links', () => {
    const readme = readFileSync(path.join(__dirname, '../../README.md'), 'utf8');
    const tsl = SHADER_LINKS.find((l) => l.title.includes('TSL'));
    expect(tsl).toBeDefined();
    expect(readme).toContain(`(${tsl!.url})`);
  });
});

describe('the three spheres', () => {
  const all = [SPHERE_PATHS.circleShadow, SPHERE_PATHS.wavy, SPHERE_PATHS.wavyShadow, ...SPHERE_PATHS.darkStripes];

  it('every number is finite and inside the 96-unit box', () => {
    for (const d of all) {
      expect(d).not.toMatch(/NaN|Infinity/);
      for (const n of (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)) {
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(VIEW);
      }
    }
  });

  it('the moved surface stays within R·(1 ± 0.08) and reaches both ends', () => {
    const radii = points(outlinePath(wavyOutline)).map((p) => Math.hypot(p.x - CX, p.y - CY));
    const tol = 0.01;
    for (const r of radii) {
      expect(r).toBeGreaterThanOrEqual(R * (1 - WAVE_AMPLITUDE) - tol);
      expect(r).toBeLessThanOrEqual(R * (1 + WAVE_AMPLITUDE) + tol);
    }
    expect(Math.min(...radii)).toBeCloseTo(R * (1 - WAVE_AMPLITUDE), 1);
    expect(Math.max(...radii)).toBeCloseTo(R * (1 + WAVE_AMPLITUDE), 1);
  });

  it('eight bands run edge to edge, pole to pole, alternating', () => {
    const bands = stripeBands();
    expect(bands).toHaveLength(8);
    expect(bands[0].from).toBe(-90);
    expect(bands[bands.length - 1].to).toBe(90);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i].from).toBe(bands[i - 1].to);
      expect(bands[i].dark).toBe(!bands[i - 1].dark);
    }
    for (const b of bands) {
      // From the top pole, down one meridian and back up the next.
      expect(b.d.startsWith(`M${CX},${CY - R}`)).toBe(true);
      expect(b.d).toContain(`${CX},${CY + R}`);
      expect(b.d.endsWith(`${CX},${CY - R}Z`)).toBe(true);
    }
    expect(SPHERE_PATHS.darkStripes).toHaveLength(4);
  });

  it.each([
    ['round', circleOutline],
    ['moved', wavyOutline],
  ] as [string, Outline][])('the %s shadow is the shape minus the lit disc, on the side away from the light', (_, outline) => {
    const pts = points(crescentPath(outline));
    expect(pts.length).toBeGreaterThan(20);
    // A tip is interpolated between two steps of a curve that bends hard on
    // the moved outline: a few hundredths of a unit, far below a pixel.
    const tol = 0.05;
    for (const p of pts) {
      const theta = Math.atan2(p.y - CY, p.x - CX);
      expect(Math.hypot(p.x - CX, p.y - CY)).toBeLessThanOrEqual(outline(theta) + tol);
      expect(Math.hypot(p.x - LIT_CENTRE.x, p.y - LIT_CENTRE.y)).toBeGreaterThanOrEqual(R - tol);
    }
    const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length - CX;
    const my = pts.reduce((s, p) => s + p.y, 0) / pts.length - CY;
    expect(mx * Math.cos(LIGHT_ANGLE) + my * Math.sin(LIGHT_ANGLE)).toBeLessThan(0);
  });

  it('wear the colours of the lessons the next step points to: One Color, then Stripes', () => {
    const lesson = (id: string) => TUTORIALS.find((d) => d.id === id)!;
    const paint = lesson('tut-solid').steps.find((s) => s.kind === 'add' && s.type === 'color');
    expect(paint && 'values' in paint ? paint.values?.hex : undefined).toBe(ONE_COLOR);
    const ramp = lesson('tut-stripes').steps.find((s) => s.kind === 'add' && s.type === 'colorRamp');
    const stops = String(ramp && 'values' in ramp ? ramp.values?.stops : '');
    expect(stops.match(/#[0-9a-f]{6}/g)).toEqual([STRIPE_DARK, STRIPE_LIGHT]);
  });
});

describe('the tab in the intro window (source pins)', () => {
  const win = src('intro/IntroWindow.tsx');
  const page = src('intro/ShaderTab.tsx');

  it('is the third page, and scrolls inside the Intro page\'s height like Keys', () => {
    expect(win).toContain("{ id: 'shader', label: EXPLAINER_TITLE },");
    expect(win).toContain('<ShaderTab language={language} showCost={showCost} />');
    expect(win).toContain("style={tab !== 'intro' && pageHeight ? { height: pageHeight } : undefined}");
    // The points paragraph follows the budget slide's rule.
    expect(win).toContain('const showCost = !study || introShowsBudget(evalTask());');
  });

  it('logs nothing itself: IntroWindow logs the tab switch in a study session', () => {
    expect(page).not.toContain('evalLog' + '(');
  });

  it('safe links on the web, copyable addresses on desktop', () => {
    expect(page).toContain('target="_blank" rel="noreferrer noopener"');
    expect(page).toMatch(/if \(__FS_DESKTOP__\) \{[\s\S]*?<code className="fs-explainer__url">/);
  });

  it('the chosen tab and its page are one shape: one background, one line, nothing between them', () => {
    const css = src('intro/IntroWindow.css');
    const rule = (sel: string) => css.match(new RegExp(`\\n${sel.replace(/\./g, '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';
    const tab = rule('.fs-intro__tab');
    const on = rule('.fs-intro__tab.fs-intro__tab--on');
    const page = rule('.fs-intro__page');
    expect(tab).toContain('font-size: 20px;');
    // The page's line runs round the chosen tab; the tab covers the page's
    // top line under it, in the page's own background.
    expect(page).toContain('border: 2px solid var(--border-strong);');
    expect(on).toContain('border: 2px solid var(--border-strong);');
    expect(on).toContain('border-bottom: none;');
    expect(on).toContain('bottom: -2px;');
    expect(on).toContain('background: var(--bg-panel);');
    expect(on).toContain('font-weight: 700;');
    // The panel is the page's background: the page sets none of its own.
    expect(page).not.toMatch(/background/);
  });

  it('the asset bar\'s tabs are the same shape: the chosen one in its strip\'s colour, inside one line', () => {
    const css = src('components/NodeEditor/ContentBrowser.css');
    const on = css.match(/\n\.content-browser__cat-btn--active \{([^}]*)\}/)?.[1] ?? '';
    expect(on).toContain('border: 2px solid var(--border-strong);');
    expect(on).toContain('border-bottom: none;');
    expect(on).toContain('margin-bottom: 0;');
    // The row's line is painted inside the row, where a tab can cover it.
    expect(css).toMatch(/\.content-browser__categories \{[^}]*linear-gradient\(var\(--border-strong\), var\(--border-strong\)\) bottom \/ 100% 2px no-repeat/);
    // The chosen tab's colour is the strip's tint, laid over the same base.
    const tsx = src('components/NodeEditor/ContentBrowser.tsx');
    expect(tsx).toContain('background: stripTint(activeCategory !== \'all\' ? CAT_HEX[activeCategory] : undefined),');
    expect(tsx).toContain('`linear-gradient(${tint}, ${tint}), var(--bg-raised)`');
    expect(css).toMatch(/\n\.content-browser \{[^}]*background: var\(--bg-raised\);/);
  });

  it('the code panel\'s tabs are the same shape: the chosen one in the editor\'s colour, inside one line', () => {
    const css = src('components/CodeEditor/CodeEditor.css');
    const rule = (sel: string) => css.match(new RegExp(`(?:^|\\n)${sel.replace(/\./g, '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';
    const tab = rule('.code-editor__tab');
    const on = rule('.code-editor__tab--active');
    // The others stand on the bar's line; the chosen one covers it, taller.
    expect(tab).toContain('margin-bottom: 2px;');
    expect(tab).toContain('border-bottom: none;');
    expect(on).toContain('border: 2px solid var(--border-strong);');
    expect(on).toContain('border-bottom: none;');
    expect(on).toContain('margin-bottom: 0;');
    expect(on).toContain('height: calc(var(--ctl-size) + 5px);');
    expect(on).toContain('font-weight: 700;');
    // In Monaco's own background, in both themes (vs / vs-dark).
    expect(on).toContain('background: var(--code-editor-page);');
    expect(rule('.code-editor')).toContain('--code-editor-page: #fffffe;');
    expect(css).toMatch(/:root\[data-theme="dark"\] \.code-editor \{\s*--code-editor-page: #1e1e1e;/);
    // The bar's line is painted inside the bar, where the chosen tab can cover it.
    expect(rule('.code-editor__tabbar')).toMatch(/linear-gradient\(var\(--border-strong\), var\(--border-strong\)\) bottom \/ 100% 2px no-repeat/);
    // The bar stays 37px (4 + the chosen tab), the number SplitPane's floor is built on.
    expect(rule('.code-editor__tabbar')).toContain('padding: 4px var(--space-2) 0;');
    expect(src('components/Layout/SplitPane.tsx')).toContain('const CROSS_MIN_PANE_PX = 41;');
    // Every tab reserves its bold width.
    const tsx = src('components/CodeEditor/CodeEditor.tsx');
    for (const label of ['TSL', 'A-Frame', 'Three.js']) expect(tsx).toContain(`data-label="${label}"`);
  });
});
