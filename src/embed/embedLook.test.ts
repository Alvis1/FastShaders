/**
 * How an embedded FastShaders looks (embed/embedLook.ts, protocol 3): the
 * host's 3D view shows through the page, the canvas backdrop covers it at the
 * host's opacity, and the theme is the host's. The pure rules are tested here;
 * the wiring that keeps them EMBEDDED-ONLY is pinned on the source, like
 * embedBridge.test.ts does: a full FastShaders page must look exactly as it
 * did.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EMBED_CANVAS_ALPHA_VAR, EMBED_ROOT_CLASS, canvasBackground, embedCanvasAlpha, hostTheme } from './embedLook';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const decomment = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('the embedded look, as rules', () => {
  it('is a leaf: NodeEditor and AppLayout read it without the bridge chunk', () => {
    expect(read('./embedLook.ts')).not.toMatch(/^\s*import\s/m);
    expect(EMBED_ROOT_CLASS).toBe('fs-embed');
    expect(EMBED_CANVAS_ALPHA_VAR).toBe('--fs-embed-canvas-alpha');
  });

  it('the canvas backdrop is the colour itself on a full page, and the host\'s share of it embedded', () => {
    expect(canvasBackground('#41454d', false)).toBe('#41454d');
    // Opaque until the host says: an unset property reads 100%.
    expect(canvasBackground('#41454d', true)).toBe('color-mix(in srgb, #41454d var(--fs-embed-canvas-alpha, 100%), transparent)');
    expect(canvasBackground('#FAFAFA', true)).toContain(`var(${EMBED_CANVAS_ALPHA_VAR}, 100%)`);
  });

  it('canvasOpacity becomes a percentage, clamped to 0–1', () => {
    expect(embedCanvasAlpha(0.2)).toBe('20%');
    expect(embedCanvasAlpha(0)).toBe('0%');
    expect(embedCanvasAlpha(1)).toBe('100%');
    expect(embedCanvasAlpha(0.07)).toBe('7%'); // not 7.000000000000001%
    expect(embedCanvasAlpha(0.57)).toBe('57%');
    expect(embedCanvasAlpha(1 / 3)).toBe('33.33%');
    expect(embedCanvasAlpha(1.5)).toBe('100%');
    expect(embedCanvasAlpha(-0.3)).toBe('0%');
    expect(embedCanvasAlpha(-0)).toBe('0%');
    expect(embedCanvasAlpha(Number.MAX_VALUE)).toBe('100%');
    expect(embedCanvasAlpha(Number.MIN_VALUE)).toBe('0%');
  });

  it('anything but a finite number is ignored, never coerced', () => {
    for (const bad of [NaN, Infinity, -Infinity, '0.5', '', null, undefined, {}, [], [0.5], true, { valueOf: () => 0.5 }, { toString: 1 }, Symbol('x'), 10n]) {
      expect(embedCanvasAlpha(bad), String(typeof bad)).toBeNull();
    }
  });

  it('the theme is "dark" or "light", exactly; anything else is ignored', () => {
    expect(hostTheme('dark')).toBe('vs-dark');
    expect(hostTheme('light')).toBe('vs');
    for (const bad of ['Dark', 'LIGHT', ' dark', 'vs-dark', 'vs', '', 'auto', null, undefined, 1, true, {}, ['dark'], { toString: () => 'dark' }]) {
      expect(hostTheme(bad), String(bad)).toBeNull();
    }
  });
});

describe('the embedded look, wired for the embed alone', () => {
  it('EmbeddedLayout sets the class on <html> before its first paint and takes it away again; nothing else does', () => {
    const layout = read('../components/Layout/AppLayout.tsx');
    const embedded = layout.match(/function EmbeddedLayout\(\) \{[\s\S]*?\n\}/)![0];
    expect(embedded).toMatch(/useLayoutEffect\(\(\) => \{\s*const root = document\.documentElement;\s*root\.classList\.add\(EMBED_ROOT_CLASS\);\s*return \(\) => root\.classList\.remove\(EMBED_ROOT_CLASS\);\s*\}, \[\]\);/);
    const full = layout.match(/function FullLayout\(\) \{[\s\S]*?\n\}/)![0];
    expect(full).not.toContain('EMBED_ROOT_CLASS');
    // The one switch decides which layout mounts (embedBridge.test.ts pins it too).
    expect(layout).toMatch(/isEmbedMode\(\) \? <EmbeddedLayout \/> : <FullLayout \/>/);
  });

  it('every rule that clears a background is under html.fs-embed, and none guesses with :has()', () => {
    const css = decomment(read('../components/Layout/AppLayout.css'));
    expect(css).not.toContain(':has(');
    // <html> is painted INLINE by index.html's pre-paint script: only !important outranks it.
    expect(css).toMatch(/html\.fs-embed \{\s*background: transparent !important;\s*\}/);
    const rule = css.match(/((?:html\.fs-embed [^,{]+,\s*)+html\.fs-embed [^,{]+)\{\s*background: transparent;\s*\}/);
    expect(rule, 'the clear rule for the canvas\'s ancestors').not.toBeNull();
    const selectors = rule![1].split(',').map((s) => s.trim());
    for (const s of ['body', '#root', '.app-layout--embed', '.node-editor', '.react-flow__pane', '.react-flow__renderer', '.react-flow__background']) {
      expect(selectors, s).toContain(`html.fs-embed ${s}`);
    }
    // Nothing transparent outside the embed: a full page keeps every background.
    for (const m of css.matchAll(/([^{}]+)\{[^}]*background:\s*transparent/g)) {
      for (const sel of m[1].split(',')) expect(sel.trim(), 'an unscoped clear').toMatch(/^html\.fs-embed\b/);
    }
  });

  it('the canvas backdrop goes through canvasBackground, embedded only by the one switch', () => {
    const editor = read('../components/NodeEditor/NodeEditor.tsx');
    expect(editor.includes("import { canvasBackground } from '@/embed/embedLook';"), 'the import').toBe(true);
    // The React Flow root's props, up to the element's own `>`: the backdrop.
    const flow = editor.slice(editor.indexOf('<ReactFlow\n'), editor.indexOf('<Background', editor.indexOf('<ReactFlow\n')));
    expect(flow.includes('style={{ background: canvasBackground(nodeEditorBgColor, isEmbedMode()) }}'), 'the backdrop').toBe(true);
    expect(flow.match(/\bstyle=\{/g), 'one style on the root').toHaveLength(1);
    // The canvas bar's swatch keeps showing the colour itself: it is a sample, not the backdrop.
    expect(editor, 'the swatch').toMatch(/className="node-editor__bg-color-swatch"\s+style=\{\{ background: nodeEditorBgColor \}\}/);
  });

  it('the opacity property is set by the host\'s appearance message alone, and read by the backdrop alone', () => {
    // Every mention, in code, styles or the page — not only a `setProperty`
    // call: a CSS default or a React style object would set it too, and the
    // canvas would no longer be opaque until the host says otherwise.
    const mentions: string[] = [];
    const walk = (rel: string) => {
      const dir = fileURLToPath(new URL(rel, import.meta.url));
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(`${rel}${entry.name}/`);
        else if (/\.(tsx?|css|html)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
          const src = readFileSync(`${dir}${entry.name}`, 'utf8');
          if (/--fs-embed-canvas-alpha|EMBED_CANVAS_ALPHA_VAR/.test(src)) mentions.push(`${rel}${entry.name}`);
        }
      }
    };
    walk('../');
    expect(mentions.sort()).toEqual(['../embed/EmbedBridge.tsx', '../embed/embedLook.ts']);
    expect(read('../../index.html')).not.toContain('--fs-embed-canvas-alpha');
    // The bridge sets it, once; the leaf names it and reads it, with 100% for unset.
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code(read('./EmbedBridge.tsx')).match(/[^\n]*EMBED_CANVAS_ALPHA_VAR[^\n]*/g)!.map((l) => l.trim())).toEqual([
      "import { EMBED_CANVAS_ALPHA_VAR, embedCanvasAlpha, hostTheme } from './embedLook';",
      'if (alpha !== null) document.documentElement.style.setProperty(EMBED_CANVAS_ALPHA_VAR, alpha);',
    ]);
    expect(code(read('./embedLook.ts')).match(/[^\n]*(EMBED_CANVAS_ALPHA_VAR|--fs-embed-canvas-alpha)[^\n]*/g)!.map((l) => l.trim())).toEqual([
      "export const EMBED_CANVAS_ALPHA_VAR = '--fs-embed-canvas-alpha';",
      'return embedded ? `color-mix(in srgb, ${color} var(${EMBED_CANVAS_ALPHA_VAR}, 100%), transparent)` : color;',
    ]);
  });

  /**
   * A colour as both themes paint it: a literal `#rgb` / `#rrggbb`, or a
   * `var(--token)` resolved in tokens.css (the dark block over `:root`).
   * Null for anything else (an alpha, a gradient, a keyword).
   */
  const tokens = (() => {
    const css = decomment(read('../styles/tokens.css'));
    const block = (head: RegExp) => {
      const body = css.match(head)![1];
      return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()] as const));
    };
    return { light: block(/(?:^|\n):root \{([\s\S]*?)\n\}/), dark: block(/\n:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/) };
  })();
  const opaqueIn = (value: string, theme: 'light' | 'dark', depth = 0): boolean => {
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return true;
    const ref = value.match(/^var\((--[\w-]+)\)$/);
    if (!ref || depth > 4) return false;
    const next = (theme === 'dark' ? tokens.dark.get(ref[1]) : undefined) ?? tokens.light.get(ref[1]);
    return next !== undefined && opaqueIn(next, theme, depth + 1);
  };

  it('every plate on the canvas paints its own OPAQUE background, so it stays opaque over a see-through page', () => {
    // These plates sit over the canvas or beside it; embedded, nothing behind
    // them is opaque any more, so one that only LOOKED opaque because the page
    // painted behind it would show the host's 3D view through. Every dialog
    // panel is `.csv-import-modal__panel` (ShaderImportModal and the rest
    // compose it).
    const plates: Array<[file: string, selector: string]> = [
      ['../components/NodeEditor/ContentBrowser.css', '.content-browser'],
      ['../components/NodeEditor/NodeEditor.css', '.node-editor .fs-canvas-bar'],
      ['../components/NodeEditor/NodeEditor.css', '.node-editor__new-btn'],
      ['../components/NodeEditor/NodeEditor.css', '.node-editor__import-btn'],
      ['../components/NodeEditor/NodeEditor.css', '.node-editor__cost-overlay .cost-bar'],
      ['../components/NodeEditor/NodeEditor.css', '.node-editor__import-note'],
      ['../components/NodeEditor/menus/ContextMenu.css', '.context-menu'],
      ['../components/Modals/CsvImportModal.css', '.csv-import-modal__panel'],
      ['../components/Tooltip/TooltipLayer.css', '.fs-tooltip'],
      ['../components/NodeEditor/AssetTooltip.css', '.asset-tooltip'],
      ['../components/inputs/PaletteColorPicker.css', '.palette-pop'],
      ['../components/NodeEditor/edges/EdgeInfoCard.css', '.edge-info-card'],
      ['../tutorials/TutorialPanel.css', '.tutorial-panel'],
    ];
    for (const [file, selector] of plates) {
      const css = decomment(read(file));
      const at = css.search(new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`));
      expect(at, `${selector} in ${file}`).toBeGreaterThan(-1);
      const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
      const paint = body.match(/\bbackground:\s*([^;]+);/);
      expect(paint, `${selector} paints its own background`).not.toBeNull();
      for (const theme of ['light', 'dark'] as const) {
        expect(opaqueIn(paint![1].trim(), theme), `${selector}'s ${paint![1]} in the ${theme} theme`).toBe(true);
      }
    }
  });

  it('every node card paints its own opaque body: --node-bg in both themes, or the colour it shows', () => {
    // Inline, on the card element (ShaderNode and the rest set it in their
    // style object). A group is a translucent frame on any page by design.
    const cards: Record<string, string> = {
      ShaderNode: "background: 'var(--node-bg)'",
      PreviewNode: "background: 'var(--node-bg)'",
      MathPreviewNode: "background: 'var(--node-bg)'",
      ClockNode: "background: 'var(--node-bg)'",
      SoundNode: "background: 'var(--node-bg)'",
      OutputNode: "background: 'var(--node-bg)'",
      RaymarchOutputNode: "background: 'var(--node-bg)'",
      SplatOutputNode: "background: 'var(--node-bg)'",
      ColorNode: 'background: hex',
      NoteNode: 'background: bodyColor',
    };
    const registry = read('../components/NodeEditor/flowTypes.ts');
    const registered = [...registry.matchAll(/^ {2}\w+: (\w+Node),$/gm)].map((m) => m[1]);
    expect(registered.sort()).toEqual([...Object.keys(cards), 'GroupNode'].sort());
    for (const [card, paint] of Object.entries(cards)) {
      expect(read(`../components/NodeEditor/nodes/${card}.tsx`), card).toContain(paint);
    }
    for (const theme of ['light', 'dark'] as const) expect(opaqueIn('var(--node-bg)', theme), theme).toBe(true);
  });
});
