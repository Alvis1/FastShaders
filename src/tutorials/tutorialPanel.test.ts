/**
 * Source pins for the pieces of the Tutorials tab that live in other files or
 * are shaped by a rule a unit test cannot see: the panel is NOT a dialog (the
 * canvas must stay usable), nothing in the folder scrolls (canvasWheel's rule),
 * the browser gates the tab on the study flag through the pure helper, the
 * takeover records history unguarded, and the folder never logs telemetry or
 * reaches the parser.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('./', import.meta.url));
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (f: string) => readFileSync(f, 'utf8');
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('TutorialPanel is canvas chrome, not a dialog', () => {
  const src = codeOnly(read(HERE + 'TutorialPanel.tsx'));
  it('has no dialog role, no aria-modal, no modal key binding, no arrow keys', () => {
    expect(src).not.toMatch(/aria-modal/);
    expect(src).not.toMatch(/role="dialog"/);
    expect(src).not.toMatch(/useModalKeys/);
    expect(src).not.toMatch(/Arrow(Left|Right|Up|Down)/);
  });
  it('keeps plain keys pressed on its controls away from the canvas handlers', () => {
    expect(src).toMatch(/onKeyDown=\{keepKeys\}/);
    expect(src).toMatch(/if \(!e\.ctrlKey && !e\.metaKey && !e\.altKey\) e\.stopPropagation\(\);/);
  });
  it('frames an auto-added node through focusNodes, one frame later', () => {
    expect(src).toMatch(/requestAnimationFrame\(\(\) => \{[\s\S]*focusNodes\(fitView/);
  });
});

describe('nothing in src/tutorials scrolls, logs telemetry or reaches the parser', () => {
  const files = readdirSync(HERE).filter((f) => !f.endsWith('.test.ts') && !f.endsWith('.snap'));
  it('no stylesheet has a vertical scroller (canvasWheel.test.ts\'s rule, kept here since the folder is outside its sweep)', () => {
    for (const f of files.filter((f) => f.endsWith('.css'))) {
      expect(read(HERE + f), f).not.toMatch(/overflow(-y)?:\s*(auto|scroll)/);
    }
  });
  it('no module calls evalLog or imports a Babel-bearing module', () => {
    for (const f of files.filter((f) => /\.tsx?$/.test(f))) {
      const src = codeOnly(read(HERE + f));
      expect(src, f).not.toMatch(/\bevalLog\(/);
      expect(src, f).not.toMatch(/engine\/codeToGraph|engine\/scriptToTSL|registry\/codeGroupBuilder|registry\/builtinPresets|registry\/builtinTextures/);
    }
  });
});

describe('ContentBrowser carries the tab through the pure helpers', () => {
  const src = codeOnly(read(ROOT + 'components/NodeEditor/ContentBrowser.tsx'));
  it('offers the tab outside a study only, via tutorialsOffered(isEvalMode())', () => {
    expect(src).toMatch(/const OFFER_TUTORIALS = tutorialsOffered\(isEvalMode\(\)\);/);
    expect(src).toMatch(/effectiveBrowserTab\(effectiveTab\(\w+, \w+\), OFFER_TUTORIALS\)/);
  });
  it('keeps a stored tutorials tab valid, and draws its button right after All', () => {
    expect(src).toMatch(/'all', 'saved', TUTORIALS_TAB, \.\.\.displayCategories\.map/);
    const button = src.indexOf('pickTab(TUTORIALS_TAB)');
    const cats = src.indexOf('{visibleCategories.map(');
    expect(button).toBeGreaterThan(-1);
    expect(button).toBeLessThan(cats);
    expect(src).toMatch(/\{OFFER_TUTORIALS && \(/);
  });
  it('steers the strip with LOCAL state, never writing fs:assetTab for a lesson', () => {
    expect(src).toMatch(/const \[tutorialTab, setTutorialTab\] = useState/);
    expect(src).not.toMatch(/setActiveCategory\(cat\)/);
  });
});

describe('the palette tile and the store', () => {
  it('NodePreviewCard marks the wanted tile with an attribute read off the lesson', () => {
    const src = codeOnly(read(ROOT + 'components/NodeEditor/NodePreviewCard.tsx'));
    expect(src).toMatch(/wantedNodeType\(s\.tutorial\) === def\.type/);
    expect(src).toMatch(/data-fs-tutorial-want=/);
  });
  it('the takeover records history UNGUARDED and announces fs:graph-merged', () => {
    const src = codeOnly(read(ROOT + 'store/useAppStore.ts'));
    const fn = src.slice(src.indexOf('function tutorialTakeover('), src.indexOf('function announceTutorialTakeover('));
    expect(fn).toMatch(/\.\.\.recordHistory\(state\)/);
    expect(fn).not.toMatch(/pushHistory/);
    expect(src).toMatch(/function announceTutorialTakeover\(\): void \{[\s\S]*?new CustomEvent\('fs:graph-merged'\)/);
  });
  it('NodeEditor mounts the panel inside the canvas div', () => {
    const src = codeOnly(read(ROOT + 'components/NodeEditor/NodeEditor.tsx'));
    const panel = src.indexOf('<TutorialPanel />');
    expect(panel).toBeGreaterThan(src.indexOf('className={`node-editor__canvas'));
    expect(panel).toBeLessThan(src.indexOf('<ReactFlow\n'));
  });
});
