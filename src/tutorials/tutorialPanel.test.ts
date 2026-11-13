/**
 * Source pins for the pieces of the Tutorials tab that live in other files or
 * are shaped by a rule a unit test cannot see: the panel is NOT a dialog (the
 * canvas must stay usable), nothing in the folder scrolls (canvasWheel's rule),
 * the browser gates the tab on the study flag and entry through the pure
 * helper, the takeover records history unguarded, only the auto step logs
 * telemetry, and the folder never reaches the parser.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tutorialsOffered, offeredLessons } from './tutorialsTab';
import { TUTORIALS } from './tutorialDefs';

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
  it('only the auto step calls evalLog, and no module imports a Babel-bearing one', () => {
    for (const f of files.filter((f) => /\.tsx?$/.test(f))) {
      const src = codeOnly(read(HERE + f));
      if (f === 'tutorialAutoStep.ts') expect([...src.matchAll(/\bevalLog\('([\w-]+)'/g)].map((m) => m[1])).toEqual(['tutorial-auto']);
      else expect(src, f).not.toMatch(/\bevalLog\(/);
      expect(src, f).not.toMatch(/engine\/codeToGraph|engine\/scriptToTSL|registry\/codeGroupBuilder|registry\/builtinPresets|registry\/builtinTextures/);
    }
  });
});

describe('a step shows the socket labels of the nodes it is about', () => {
  const css = read(ROOT + 'components/NodeEditor/handles/TypedHandle.css');
  const rule = (selector: string) => {
    // The comma-separated selector list `selector` belongs to, and that rule's body.
    const at = css.indexOf(selector);
    expect(at, selector).toBeGreaterThan(-1);
    const open = css.indexOf('{', at);
    const start = css.lastIndexOf('}', at) + 1;
    return { selectors: css.slice(start, open), body: css.slice(open, css.indexOf('}', open)) };
  };
  it('through the label peek\'s OWN rule — one look, a second attribute', () => {
    const sockets = rule('.react-flow__node[data-fs-tutorial-labels] .typed-handle[data-tooltip]::after');
    expect(sockets.selectors).toContain('.react-flow__node[data-fs-labels-shown] .typed-handle[data-tooltip]::after');
    expect(sockets.body).toMatch(/opacity:\s*1/);
    // …and the Latvian name above the header, which the peek pins too.
    const header = rule('.react-flow__node[data-fs-tutorial-labels] [data-header-tip]::after');
    expect(header.selectors).toContain('.react-flow__node[data-fs-labels-shown] [data-header-tip]::after');
  });
  it('the highlighter marks wrappers with its own attribute, never the user\'s peek', () => {
    const src = codeOnly(read(HERE + 'tutorialHighlights.ts'));
    expect(src).toMatch(/TUTORIAL_LABELS_ATTR = 'data-fs-tutorial-labels'/);
    expect(src).toMatch(/for \(const id of targets\.labels\) mark\(nodeEl\(id\), TUTORIAL_LABELS_ATTR, ''\)/);
    // NodeEditor owns data-fs-labels-shown and removes it when the user's peek ends.
    expect(src).not.toMatch(/data-fs-labels-shown/);
  });
  it('a noise card shows its hidden sockets while a step wires into it', () => {
    const src = codeOnly(read(ROOT + 'components/NodeEditor/nodes/PreviewNode.tsx'));
    expect(src).toMatch(/const lessonTarget = useAppStore\(\(s\) => lessonRevealNode\(s\.tutorial\) === id\);/);
    expect(src).toMatch(/const revealHidden = wireNear \|\| lessonTarget;/);
  });
});

describe('a node added by hand during an add step is the lesson\'s node', () => {
  it('both add surfaces lay wantedNodeValues over the fresh values', () => {
    for (const f of ['components/NodeEditor/NodeEditor.tsx', 'components/NodeEditor/menus/AddNodeMenu.tsx']) {
      const src = codeOnly(read(ROOT + f));
      expect(src, f).toMatch(
        /\.\.\.initialNodeValues\(def, \w+\),\s*\.\.\.wantedNodeValues\(useAppStore\.getState\(\)\.tutorial, def\.type\),/,
      );
      // Never a bare fresh node on these two paths again.
      expect(src, f).not.toMatch(/const values = initialNodeValues\(/);
    }
  });
});

describe('tutorialsOffered: the study entries', () => {
  it('outside a study always; in one, on every entry', () => {
    expect(tutorialsOffered(false, null)).toBe(true);
    expect(tutorialsOffered(true, 'evalpro')).toBe(true);
    expect(tutorialsOffered(true, 'eval')).toBe(true);
    expect(tutorialsOffered(true, 'evalp')).toBe(true);
    // An older redirector recorded no entry: no tab.
    expect(tutorialsOffered(true, null)).toBe(false);
  });
  it('leaves out the cost lesson where the budget is not shown, and only it', () => {
    expect(offeredLessons(TUTORIALS, true)).toBe(TUTORIALS);
    const noBudget = offeredLessons(TUTORIALS, false);
    expect(TUTORIALS.filter((d) => !noBudget.includes(d)).map((d) => d.id)).toEqual(['tut-costs']);
    // Every other lesson's text names no cost: the /evalp condition shows none.
    for (const d of noBudget) expect(JSON.stringify(d), d.id).not.toMatch(/cost bar|\bpoints? (budget|cost)/i);
  });
});

describe('ContentBrowser carries the tab through the pure helpers', () => {
  const src = codeOnly(read(ROOT + 'components/NodeEditor/ContentBrowser.tsx'));
  it('offers the tab via tutorialsOffered(isEvalMode(), evalTask().arm), its lessons via offeredLessons', () => {
    expect(src).toMatch(/const OFFER_TUTORIALS = tutorialsOffered\(isEvalMode\(\), evalTask\(\)\.arm\);/);
    expect(src).toMatch(/const LESSONS = offeredLessons\(TUTORIALS, introShowsBudget\(evalTask\(\)\)\);/);
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
