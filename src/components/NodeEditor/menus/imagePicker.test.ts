/**
 * The texture picker (GLB Phase 4 Step 6) — source pins, because the vitest
 * env is `node` and neither the menu nor the picker can be rendered. The pure
 * halves are RUN in utils/textureSources.test.ts and in
 * Modals/limitNoticeCopy.test.ts ('image-pick-cap'); these pins hold the
 * component to them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { t } from '@/i18n';
import { makeNode } from '@/test-utils';
import { imageCharsReplacing, MAX_TOTAL_IMAGE_CHARS, PROJECT_IMAGE_BUDGET_COUNT } from '@/utils/imageNode';
import { IMAGE_EMPTY_HINT, IMAGE_EMPTY_HINT_EVAL, imageEmptyHint } from '../nodes/ShaderNode';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const MENU = read('./ImageNodeSettings.tsx');
const PICKER = read('./TexturePicker.tsx');
const VIEW = read('./imageOriginView.ts');
const CSS = read('./ContextMenu.css');
const SHADER_NODE = read('../nodes/ShaderNode.tsx');
const NODE_VISUAL = read('../nodes/NodeVisual.tsx');
const SOURCES = read('../../../utils/textureSources.ts');

/** The source text between two markers (both must exist, in order). */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  expect(a, from).toBeGreaterThan(-1);
  expect(b, to).toBeGreaterThan(a);
  return src.slice(a, b);
}
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('pickTexture — one click, one undo entry', () => {
  const body = between(MENU, 'const pickTexture = ', 'const pickFile = ');

  it('writes exactly once and never awaits', () => {
    expect(count(body, 'updateNodeData(')).toBe(1);
    expect(body).not.toMatch(/\bawait\b/);
    expect(body).toMatch(/const next = pickTextureValues\(liveVals, src\);\s*if \(!next\) return;/);
  });

  it('re-reads the LIVE node (the menu can outlive it)', () => {
    expect(body).toMatch(/const live = store\.nodes\.find\(\(n\) => n\.id === nodeId\);/);
  });

  it('checks the project budget per instance, only when the pick GROWS the payload', () => {
    expect(body).toMatch(
      /!store\.ignoreImageLimits &&\s*src\.dataUrl\.length > currentUrl\.length &&\s*imageCharsReplacing\(store\.nodes, nodeId, src\.dataUrl\) > MAX_TOTAL_IMAGE_CHARS/,
    );
    expect(body).toContain("kind: 'image-pick-cap'");
    // Never the drop's notice: its "Add anyway" places a NEW node from a File.
    expect(body).not.toContain('image-total-cap');
  });

  it('switches on the source kind with a never default (Phase 5 must handle a new kind here)', () => {
    expect(body).toMatch(/switch \(src\.kind\) \{\s*case 'project':\s*break;\s*default: \{[\s\S]{0,200}?const unhandled: never = src\.kind;/);
  });
});

describe('the budget a pick is held to', () => {
  it('counts per INSTANCE, so picking an image the project already holds is not free', () => {
    // Owner default Q11 (compatibility with 0.3.33's per-instance import strip).
    expect(PROJECT_IMAGE_BUDGET_COUNT).toBe('instances');
    const big = 'data:image/png;base64,' + 'A'.repeat(1_600_000);
    const nodes = [
      makeNode('n1', 'imageNode', { imageB64: big, width: 8, height: 8 }),
      makeNode('n2', 'imageNode', { imageB64: 'data:image/png;base64,AAAA', width: 1, height: 1 }),
    ];
    expect(imageCharsReplacing(nodes, 'n2', big)).toBeGreaterThan(MAX_TOTAL_IMAGE_CHARS);
    expect(imageCharsReplacing(nodes, 'n2', big, 'unique')).toBeLessThan(MAX_TOTAL_IMAGE_CHARS);
  });
});

describe('"From file…" — the drop pipeline, into THIS node', () => {
  const body = between(MENU, 'async function fillImageNodeFromFile(', '/** Image-node section');

  it('runs the drop pipeline: encode, then the snap-only-with-its-stash rule', () => {
    expect(body).toContain('await encodeImageFile(file, ignore, deviceCap, mode)');
    expect(body).toMatch(/resolveImageDrop\(res, file\.name, \(p\) => stashImageOrigin\(p, Date\.now\(\)\)\)/);
  });

  it('re-reads the target node AFTER the await and writes it once (or not at all)', () => {
    const awaitAt = body.indexOf('await encodeImageFile(');
    const liveAt = body.indexOf('store.nodes.find((n) => n.id === targetId)');
    expect(liveAt).toBeGreaterThan(awaitAt);
    expect(count(body, 'updateNodeData(')).toBe(1);
    expect(body).toMatch(/store\.updateNodeData\(targetId, \{\s*values: withImagePayload\(liveVals,/);
  });

  it('holds a growing payload to the per-instance budget with the pick notice', () => {
    expect(body).toMatch(
      /!ignore &&\s*payload\.dataUrl\.length > currentUrl\.length &&\s*imageCharsReplacing\(store\.nodes, targetId, payload\.dataUrl\) > MAX_TOTAL_IMAGE_CHARS/,
    );
    expect(body).toContain("kind: 'image-pick-cap'");
  });

  it('a per-image refusal overrides through `proceed`, never through a File + drop point', () => {
    // A notice carrying `file` and `position` makes "Add anyway" place a NEW
    // node; this one must refill the node the file was chosen for.
    expect(body).toMatch(/proceed: \(\) => void fillImageNodeFromFile\(targetId, file, mode, true\)/);
    const notice = between(body, "kind: res.reason === 'pixels'", 'proceed:');
    expect(notice).not.toMatch(/^\s*(file|position)\s*[,:]/m);
  });

  it('announces what the drop announces (import note, device downscale)', () => {
    expect(body).toContain('store.showImageDropReports(undefined, [imageDropReport(res, payload, convertNote)])');
    expect(body).toContain("kind: 'image-device-downscaled'");
  });

  it('marks the import busy per node, so a MOVED menu does not show another node as busy', () => {
    expect(MENU).toMatch(/const \[importingFor, setImportingFor\] = useState<string \| null>\(null\);/);
    expect(MENU).toContain('const importing = importingFor === nodeId;');
    expect(MENU).toContain('setImportingFor((cur) => (cur === targetId ? null : cur))');
    const early = MENU.indexOf("if (!node || node.data.registryType !== 'imageNode') return null;");
    expect(MENU.indexOf('useState<string | null>(null);')).toBeLessThan(early);
  });
});

describe('the picker is settings-menu only, and hidden in study sessions', () => {
  it('is gated by isEvalMode and keyed by the node', () => {
    expect(MENU).toContain('const study = isEvalMode();');
    expect(MENU).toMatch(/\{!study && \(\s*<TexturePicker\s+key=\{nodeId\}/);
  });

  it('keeps the Step 5 keyed-original rules it relies on (imageOriginView.ts)', () => {
    // A pick changes or drops originId; these two are what keep a moved menu
    // or a pick from showing the previous original with Revert live.
    expect(VIEW).toContain('loaded && loaded.id === originId');
    expect(VIEW).toContain('return `${nodeId}|${originId}`;');
  });
});

describe('TexturePicker', () => {
  it('lists only what projectTextureSources vouched for, through the two-step selector', () => {
    expect(PICKER).toMatch(/useAppStore\(\(s\) => \(open \? textureSourcesKey\(s\.nodes\) : ''\)\)/);
    expect(PICKER).toContain('projectTextureSources(useAppStore.getState().nodes)');
    // The ONLY <img src> is the kind-switched thumbnail.
    expect(count(PICKER, 'src={')).toBe(1);
    expect(PICKER).toContain('<img src={thumbnailUrl(s)}');
    expect(PICKER).toMatch(/function thumbnailUrl\(src: TextureSource\): string \{\s*switch \(src\.kind\) \{\s*case 'project':\s*return src\.dataUrl;\s*default: \{[\s\S]{0,200}?const unhandled: never = src\.kind;/);
    expect(PICKER).toContain('MAX_LISTED_TEXTURE_SOURCES');
  });

  it('stays inside the menu: no portal, no colour input', () => {
    expect(PICKER).not.toContain('createPortal');
    expect(PICKER).not.toMatch(/type="color"/);
  });

  it('offers a file, re-armed after every choice', () => {
    expect(PICKER).toContain('accept="image/*"');
    expect(PICKER).toContain("e.target.value = '';");
  });

  it('routes the placeholder count through fillTemplate', () => {
    expect(PICKER).toMatch(/fillTemplate\(t\('More images than fit here: \{n\}', language\)/);
  });

  it('has a Latvian entry for every string it shows', () => {
    const keys = [...PICKER.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(8);
    for (const k of keys) expect(t(k, 'lv'), k).not.toBe(k);
  });

  it('keeps its grid in ContextMenu.css, a nested scroller under the nowheel shell', () => {
    const block = between(CSS, '.context-menu .context-menu__texture-grid {', '}');
    expect(block).toMatch(/overflow-y:\s*auto/);
    expect(CSS).toContain('.context-menu .context-menu__texture-cell');
  });
});

describe('the empty slot names the picker — except in a study session', () => {
  it('names the Texture row by the row’s own label, in both languages', () => {
    expect(PICKER).toContain("{t('Texture', language)}");
    expect(IMAGE_EMPTY_HINT).toContain('“Texture”');
    expect(t(IMAGE_EMPTY_HINT, 'lv')).toContain(`“${t('Texture', 'lv')}”`);
  });

  it('keeps the plain statement where the picker is hidden', () => {
    expect(imageEmptyHint(true)).toBe(IMAGE_EMPTY_HINT_EVAL);
    expect(imageEmptyHint(false)).toBe(IMAGE_EMPTY_HINT);
    expect(IMAGE_EMPTY_HINT_EVAL).not.toMatch(/Texture|Right-click/);
    expect(t(IMAGE_EMPTY_HINT_EVAL, 'lv')).not.toBe(IMAGE_EMPTY_HINT_EVAL);
    // Outside a study session (the node test env) the slot names the picker.
    expect(imageEmptyHint()).toBe(IMAGE_EMPTY_HINT);
  });

  it('ImageThumbEmpty defaults to imageEmptyHint(), so every canvas slot agrees', () => {
    expect(SHADER_NODE).toContain('hint = imageEmptyHint(),');
    expect(SHADER_NODE).toContain('title={t(hint, language)}');
    expect(SHADER_NODE).toMatch(/imageNode' && <ImageThumbEmpty language=\{language\} \/>/);
  });

  it('a replica keeps the plain statement: it has no menu to name', () => {
    // The Node Designer stage draws NodeVisual hit-testable and binds no
    // contextmenu, so following "Right-click the node…" there opens only the
    // browser's own menu. Same reason the study session keeps the plain text.
    expect(NODE_VISUAL).toMatch(/<ImageThumbEmpty language=\{language\} hint=\{IMAGE_EMPTY_HINT_EVAL\} \/>/);
  });
});

describe('textureSources.ts stays the one value shape', () => {
  it('a pick is withImagePayload behind the no-op check', () => {
    expect(SOURCES).toMatch(/if \(current\.imageB64 === src\.dataUrl\) return null;\s*return withImagePayload\(current, src\);/);
  });
});
