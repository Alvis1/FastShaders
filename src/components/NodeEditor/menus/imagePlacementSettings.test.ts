/**
 * The Texture (Image) node's placement controls: ONE control per concept —
 * Tile X/Y and Offset X/Y, one Rotation, Flip X/Y — where the menu used to
 * carry a second Offset, Scale and Rotation and a "UV orientation" switch in a
 * "glTF mapping" fold-out (the owner: "why should i need two entries?"). A
 * transform an older FastShaders saved, that a restore could not fold into
 * those (utils/imagePlacement.ts), shows ONE "Older transform" line with Clear.
 *
 * No jsdom in this suite, so the menus are pinned by SOURCE text — the house
 * style for a React surface (imagePicker, previewChannelRow) — and the pure
 * writers the rows call are RUN.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, portLabel } from '@/i18n';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import {
  UV_MAPPING_KEYS,
  gltfTextureValues,
  readPictureRotation,
  withPictureRotation,
  withoutLegacyTransform,
  withUvMapping,
} from '@/utils/imageUvMapping';
import { readImagePlacement } from '@/utils/imagePlacement';
import { composeKhrTextureTransform } from '@/engine/glbExportPlan';
import { isRoundingOnlyCommit } from './ParamRow';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
/** Comments out: a pin on what the CODE does must neither be met nor broken by
 *  the prose around it. */
const code = (src: string) =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const IMAGE_MENU = read('./ImageNodeSettings.tsx');
const NODE_MENU = read('./NodeSettingsMenu.tsx');
const PARAM_ROW = read('./ParamRow.tsx');
const CODEGEN = read('../../../engine/graphToCode.ts');
const EXPORT = read('../../../engine/glbExportPlan.ts');
const SHADER_NODE = read('../nodes/ShaderNode.tsx');
const NODE_VISUAL = read('../nodes/NodeVisual.tsx');
const CARD = read('../NodePreviewCard.tsx');
const LV_UI = (JSON.parse(read('../../../i18n/lv.json')) as { ui: Record<string, string> }).ui;

/** The source text between two markers (both must exist, in order). */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + from.length);
  expect(a, from).toBeGreaterThan(-1);
  expect(b, to).toBeGreaterThan(a);
  return src.slice(a, b);
}
const count = (s: string, needle: string) => s.split(needle).length - 1;

/** What ImageNodeSettings renders: its `return (` JSX, comments out. */
const RENDER = (() => {
  const at = IMAGE_MENU.indexOf('\n  return (\n    <>');
  expect(at).toBeGreaterThan(-1);
  return code(IMAGE_MENU.slice(at));
})();

/** Every `{!study && …}` block of `jsx`, as [start, end), by brace matching
 *  from its own `{` — no string in this JSX holds a brace. */
function studyBlocks(jsx: string): [number, number][] {
  const out: [number, number][] = [];
  const re = /\{!study && /g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(jsx)) !== null) {
    let depth = 0;
    for (let i = m.index; i < jsx.length; i++) {
      if (jsx[i] === '{') depth++;
      else if (jsx[i] === '}' && --depth === 0) {
        out.push([m.index, i + 1]);
        break;
      }
    }
  }
  return out;
}

/** The JSX a study participant gets: every `{!study && …}` block removed. */
function studyVisible(jsx: string): string {
  let out = jsx;
  for (const [a, b] of studyBlocks(jsx).reverse()) out = out.slice(0, a) + out.slice(b);
  return out;
}

/** The `t('…')` / `t("…")` keys of `src`, in order. */
const tKeys = (src: string) =>
  [...src.matchAll(/\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)].map((m) => m[1] ?? m[2]);

/**
 * The Image rows a study participant saw BEFORE this change, in order — every
 * label, tooltip and option ImageNodeSettings rendered outside its
 * `{!study && …}` blocks (the texture picker and the glTF-mapping fold-out
 * were already study-hidden). The generic loop's Tile/Offset rows come before
 * these and are pinned separately.
 */
const STUDY_ROWS = [
  'Format',
  'Re-encode this image from the stored original at a smaller size. Lower resolution costs less GPU bandwidth.',
  'Resolution',
  'Re-encoding…',
  'original',
  'Resolution',
  'This node holds no image yet, so there is no resolution to change.',
  'Choosing a resolution needs the stored original, which lives on this device only.',
  'This image is too large for a copy of the original to be kept on this device, so its resolution cannot be changed without losing the way back.',
  'Size',
  'Repeat (tile the image)',
  'On: the image wraps/tiles. Off: edge pixels clamp beyond 0–1 UV.',
  'Flip X',
  'Mirror the image left–right',
  'Flip Y',
  'Mirror the image top–bottom',
  'Sample as linear data (normal/height maps) instead of sRGB color. Also restores the original image, since a resampled normal map has wrong normals.',
  'Data map (linear, no mipmaps)',
  'How the image fills in between its pixels. Linear blends neighbouring pixels for a smooth look; Nearest takes the closest pixel and keeps hard edges, for pixel art or a deliberately blocky look.',
  'Filtering',
  'Linear (smooth)',
  'Nearest (sharp pixels)',
  'Applies to every image you drop from now on, not just this one.',
  'Optimize on import',
  'Ask each time',
  'Always',
  'Never',
  'Original',
  'not on this device',
  'The image as imported, before the automatic power-of-two step or any resolution you have chosen — same EXIF strip and same device texture cap, not the raw source file.',
  'The pre-conversion copy is kept on this device only, so it is unavailable after sharing a project, in a different browser, or once it ages out of the cache.',
  'Put this image back to its original resolution',
  'Looking for the stored original…',
  'This image is already the original',
  'No stored original for this image',
  'Revert to original',
  'already original',
  'unavailable',
];

/** three.js's and glTF's sign, and which way it reads per shape: counter-
 *  clockwise on the built-in shapes, the Bunny included since its generated
 *  UVs became three's SphereGeometry parameterization, and clockwise on a
 *  model (engine/imageRotation.test.ts measures both senses, and the tile's sign). */
const ROTATION_TIP =
  'Turns the picture about its own centre. A positive angle turns it counter-clockwise on the Sphere, Plane, Cube, Teapot and Bunny, and clockwise on most imported models — the sign three.js and glTF use (with positive Tile X and Tile Y). With different Tile X and Tile Y the turned picture is stretched along the surface, as in glTF.';
const OLDER_TIP =
  'A transform saved by an earlier FastShaders that Tile, Offset and Rotation cannot express. It still applies. Clearing it changes the picture.';

describe('a study session keeps today’s menu', () => {
  it('the generic loop skips the Image node’s rows ONLY outside a study session', () => {
    expect(NODE_MENU).toContain("import { isEvalMode } from '@/eval/evalMode';");
    expect(NODE_MENU).toContain('const imageOwnsParamRows = imageNode && !isEvalMode();');
    expect(NODE_MENU).toMatch(
      /\{def\?\.defaultValues &&\s*!imageOwnsParamRows &&\s*Object\.keys\(def\.defaultValues\)\.map\(\(key\) => <ParamRow key=\{key\} nodeId=\{nodeId\} paramKey=\{key\} \/>\)\}/,
    );
    // …and with no `label`, a row prints its raw key, as these always have.
    expect(PARAM_ROW).toContain('{label ?? paramKey}');
  });

  it('the socket-only rows (UV, Direction) keep their socket names', () => {
    expect(NODE_MENU).toContain('<ParamRow key={inp.id} nodeId={nodeId} paramKey={inp.id} label={portLabel(inp.label, language)} />');
  });

  it('ImageNodeSettings shows a participant exactly the rows it showed before, in that order', () => {
    expect(IMAGE_MENU).toContain('const study = isEvalMode();');
    expect(tKeys(studyVisible(RENDER))).toEqual(STUDY_ROWS);
    // The new rows draw nothing a participant sees, ParamRows included.
    expect(studyVisible(RENDER)).not.toContain('<ParamRow');
    expect(studyVisible(RENDER)).not.toContain('<DragNumberInput');
  });
});

describe('the new rows render only outside a study session, where the spec puts them', () => {
  it('the placement block, the turn, Older transform and the model binding all sit inside {!study && …}', () => {
    const blocks = studyBlocks(RENDER);
    // Picker, placement block, model binding.
    expect(blocks.length).toBe(3);
    for (const anchor of [
      '<TexturePicker',
      '<ParamRow',
      '<DragNumberInput',
      "t('Rotation (°)'",
      "t('Older transform'",
      "t('Clear'",
      "t('UV set'",
      "t('UV 0 (default)'",
      "t('Flip normal green (Y)'",
    ]) {
      const at = RENDER.indexOf(anchor);
      expect(at, anchor).toBeGreaterThan(-1);
      expect(blocks.some(([a, b]) => at > a && at < b), anchor).toBe(true);
    }
  });

  it('Tile/Offset and the turn follow Size; the model binding follows Filtering', () => {
    const order = tKeys(RENDER);
    const at = (k: string) => {
      expect(order, k).toContain(k);
      return order.indexOf(k);
    };
    expect(at('Size')).toBeLessThan(at('Rotation (°)'));
    expect(at('Rotation (°)')).toBeLessThan(at('Older transform'));
    expect(at('Older transform')).toBeLessThan(at('Repeat (tile the image)'));
    expect(at('Filtering')).toBeLessThan(at('UV set'));
    expect(at('UV set')).toBeLessThan(at('Flip normal green (Y)'));
    expect(at('Flip normal green (Y)')).toBeLessThan(at('Optimize on import'));
    // The Tile/Offset rows open the placement block, before the turn.
    const size = RENDER.indexOf("infoRow(t('Size', language), size)");
    const rows = RENDER.indexOf('<ParamRow');
    expect(size).toBeLessThan(rows);
    expect(rows).toBeLessThan(RENDER.indexOf("t('Rotation (°)'"));
  });

  it('Older transform appears only on a node still holding a legacy transform', () => {
    expect(RENDER).toMatch(/\{placement\.xf && \(/);
    expect(readImagePlacement({}).xf).toBeNull();
    // A legacy key at its identity value applies nothing, so it offers nothing.
    expect(readImagePlacement({ xfScaleX: 1 }).xf).toBeNull();
    expect(readImagePlacement({ xfScaleX: 2 }).xf).not.toBeNull();
    expect(readImagePlacement(withoutLegacyTransform({ xfScaleX: 2, xfRotation: 0.3 })).xf).toBeNull();
  });

  it('no row brings a sticky heading', () => {
    for (const src of [IMAGE_MENU, PARAM_ROW]) expect(src).not.toContain('className="context-menu__category"');
  });
});

describe('one ParamRow', () => {
  it('ParamRow is the ONE parameter row: its toggle, its controls and their history', () => {
    const src = code(PARAM_ROW);
    expect(count(src, 'toggleExposedPort(')).toBe(1);
    expect(src).toMatch(
      /asOneHistoryEntry\(\(\) => \{\s*updateNodeData\(nodeId, \{ exposedPorts: toggleExposedPort\(nodeId, exposedPorts, key\) \}\);\s*\}\);/,
    );
    expect(count(src, '<DragNumberInput')).toBe(1);
    expect(count(src, '<PaletteColorPicker')).toBe(1);
    expect(src).toContain('history="bracket"');
    expect(src).toContain('const { bracket, closeBracket } = useHistoryBracket();');
    expect(src).toMatch(/onChange=\{\(e\) => \{ bracket\(\); handleValueChange\(paramKey, e\.target\.value\); \}\}\s*onBlur=\{closeBracket\}/);
  });

  it('both menus draw their parameter rows through it, and neither keeps a copy', () => {
    const menu = code(NODE_MENU);
    const image = code(IMAGE_MENU);
    // The socket-only rows and the defaultValues rows.
    expect(count(menu, '<ParamRow')).toBe(2);
    expect(count(image, '<ParamRow')).toBe(1);
    for (const [name, src] of [['NodeSettingsMenu', menu], ['ImageNodeSettings', image]] as const) {
      for (const copy of ['toggleExposedPort(', 'asOneHistoryEntry(', '<PaletteColorPicker', 'useHistoryBracket(']) {
        expect(src, `${name}: ${copy}`).not.toContain(copy);
      }
    }
    expect(menu).not.toContain('<DragNumberInput');
    // ImageNodeSettings' one drag number is the turn, the one row that is no socket.
    expect(count(image, '<DragNumberInput')).toBe(1);
    expect(image).toContain('<DragNumberInput value={rotationDeg} step={1} onChange={setRotation} />');
  });

  it('the Image node’s rows are its registry defaults, under their SOCKET names', () => {
    expect(IMAGE_MENU).toContain('Object.keys(def?.defaultValues ?? {}).map((key) => {');
    expect(IMAGE_MENU).toContain('label={input ? portLabel(input.label, language) : key}');
    const def = NODE_REGISTRY.get('imageNode')!;
    const names = Object.keys(def.defaultValues ?? {}).map((k) => def.inputs.find((i) => i.id === k)?.label);
    expect(names).toEqual(['Tile X', 'Tile Y', 'Offset X', 'Offset Y']);
    // The names the canvas socket's own tooltip shows, translated (lv.ports).
    for (const n of names) expect(portLabel(n!, 'lv'), n).not.toBe(n);
  });
});

describe('one writer per key, and no menu writes orientation', () => {
  it('the menu reads the mapping and the placement only through their readers', () => {
    const src = code(IMAGE_MENU);
    expect(src).toContain('const placement = readImagePlacement(vals);');
    expect(src).toContain('const mapping = readImageUvMapping(vals);');
    for (const k of [...UV_MAPPING_KEYS, 'tileX', 'tileY', 'offsetX', 'offsetY']) {
      expect(src, k).not.toMatch(new RegExp(`\\b(?:vals|liveVals|values|next)\\??\\.${k}\\b`));
      expect(src, k).not.toMatch(new RegExp(`\\[\\s*'${k}'\\s*\\]`));
      expect(src, k).not.toContain(`'${k}'`);
    }
  });

  it('each act goes through its key’s one writer, in one updateNodeData, against the LIVE node', () => {
    const src = code(IMAGE_MENU);
    for (const writer of ['withPictureRotation(', 'withoutLegacyTransform(', 'withUvMapping(']) {
      expect(count(src, writer), writer).toBe(1);
    }
    const turn = between(src, 'const setRotation = ', 'const clearLegacyTransform = ');
    const clear = between(src, 'const clearLegacyTransform = ', 'const writeMapping = ');
    const binding = between(src, 'const writeMapping = ', 'const url = typeof vals.imageB64');
    for (const [name, body] of [['turn', turn], ['clear', clear], ['binding', binding]] as const) {
      expect(count(body, 'updateNodeData('), name).toBe(1);
      expect(body, name).toContain('useAppStore.getState().nodes.find((n) => n.id === nodeId)');
    }
    expect(clear).toContain('updateNodeData(nodeId, { values: withoutLegacyTransform(liveVals) })');
    expect(binding).toContain('updateNodeData(nodeId, { values: withUvMapping(getNodeValues(live), patch) })');
    // The two binding rows patch only the binding, and the UV set maps through
    // a closed table, never Number().
    expect(count(src, 'writeMapping(')).toBe(2);
    expect(src).toContain('writeMapping({ uvSet: next })');
    expect(src).toContain('writeMapping({ normalGreenFlip: !mapping.normalGreenFlip })');
    expect(src).not.toMatch(/Number\(e\.target\.value\)/);
  });

  it('each writer changes its own key and nothing else', () => {
    const node: Record<string, string | number> = {
      imageB64: 'data:image/png;base64,AAAA', tileX: 2, offsetY: 0.5, flipX: 1, rotation: 0.5,
      xfScaleX: 2, xfRotation: 0.3, uvSet: 1, normalGreen: 'flip', orientation: 'gltf',
    };
    const changed = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();
    expect(changed(node, withPictureRotation(node, Math.PI / 2))).toEqual(['rotation']);
    expect(changed(node, withoutLegacyTransform(node))).toEqual(['xfRotation', 'xfScaleX']);
    expect(changed(node, withUvMapping(node, { uvSet: 3 }))).toEqual(['uvSet']);
    expect(changed(node, withUvMapping(node, { normalGreenFlip: false }))).toEqual(['normalGreen']);
  });

  it('no menu writes `orientation`: it is a fact about the bytes, and moves with them', () => {
    // The one place a menu names it is the model-texture pick, which hands the
    // picture's own fact to withImagePayload together with its bytes.
    const src = code(IMAGE_MENU);
    expect(count(src, 'orientation')).toBe(1);
    expect(src).toMatch(/withImagePayload\(liveVals, \{[^}]*orientation: 'gltf',/);
    const dir = fileURLToPath(new URL('.', import.meta.url));
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.tsx'))) {
      const s = code(readFileSync(path.join(dir, f), 'utf8'));
      expect(s, f).not.toMatch(/withUvMapping\([^)]*orientation/);
      expect(s, f).not.toMatch(/orientation:\s*e\.target/);
    }
  });
});

describe('the turn: degrees shown, radians stored, one entry per act', () => {
  /** The handler's arithmetic and the row's display, as the menu spells them. */
  const write = (deg: number, values: Record<string, string | number> = {}) =>
    withPictureRotation(values, ((deg % 360) * Math.PI) / 180);
  const shown = (values: Record<string, unknown>) =>
    Math.round(((readImagePlacement(values).theta * 180) / Math.PI) * 1000) / 1000;

  it('the row spells exactly that arithmetic, and writes nothing for an act that changes nothing', () => {
    expect(IMAGE_MENU).toContain('const rotationDeg = Math.round(((placement.theta * 180) / Math.PI) * 1000) / 1000;');
    const body = between(IMAGE_MENU, 'const setRotation = ', 'const clearLegacyTransform = ');
    expect(body).toContain('if (!Number.isFinite(deg) || deg === rotationDeg) return;');
    expect(body).toContain('const next = withPictureRotation(liveVals, ((deg % 360) * Math.PI) / 180);');
    expect(body).toContain('if (readPictureRotation(next) === readPictureRotation(liveVals)) return;');
  });

  it('what is typed reads back as typed, mod a whole turn, and a whole turn stores nothing', () => {
    for (const deg of [30, -30, 90, 179.5, 330, 400, -720.25, 1e9]) {
      expect(shown(write(deg)), String(deg)).toBe(deg % 360 || 0);
    }
    for (const deg of [0, 360, -720]) expect(write(deg, { tileX: 2 }), String(deg)).toEqual({ tileX: 2 });
    // An imported π/6 (a model's KHR 30°) reads as a clean 30, and −π/6 as −30.
    expect(shown({ rotation: Math.PI / 6 })).toBe(30);
    expect(shown({ rotation: -Math.PI / 6 })).toBe(-30);
  });

  it('why the shown-value guard exists: re-committing the shown degrees would round an imported turn', () => {
    const imported = { rotation: 0.1 };
    expect(shown(imported)).toBe(5.73);
    expect(readPictureRotation(write(shown(imported)))).not.toBe(readPictureRotation(imported));
  });
});

describe('a click in and out of an imported Offset writes nothing', () => {
  // An import's placement now lives in the plain Tile/Offset rows, and the
  // turn's pivot term makes its Offset a long fraction. DragNumberInput's edit
  // field shows the value to 4 places and commits that text on Enter or blur
  // whether or not anything was typed, so without the guard a click in and out
  // rounded the import, pushed an undo entry and broke its exact export.
  const DRAG = read('../inputs/DragNumberInput.tsx');
  const KHR = { rotation: Math.PI / 6, scale: [2, 1], offset: [0.1, 0.2] };
  const imported = gltfTextureValues({ extensions: { KHR_texture_transform: KHR } }, { normalGreenFlip: false }).values;
  const shown = (n: number) => Math.round(n * 1e4) / 1e4;
  const NO_WIRES = { tileX: false, tileY: false, offsetX: false, offsetY: false };

  it('the row’s guard matches what the edit field shows and commits', () => {
    expect(DRAG).toContain('setEditText(String(roundTo(value, 4)));');
    expect(DRAG).toMatch(/const num = parseFloat\(editText\);\s*if \(!isNaN\(num\)\) onChange\(num\);/);
    expect(PARAM_ROW).toContain('const EDIT_DECIMALS = 4;');
    expect(code(PARAM_ROW)).toMatch(
      /onChange=\{\(v\) => \{\s*if \(!isRoundingOnlyCommit\(v, Number\(currentValue\)\)\) handleValueChange\(paramKey, v\);\s*\}\}/,
    );
  });

  it('re-committing an imported Offset as shown is no edit; a typed number, or the exact one, still writes', () => {
    const ox = imported.offsetX as number;
    const oy = imported.offsetY as number;
    expect(shown(ox)).not.toBe(ox);
    expect(isRoundingOnlyCommit(shown(ox), ox)).toBe(true);
    expect(isRoundingOnlyCommit(shown(oy), oy)).toBe(true);
    // What the guard keeps: the import still exports back to KHR's own offset,
    // which the rounded number does not.
    const exact = composeKhrTextureTransform(imported, NO_WIRES).transform!.offset!;
    const rounded = composeKhrTextureTransform({ ...imported, offsetX: shown(ox), offsetY: shown(oy) }, NO_WIRES).transform!.offset!;
    expect(Math.abs(exact[0] - 0.1) + Math.abs(exact[1] - 0.2)).toBeLessThan(1e-12);
    expect(Math.abs(rounded[0] - 0.1)).toBeGreaterThan(1e-6);
    // Anything else commits as before.
    expect(isRoundingOnlyCommit(0.31, ox)).toBe(false);
    expect(isRoundingOnlyCommit(ox, ox)).toBe(false);
    expect(isRoundingOnlyCommit(0.5, 0.5)).toBe(false);
    expect(isRoundingOnlyCommit(2, 1)).toBe(false);
    expect(isRoundingOnlyCommit(1, Number.NaN)).toBe(false);
  });
});

describe('codegen and the cards read the placement only through the readers', () => {
  it('graphToCode and the GLB export read through readImagePlacement', () => {
    expect(CODEGEN).toContain('const placement = readImagePlacement(nv);');
    expect(CODEGEN).toContain('const mapping = readImageUvMapping(nv);');
    expect(CODEGEN).toContain('readImageUvMapping(getNodeValues(sourceNode)).normalGreenFlip');
    for (const k of [...UV_MAPPING_KEYS, 'flipX', 'flipY', 'tileX', 'tileY', 'offsetX', 'offsetY']) {
      expect(CODEGEN, k).not.toContain(`nv.${k}`);
      expect(CODEGEN, k).not.toContain(`nv['${k}']`);
      expect(CODEGEN, k).not.toContain(`numVal('${k}'`);
    }
    expect(EXPORT).toContain('composePlacement(readImagePlacement(values))');
  });

  it('the node face and every replica never read the turn (the card shows the picture, not its placement)', () => {
    for (const [name, src] of [['ShaderNode', SHADER_NODE], ['NodeVisual', NODE_VISUAL], ['NodePreviewCard', CARD]] as const) {
      expect(src, name).not.toMatch(/\brotation\b/);
      for (const k of UV_MAPPING_KEYS) expect(src, `${name} ${k}`).not.toContain(`.${k}`);
    }
  });
});

describe('the strings: the fold-out’s went with it, the new ones are translated', () => {
  /** Strings only the retired glTF-mapping fold-out used. */
  const RETIRED = [
    'glTF mapping',
    'default',
    'transform',
    'green flipped',
    'UV orientation',
    "How the image lies on the model's UVs. glTF: the way a texture that came with a .glb or .gltf model expects it (stored top-down, not mirrored). On the built-in shapes a glTF texture shows turned 180°.",
    'FastShaders (default)',
    'glTF (as in the model)',
    'Texture transform (glTF)',
    "KHR_texture_transform: scales, then turns about the UV origin (0, 0), then offsets — applied before Flip, Tile and Offset. The UV node's rotation turns about the centre instead.",
    'Offset U',
    'Offset V',
    'Scale U',
    'Scale V',
  ];
  /** Moved with their rows, same wording. */
  const REUSED = [
    'Rotation (°)',
    'UV set',
    "Which of the model's texture-coordinate sets to sample (glTF TEXCOORD_0–3). A model without that set shows one flat colour. A wired UV input replaces this.",
    'UV 0 (default)',
    'Flip normal green (Y)',
    "For a normal map on a model without tangent data (Blender's default glTF export): inverts the green channel the way three.js does for glTF. Only matters while this image is wired into the Output's Normal.",
    'Clear',
  ];
  const ADDED = ['Older transform', OLDER_TIP, ROTATION_TIP];

  /** Every non-test source file under src/. */
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) sourceFiles(full, out);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
    }
    return out;
  }

  it('the fold-out itself is gone', () => {
    expect(existsSync(new URL('./ImageMappingSettings.tsx', import.meta.url))).toBe(false);
  });

  it('its strings left lv.json with their only caller (the i18n header’s rule; there is no CI guard)', () => {
    for (const k of RETIRED) expect(Object.prototype.hasOwnProperty.call(LV_UI, k), k).toBe(false);
  });

  it('…and no source file asks for one', () => {
    const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const asked = RETIRED.map((k) => new RegExp(`\\bt\\(\\s*(['"])${escape(k)}\\1`));
    const offenders: string[] = [];
    for (const f of sourceFiles(fileURLToPath(new URL('../../../', import.meta.url)))) {
      const src = readFileSync(f, 'utf8');
      RETIRED.forEach((k, i) => {
        if (asked[i].test(src)) offenders.push(`${path.basename(f)}: ${k}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the new strings are on the menu, and translated', () => {
    for (const k of ADDED) {
      expect(IMAGE_MENU.includes(`t('${k}', language)`) || IMAGE_MENU.includes(`t("${k}", language)`), k).toBe(true);
      expect(t(k, 'lv'), k).not.toBe(k);
    }
    expect(t('Older transform', 'lv')).toBe('Vecā transformācija');
  });

  it('the Rotation title states three.js’s and glTF’s sign per shape, in either language', () => {
    // The first title said "positive turns it counter-clockwise" for every
    // shape; the second said CLOCKWISE on the built-ins, which was true of the
    // sign it replaced (2026-10-08: ψ's app factor is −1 now, like three.js).
    expect(IMAGE_MENU).not.toContain('positive turns it counter-clockwise');
    expect(Object.keys(LV_UI).some((k) => k.includes('positive turns it counter-clockwise'))).toBe(false);
    // A positive turn reading CLOCKWISE on a built-in shape may not come back —
    // the Bunny included, since its generated UVs became three's SphereGeometry
    // parameterization with the picture's baked 1-u gone (2026-10-08).
    const clockwiseOnBuiltIn = /(?<!counter-)clockwise on the (Sphere|Plane|Cube|Utah Teapot|Teapot|Stanford Bunny|Bunny)/i;
    expect(IMAGE_MENU).not.toMatch(clockwiseOnBuiltIn);
    expect(Object.keys(LV_UI).some((k) => clockwiseOnBuiltIn.test(k))).toBe(false);
    expect(ROTATION_TIP).toContain('counter-clockwise on the Sphere, Plane, Cube, Teapot and Bunny');
    expect(ROTATION_TIP).toContain('clockwise on most imported models');
    expect(ROTATION_TIP).toContain('the sign three.js and glTF use');
    // Latvian: both senses, each with the shapes the Model menu names (lv.json's own names).
    const lv = t(ROTATION_TIP, 'lv');
    expect(lv).toMatch(/uz lodes, plaknes, kuba, Jūtas tējkannas un Stenfordas zaķa attēlu griež pretēji pulksteņrādītāja virzienam\./);
    expect(lv).toMatch(/Uz vairuma importēto modeļu tas attēlu griež pulksteņrādītāja virzienā\./);
    expect(lv).not.toMatch(/Uz Stenfordas zaķa/);
    for (const name of ['Sphere', 'Plane', 'Cube', 'Utah Teapot', 'Stanford Bunny']) expect(t(name, 'lv'), name).not.toBe(name);
    expect([t('Sphere', 'lv'), t('Cube', 'lv'), t('Utah Teapot', 'lv'), t('Stanford Bunny', 'lv')])
      .toEqual(['Lode', 'Kubs', 'Jūtas tējkanna', 'Stenfordas zaķis']);
  });

  it('the moved rows kept their wording, and its translation', () => {
    for (const k of REUSED) {
      expect(IMAGE_MENU.includes(`t('${k}', language)`) || IMAGE_MENU.includes(`t("${k}", language)`), k).toBe(true);
      expect(t(k, 'lv'), k).not.toBe(k);
    }
  });
});
