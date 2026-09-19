/**
 * Per-part material settings: an added material's Transparent / Side / Alpha
 * clip / Depth write, from the graph to editor code to the module and back.
 *
 * Loader 0.6 has always applied all four to every part it builds; the app never
 * delivered them. graphToCode did not write them, buildShaderModule's part loop
 * dropped any key CHANNEL_TO_PROP did not know, and the parse wrote none — so a
 * section's settings did nothing and every code-panel Apply deleted them.
 *
 * What fails SILENTLY here, and is therefore pinned:
 *  - a document whose added materials carry no (or only no-op) settings emits
 *    the SAME BYTES it always did;
 *  - the per-part rules ARE the default's rules (one emitter, one sanitizer),
 *    and adversarial values never reach the module as text;
 *  - a settings key is never a channel, and a settings-only part body never
 *    merges with another.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import { graphToCode } from './graphToCode';
import { codeToGraph } from './codeToGraph';
import { buildShaderModule, stripComments } from './tslCodeProcessor';
import { buildPreviewShaderModule } from './tslToPreviewHTML';
import {
  PART_SETTING_KEYS,
  materialSettingProps,
  materialSettingsFromSource,
  settingValueText,
} from './materialSettingsCode';
import { makeNode, makeEdge } from '@/test-utils';
import type { AppNode, AppEdge, MaterialSettings } from '@/types';

type Graph = { nodes: AppNode[]; edges: AppEdge[] };
type ParsedMaterial = { meshTargets: string[]; materialSettings?: MaterialSettings };

const FULL: MaterialSettings = { transparent: true, side: 'double', alphaTest: 0.5, depthWrite: false };
const FULL_TEXT = 'transparent: true, side: 2, alphaTest: 0.5, depthWrite: false';

/** The return line graphToCode emitted for the two-material graph BEFORE this change. */
const HEAD_RETURN = '  return { color: color1, parts: { "Glass": { color: color2 } } };';

function outputWithMaterials(id: string, materials: Record<string, unknown>[]): AppNode {
  const node = makeNode(id, 'output');
  (node.data as Record<string, unknown>).materials = materials;
  return node;
}

/** color1 → the default material, color2 → an added material shading Glass. */
function glassGraph(settings?: unknown, extra: Record<string, unknown> = {}): Graph {
  const base = makeNode('color1', 'color', { hex: '#22cc22' });
  const part = makeNode('color2', 'color', { hex: '#cc2222' });
  const material: Record<string, unknown> = { meshTargets: ['Glass'], ...extra };
  if (settings !== undefined) material.materialSettings = settings;
  return {
    nodes: [base, part, outputWithMaterials('out1', [material])],
    edges: [
      makeEdge('color1', 'out', 'out1', 'color'),
      makeEdge('color2', 'out', 'out1', 'm1:color'),
    ],
  };
}

const codeOf = (g: Graph): string => graphToCode(g.nodes, g.edges).code;

const materialsOf = (nodes: AppNode[]): ParsedMaterial[] => {
  const out = nodes.find((n) => n.data.registryType === 'output');
  if (!out) throw new Error('no Output node');
  return (out.data as { materials?: ParsedMaterial[] }).materials ?? [];
};

/** The inside of one `parts` entry's braces, e.g. `color: color2, transparent: true`. */
function partBody(text: string, name: string): string | null {
  const at = text.indexOf(`"${name}": {`);
  if (at === -1) return null;
  const open = text.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i).trim();
  }
  return null;
}

/** The return line with its `parts: { … }` block cut out — the DEFAULT material's keys. */
function withoutParts(text: string): string {
  const line = text.split('\n').find((l) => l.includes('parts:'));
  if (!line) throw new Error('no parts line');
  const at = line.indexOf('parts:');
  const open = line.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === '{') depth++;
    else if (line[i] === '}' && --depth === 0) return line.slice(0, at) + line.slice(i + 1);
  }
  throw new Error('unbalanced parts block');
}

/** Everything on the return line before `parts:` — the DEFAULT material's keys. */
function beforeParts(text: string): string {
  const line = text.split('\n').find((l) => l.includes('parts:'));
  if (!line) throw new Error('no parts line');
  return line.slice(0, line.indexOf('parts:'));
}

const SETTINGS_KEY_RE = /\b(transparent|side|alphaTest|depthWrite)\s*:/;

describe('emission', () => {
  it('writes the four settings into the part, after its channels, in the loader spelling', () => {
    const code = codeOf(glassGraph(FULL));
    expect(code).toContain(`"Glass": { color: color2, ${FULL_TEXT} }`);
    // The default's settings never appear in editor code — they ride
    // buildShaderModule's options — so nothing leaks into the top level.
    expect(beforeParts(code)).not.toMatch(SETTINGS_KEY_RE);
  });

  it('no settings, or only no-op ones, emit the SAME BYTES as before', () => {
    const absent = codeOf(glassGraph());
    expect(absent.split('\n')).toContain(HEAD_RETURN);
    // `{}` and the state ShaderSettingsMenu leaves after unticking Transparent
    // and Alpha clip must be indistinguishable from never having touched them.
    expect(codeOf(glassGraph({}))).toBe(absent);
    expect(codeOf(glassGraph({ transparent: false, alphaTest: 0, depthWrite: undefined, side: undefined })))
      .toBe(absent);
  });

  it('displacementMode / mergeVertices on an ADDED material emit nothing into its part', () => {
    const absent = codeOf(glassGraph());
    expect(codeOf(glassGraph({ displacementMode: 'offset', mergeVertices: false }))).toBe(absent);
  });
});

describe('the module', () => {
  it('carries the settings after the part\'s channel props, and none at the top level', () => {
    const code = codeOf(glassGraph(FULL));
    const mod = buildShaderModule(code, {});
    expect(mod).toContain(`"Glass": { colorNode: color2, ${FULL_TEXT} }`);
    expect(beforeParts(mod)).not.toMatch(SETTINGS_KEY_RE);
  });

  it('the preview builds the same part entry', () => {
    const code = codeOf(glassGraph(FULL));
    expect(buildPreviewShaderModule(code)).toContain(`"Glass": { colorNode: color2, ${FULL_TEXT} }`);
  });

  it('puts settings after every channel prop, the __partPixel colour included', () => {
    const glow = makeNode('color1', 'color', { hex: '#ff8800' });
    const cond = makeNode('float1', 'float', { value: 1 });
    const out = outputWithMaterials('out1', [
      { meshTargets: ['Glass'], materialSettings: { transparent: true } },
    ]);
    const code = graphToCode([glow, cond, out], [
      makeEdge('color1', 'out', 'out1', 'm1:emissive'),
      makeEdge('float1', 'out', 'out1', 'm1:discard'),
    ]).code;
    expect(partBody(code, 'Glass')).toBe('emissive: color1, discard: float1, transparent: true');
    const mod = buildShaderModule(code, {});
    expect(partBody(mod, 'Glass'))
      .toBe('colorNode: __partPixel0(float1, color1), emissiveNode: color1, transparent: true');
  });

  it('a SETTINGS-ONLY part stays in the code, leaves the module, and round-trips', () => {
    const graph: Graph = {
      nodes: [outputWithMaterials('out1', [{ meshTargets: ['Glass'], materialSettings: { transparent: true } }])],
      edges: [],
    };
    const code = codeOf(graph);
    expect(code).toContain('"Glass": { transparent: true }');
    // Loader 0.6 skips a part with no channel (`hasChannels`), so the module
    // mirrors it rather than carrying an entry the runtime would ignore.
    expect(buildShaderModule(code, {})).not.toContain('"Glass"');
    // …but the editor code keeps it, so the parse re-creates the material
    // together with its settings.
    const parsed = codeToGraph(code);
    const mats = materialsOf(parsed.nodes);
    expect(mats).toHaveLength(1);
    expect(mats[0].meshTargets).toEqual(['Glass']);
    expect(mats[0].materialSettings).toEqual({ transparent: true });
    expect(graphToCode(parsed.nodes, parsed.edges).code).toBe(code);
  });
});

describe('the round trip', () => {
  it('parses the settings back onto the material, and an Apply is a fixed point', () => {
    const code = codeOf(glassGraph(FULL));
    const p1 = codeToGraph(code);
    const mats = materialsOf(p1.nodes);
    expect(mats).toHaveLength(1);
    expect(mats[0].materialSettings).toEqual(FULL);
    const second = graphToCode(p1.nodes, p1.edges).code;
    expect(second).toBe(code);
    const p2 = codeToGraph(second);
    expect(graphToCode(p2.nodes, p2.edges).code).toBe(code);
    expect(p2.nodes.length).toBe(p1.nodes.length);
  });
});

describe('the per-part rules are the default\'s rules', () => {
  const bodyFor = (settings: unknown): string | null => partBody(codeOf(glassGraph(settings)), 'Glass');

  it('caps alphaTest below 1', () => {
    expect(bodyFor({ alphaTest: 1 })).toBe('color: color2, alphaTest: 0.99');
  });

  it('drops a tampered alphaTest string rather than splicing it', () => {
    const tampered = '0.5 }; globalThis.pwned = 1; ({ x: 0';
    const code = codeOf(glassGraph({ alphaTest: tampered }));
    expect(partBody(code, 'Glass')).toBe('color: color2');
    const mod = buildShaderModule(code, {});
    expect(mod).not.toContain('pwned');
    // And the module is still a module.
    expect(() => parse(mod, { sourceType: 'module' })).not.toThrow();
  });

  it('keeps depthWrite:false only under transparency, in the code and the module', () => {
    const code = codeOf(glassGraph({ depthWrite: false }));
    expect(partBody(code, 'Glass')).toBe('color: color2');
    expect(partBody(buildShaderModule(code, {}), 'Glass')).toBe('colorNode: color2');
  });

  it('emits side: 0 for a tampered side, never a Function', () => {
    expect(bodyFor({ side: 'constructor' })).toBe('color: color2, side: 0');
    expect(bodyFor({ side: {} })).toBe('color: color2, side: 0');
  });

  it('reads transparency by truthiness, as the default does', () => {
    expect(bodyFor({ transparent: 'yes' })).toBe('color: color2, transparent: true');
  });
});

describe('hostile code-panel text', () => {
  it('re-validates a part\'s settings instead of passing them through', () => {
    const base = codeOf(glassGraph());
    const hostile = base.replace(
      '"Glass": { color: color2 }',
      '"Glass": { color: color2, side: alert(1), alphaTest: 0.5, depthWrite: false, mergeVertices: false }',
    );
    expect(hostile).not.toBe(base);
    const mod = buildShaderModule(hostile, {});
    // No side (not a side value), no depthWrite (not transparent), no
    // mergeVertices (a module-level directive, never a part setting).
    expect(partBody(mod, 'Glass')).toBe('colorNode: color2, alphaTest: 0.5');
    expect(mod).not.toContain('alert');
  });
});

describe('the parse', () => {
  const withGlassBody = (inner: string): string => {
    const base = codeOf(glassGraph());
    const text = base.replace('"Glass": { color: color2 }', `"Glass": { color: color2, ${inner} }`);
    expect(text).not.toBe(base);
    return text;
  };

  it.each([`side: 'double'`, 'side: "double"', 'side: 2'])('reads %s and re-emits side: 2', (inner) => {
    const parsed = codeToGraph(withGlassBody(inner));
    expect(materialsOf(parsed.nodes)[0].materialSettings).toEqual({ side: 'double' });
    expect(graphToCode(parsed.nodes, parsed.edges).code).toContain('"Glass": { color: color2, side: 2 }');
  });

  // RESOLVABLE references on purpose: `color2` is a node in this module, so
  // without the PART_SETTING_KEYS skip a member expression mints a Split node
  // plus an `m1:side` edge and an identifier wires `m1:<key>` straight in. An
  // unresolvable one (`THREE.DoubleSide`, an undeclared name) wires nothing with
  // or without the skip, and so cannot catch its removal.
  it.each([
    ['side: color2.x', 'm1:side'],
    ['side: color2', 'm1:side'],
    ['transparent: color2', 'm1:transparent'],
  ])('never treats %s as a channel', (inner, handle) => {
    const parsed = codeToGraph(withGlassBody(inner));
    expect(materialsOf(parsed.nodes)[0].materialSettings).toBeUndefined();
    expect(parsed.nodes.filter((n) => n.data.registryType === 'split')).toHaveLength(0);
    const handles = parsed.edges.map((e) => e.targetHandle);
    expect(handles).not.toContain(handle);
    // The channel beside it still wires — the skip is per key, not per part.
    expect(handles).toContain('m1:color');
  });

  it('never treats a TOP-LEVEL settings key as a channel either', () => {
    const base = codeOf(glassGraph());
    const text = base.replace('return { color: color1, parts:', 'return { color: color1, side: color1.x, transparent: color1, parts:');
    expect(text).not.toBe(base);
    const parsed = codeToGraph(text);
    expect(parsed.nodes.filter((n) => n.data.registryType === 'split')).toHaveLength(0);
    const handles = parsed.edges.map((e) => e.targetHandle);
    expect(handles).not.toContain('side');
    expect(handles).not.toContain('transparent');
    // The default's settings never live in editor code, so none are parsed.
    const out = parsed.nodes.find((n) => n.data.registryType === 'output')!;
    expect((out.data as { materialSettings?: unknown }).materialSettings).toBeUndefined();
  });
});

describe('the module and the parse read part settings alike', () => {
  const withGlassBody = (inner: string): string => {
    const base = codeOf(glassGraph());
    const text = base.replace('"Glass": { color: color2 }', `"Glass": { ${inner} }`);
    expect(text).not.toBe(base);
    return text;
  };

  // Each row: the part body as typed, the settings the parse must store, and
  // the part entry the module must build. They used to disagree: Babel's value
  // node excludes a trailing comment and propKeyName unquotes a string key,
  // while the module compared the raw colon-to-comma text — so these reached
  // the node and never the module, and an Apply left the preview opaque under a
  // section showing Transparent ticked.
  it.each([
    ['color: color2, transparent: true /* glass */', { transparent: true }, 'colorNode: color2, transparent: true'],
    ['color: color2, "transparent": true', { transparent: true }, 'colorNode: color2, transparent: true'],
    [`color: color2, 'side': 2`, { side: 'double' }, 'colorNode: color2, side: 2'],
    [`color: color2, side: /* both */ 'double' /* faces */`, { side: 'double' }, 'colorNode: color2, side: 2'],
    ['color: color2, alphaTest: 0.5 /* clip */', { alphaTest: 0.5 }, 'colorNode: color2, alphaTest: 0.5'],
    // A quoted CHANNEL key takes the same unquoting, so it reaches the module
    // too instead of being dropped while the parse wires it.
    ['"color": color2', undefined, 'colorNode: color2'],
  ])('%s', (inner, settings, moduleBody) => {
    const text = withGlassBody(inner);
    const parsed = codeToGraph(text);
    expect(materialsOf(parsed.nodes)[0].materialSettings).toEqual(settings);
    expect(parsed.edges.map((e) => e.targetHandle)).toContain('m1:color');
    expect(partBody(buildShaderModule(text, {}), 'Glass')).toBe(moduleBody);
  });

  it('a comment never glues two tokens into one value', () => {
    // `1/**/0` is two tokens to JS (a syntax error here), never `10`.
    expect(materialSettingsFromSource({ alphaTest: '0.5/**/5' })).toBeUndefined();
    expect(materialSettingsFromSource({ transparent: 'tr/**/ue' })).toBeUndefined();
  });
});

describe('merge rules', () => {
  it('one material naming two meshes emits two identical bodies and parses back as ONE', () => {
    const code = codeOf(glassGraph({ transparent: true }, { meshTargets: ['Body', 'Glass'] }));
    expect(code).toContain(
      '"Body": { color: color2, transparent: true }, "Glass": { color: color2, transparent: true }',
    );
    const mats = materialsOf(codeToGraph(code).nodes);
    expect(mats).toHaveLength(1);
    expect(mats[0].meshTargets).toEqual(['Body', 'Glass']);
    expect(mats[0].materialSettings).toEqual({ transparent: true });
  });

  it('identical channels with DIFFERENT settings stay two materials', () => {
    const base = makeNode('color1', 'color', { hex: '#22cc22' });
    const part = makeNode('color2', 'color', { hex: '#cc2222' });
    const out = outputWithMaterials('out1', [
      { meshTargets: ['Body'], materialSettings: { transparent: true } },
      { meshTargets: ['Glass'] },
    ]);
    const code = graphToCode([base, part, out], [
      makeEdge('color1', 'out', 'out1', 'color'),
      makeEdge('color2', 'out', 'out1', 'm1:color'),
      makeEdge('color2', 'out', 'out1', 'm2:color'),
    ]).code;
    const mats = materialsOf(codeToGraph(code).nodes);
    expect(mats.map((m) => m.meshTargets)).toEqual([['Body'], ['Glass']]);
    expect(mats[0].materialSettings).toEqual({ transparent: true });
    expect(mats[1].materialSettings).toBeUndefined();
  });

  it('two UNWIRED materials with the same settings are never merged', () => {
    // A settings-only body counts as EMPTY — the "EMPTY bodies are never
    // merged" rule, which two freshly added Transparent sections would
    // otherwise break on their first Apply.
    const out = outputWithMaterials('out1', [
      { meshTargets: ['Body'], materialSettings: { transparent: true } },
      { meshTargets: ['Glass'], materialSettings: { transparent: true } },
    ]);
    const code = graphToCode([out], []).code;
    const mats = materialsOf(codeToGraph(code).nodes);
    expect(mats.map((m) => m.meshTargets)).toEqual([['Body'], ['Glass']]);
    expect(mats.map((m) => m.materialSettings)).toEqual([{ transparent: true }, { transparent: true }]);
  });
});

describe('a TARGETED material 0', () => {
  const S: MaterialSettings = { transparent: true };
  const targeted = (): Graph => {
    const color = makeNode('c1', 'color', { hex: '#3388ff' });
    const out = makeNode('o1', 'output');
    (out.data as Record<string, unknown>).meshTargets = ['Body'];
    (out.data as Record<string, unknown>).materialSettings = S;
    return { nodes: [color, out], edges: [makeEdge('c1', 'out', 'o1', 'color')] };
  };

  it('carries its node-level settings into its part', () => {
    expect(partBody(codeOf(targeted()), 'Body')).toBe('color: color1, transparent: true');
  });

  it('survives the Apply normalization with the same code and the same module', () => {
    const before = codeOf(targeted());
    const p1 = codeToGraph(before);
    // The normalization: an empty default plus one added material, which now
    // holds the settings the part carried.
    const mats = materialsOf(p1.nodes);
    expect(mats).toHaveLength(1);
    expect(mats[0].meshTargets).toEqual(['Body']);
    expect(mats[0].materialSettings).toEqual(S);
    const after = graphToCode(p1.nodes, p1.edges).code;
    expect(after).toBe(before);
    // Material 1 now owns the settings: built with NO node-level settings at
    // all, Body's part still carries them, so it is not leaning on a carry.
    const bare = buildShaderModule(after, {});
    expect(partBody(bare, 'Body')).toBe('colorNode: color1, transparent: true');
    // useSyncEngine's mergeMatch ALSO carries the node-level settings onto the
    // now-empty default. That carry lives in a React hook (the vitest env is
    // `node`), so it is not exercised here; what is pinned is what the copy
    // does. It never reaches editor code…
    const out = p1.nodes.find((n) => n.data.registryType === 'output')!;
    (out.data as Record<string, unknown>).materialSettings = S;
    expect(graphToCode(p1.nodes, p1.edges).code).toBe(before);
    // …and in the module it is exactly the top-level keys, which is why the
    // built module is byte-identical across the Apply only WITH the carry:
    // without it the module loses its top-level `transparent: true`.
    const withCopy = buildShaderModule(after, { materialSettings: S });
    expect(withCopy).not.toBe(bare);
    expect(withoutParts(withCopy)).toMatch(/\btransparent: true\b/);
    expect(withoutParts(bare)).not.toMatch(SETTINGS_KEY_RE);
    expect(partBody(withCopy, 'Body')).toBe(partBody(bare, 'Body'));
  });

  it('the leftover default copy goes live the moment the default gets a channel', () => {
    // Inert only while the module is parts-only — loader 0.6 builds a default
    // material solely for a module with a top-level channel. Wire the default
    // after the normalization and the copy applies to every unclaimed mesh.
    const p1 = codeToGraph(codeOf(targeted()));
    const out = p1.nodes.find((n) => n.data.registryType === 'output')!;
    (out.data as Record<string, unknown>).materialSettings = S;
    const green = makeNode('c9', 'color', { hex: '#22cc22' });
    const code = graphToCode([...p1.nodes, green], [...p1.edges, makeEdge('c9', 'out', out.id, 'color')]).code;
    const top = withoutParts(buildShaderModule(code, { materialSettings: S }));
    expect(top).toMatch(/\bcolorNode:/);
    expect(top).toMatch(/\btransparent: true\b/);
  });
});

describe('materialSettingsCode', () => {
  /** Split each `key: value` entry at its FIRST colon, the way a part body is read. */
  const rawOf = (props: string[]): Record<string, string> => {
    const raw: Record<string, string> = {};
    for (const p of props) {
      const c = p.indexOf(':');
      raw[p.slice(0, c).trim()] = p.slice(c + 1).trim();
    }
    return raw;
  };

  it('emitter ∘ sanitizer ∘ emitter is the emitter — the round trip cannot drift', () => {
    const sides: unknown[] = [undefined, 'front', 'back', 'double', 'constructor', {}, 3];
    const alphas: unknown[] = [undefined, 0, 0.01, 0.35, 0.5, 0.99, 1, -1, NaN, '0.5', Infinity, 'x'];
    const transparents: unknown[] = [undefined, true, false, 'yes', 0];
    const depths: unknown[] = [undefined, true, false, 'false'];
    let checked = 0;
    for (const side of sides) {
      for (const alphaTest of alphas) {
        for (const transparent of transparents) {
          for (const depthWrite of depths) {
            const s = { side, alphaTest, transparent, depthWrite } as unknown as MaterialSettings;
            const once = materialSettingProps(s);
            expect(materialSettingProps(materialSettingsFromSource(rawOf(once)))).toEqual(once);
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(sides.length * alphas.length * transparents.length * depths.length);
  });

  it('settingValueText reads a value the way tslCodeProcessor\'s stripComments does', () => {
    // The leaf cannot import stripComments, so its own copy of the rules is
    // pinned against it: whitespace-normalized, the two must agree.
    const corpus = [
      'true', ' true /* glass */ ', '/* a */ 2', "'double' /* x */", '"dou/*ble"', "'a\\'/*'",
      '0.5 // clip\n', '1/**/0', '`x/*`', '/* open', "'double'//x", '/*a*//*b*/2', '"x\\"//"',
    ];
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
    for (const v of corpus) expect(norm(settingValueText(v)), v).toBe(norm(stripComments(v)));
  });

  it('PART_SETTING_KEYS is exactly the four loader keys, and cannot match the prototype', () => {
    expect([...PART_SETTING_KEYS].sort()).toEqual(['alphaTest', 'depthWrite', 'side', 'transparent']);
    for (const k of ['__proto__', 'constructor', 'toString', 'mergeVertices', 'displacementMode', 'discard']) {
      expect(PART_SETTING_KEYS.has(k)).toBe(false);
    }
  });

  it('is a leaf, and the moved code is not left behind as a copy', () => {
    const read = (f: string): string => readFileSync(path.join(__dirname, f), 'utf8');
    const leaf = read('materialSettingsCode.ts');
    const imports = leaf.split('\n').filter((l) => /^import\b/.test(l));
    expect(imports).toEqual([`import type { MaterialSettings } from '@/types';`]);
    expect(read('tslCodeProcessor.ts')).not.toMatch(/\bconst SIDE_VALUES\b/);
    const script = read('scriptToTSL.ts');
    expect(script).not.toMatch(/\bconst SIDE_NAMES\b/);
    expect(script).not.toMatch(/\bfunction sanitizeMaterialSettings\b/);
  });
});
