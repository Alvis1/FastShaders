/**
 * Palettes in the FASTSHADERS_PROJECT_V1 block: export -> import round trip,
 * the CLEAR-on-absent rule, and the two byte-stability guarantees.
 *
 * The field is deliberately added WITHOUT a version bump. `extractProjectState`
 * reads fields by NAME and ignores unknown keys, so the change is safe in both
 * directions — an old file restores `[]`, and a new file opened by an older
 * build keeps working and simply never sees the palettes. A bump would instead
 * make every older build REJECT the block outright (`version !== 1` returns
 * null) and silently degrade a full project to a bare script import.
 *
 * Node-env safe: same shape as projectImportSettings.test.ts / exportShader
 * .test.ts — buildProjectState's localStorage reads are individually
 * try/catch'd, so an undefined `localStorage` degrades to "no preview prefs".
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { useAppStore, cancelPendingGraphSave } from '@/store/useAppStore';
import { makeNode, makeEdge } from '@/test-utils';
import { buildProjectState } from './exportShader';
import { embedProjectState, extractProjectState, type FastShadersProject } from './fastShadersProject';
import { importShaderText } from './projectImport';
import { graphToCode } from './graphToCode';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import type { Palette } from '@/utils/palettes';

const SCRIPT = [
  'import { color } from "three/tsl";',
  '',
  'export default function () {',
  '  return { colorNode: color(0xffffff) };',
  '}',
  '',
].join('\n');

const PALETTES: Palette[] = [
  { id: 'p1', name: 'Sunset', colors: ['#ff0000', '#00ff00'] },
  { id: 'p2', name: 'Ocean', colors: ['#0000ff'] },
];

/** The same thing with per-colour labels. Modelled on the shipped palettes:
 *  the label is the point of the swatch ("#ffe39d" means nothing, "Gold" means
 *  everything), so losing it in transit loses the palette's content. */
const NAMED: Palette[] = [
  { id: 'p1', name: 'Metals', colors: ['#ffe39d', '#fcfcfc'], names: ['Gold', 'Silver'] },
];

/** A store state whose project block is fully determined — no localStorage
 *  prefs, no nodes, fixed name/headset/ui colours. */
function deterministicState(shaderPalettes: Palette[] = []): void {
  useAppStore.setState({
    nodes: [],
    edges: [],
    drawings: [],
    shaderPalettes,
    shaderName: 'Golden',
    selectedHeadsetId: 'quest3',
    nodeEditorBgColor: '#fafafa',
    codeEditorTheme: 'vs',
    costColorLow: '#8bc34a',
    costColorHigh: '#ff5722',
  });
}

/** The embedded block a pre-palette build produced for `deterministicState()`,
 *  byte for byte. Any new key, reordered key or unconditional field breaks it. */
const GOLDEN_NO_PALETTES = `${SCRIPT}
/* FASTSHADERS_PROJECT_V1
{
  "version": 1,
  "shaderName": "Golden",
  "selectedHeadsetId": "quest3",
  "graph": {
    "nodes": [],
    "edges": []
  },
  "preview": {},
  "ui": {
    "nodeEditorBgColor": "#fafafa",
    "codeEditorTheme": "vs",
    "costColorLow": "#8bc34a",
    "costColorHigh": "#ff5722"
  }
}
END_FASTSHADERS_PROJECT */
`;

/**
 * The block for `PALETTES` — palettes that carry NO per-colour labels — byte
 * for byte. This is the back-compat guarantee for the `names` field, quoted:
 * "The key is OMITTED entirely when nothing is labelled, which is what keeps
 * every existing payload byte-identical." An unconditional `"names": []` would
 * put a diff into the exported bytes of every shader that already had palettes,
 * for a field those palettes do not use.
 */
const GOLDEN_UNNAMED_PALETTES = `${SCRIPT}
/* FASTSHADERS_PROJECT_V1
{
  "version": 1,
  "shaderName": "Golden",
  "selectedHeadsetId": "quest3",
  "graph": {
    "nodes": [],
    "edges": []
  },
  "palettes": [
    {
      "id": "p1",
      "name": "Sunset",
      "colors": [
        "#ff0000",
        "#00ff00"
      ]
    },
    {
      "id": "p2",
      "name": "Ocean",
      "colors": [
        "#0000ff"
      ]
    }
  ],
  "preview": {},
  "ui": {
    "nodeEditorBgColor": "#fafafa",
    "codeEditorTheme": "vs",
    "costColorLow": "#8bc34a",
    "costColorHigh": "#ff5722"
  }
}
END_FASTSHADERS_PROJECT */
`;

afterAll(() => {
  cancelPendingGraphSave();
  useAppStore.setState({ nodes: [], edges: [], drawings: [], shaderPalettes: [], past: [], future: [] });
});

beforeEach(() => {
  cancelPendingGraphSave();
  useAppStore.setState({
    nodes: [], edges: [], drawings: [], shaderPalettes: [],
    past: [], future: [], isUndoRedo: false, coalescingHistory: false, interactionDepth: 0,
  });
});

describe('buildProjectState: byte stability', () => {
  it('a shader with NO palettes embeds the byte-identical block it always did', () => {
    deterministicState([]);
    const project = buildProjectState();
    // No key at all — not `"palettes": []`, which would change every existing
    // shader's exported bytes for nothing.
    expect(Object.prototype.hasOwnProperty.call(project, 'palettes')).toBe(false);
    expect(Object.keys(project)).toEqual([
      'version', 'shaderName', 'selectedHeadsetId', 'graph', 'preview', 'ui',
    ]);
    expect(embedProjectState(SCRIPT, project)).toBe(GOLDEN_NO_PALETTES);
  });

  it('includes the palettes verbatim when the shader has some', () => {
    deterministicState(PALETTES);
    const project = buildProjectState();
    expect(project.palettes).toEqual(PALETTES);
    // Between `graph` and `preview` — beside `drawings`, its visual-only sibling.
    expect(Object.keys(project)).toEqual([
      'version', 'shaderName', 'selectedHeadsetId', 'graph', 'palettes', 'preview', 'ui',
    ]);
  });

  it('palettes with NO labels embed the byte-identical block a pre-names build wrote', () => {
    deterministicState(PALETTES);
    const embedded = embedProjectState(SCRIPT, buildProjectState());
    expect(embedded).toBe(GOLDEN_UNNAMED_PALETTES);
    // Belt and braces: the golden would also fail on a reordered key, so name
    // the thing that must be absent.
    expect(embedded).not.toContain('"names"');
  });

  it('embeds the labels verbatim when the palettes have some', () => {
    deterministicState(NAMED);
    const project = buildProjectState();
    expect(project.palettes).toEqual(NAMED);
    // Positionally aligned with `colors`, which is the invariant every consumer
    // of the block relies on.
    expect(project.palettes![0].names).toEqual(['Gold', 'Silver']);
  });

  it('leaves the SHADER CODE untouched — the block is a trailing comment', () => {
    deterministicState(PALETTES);
    const embedded = embedProjectState(SCRIPT, buildProjectState());
    expect(embedded.startsWith(SCRIPT)).toBe(true);
    expect(extractProjectState(embedded)!.stripped).toBe(SCRIPT);
  });
});

describe('palettes never reach generated shader code', () => {
  it('graphToCode emits identical bytes with and without palettes in the store', () => {
    // Structural, not incidental: graphToCode takes (nodes, edges, registry) —
    // it is not handed the store at all, and palettes are a separate slice that
    // no node reads.
    const nodes = [makeNode('out', 'output'), makeNode('c1', 'color', { hex: '#ff8800' })];
    const edges = [makeEdge('c1', 'out', 'out', 'color')];

    useAppStore.setState({ shaderPalettes: [] });
    const before = graphToCode(nodes, edges, NODE_REGISTRY).code;
    useAppStore.setState({ shaderPalettes: PALETTES });
    const after = graphToCode(nodes, edges, NODE_REGISTRY).code;

    expect(after).toBe(before);
    expect(after).not.toContain('Sunset');
    expect(after).not.toContain('palette');
  });
});

describe('project block round trip', () => {
  const projectWith = (palettes?: unknown): string =>
    embedProjectState(SCRIPT, {
      version: 1,
      shaderName: 'Imported',
      graph: { nodes: [makeNode('out', 'output')], edges: [] },
      ...(palettes === undefined ? {} : { palettes }),
      preview: {},
      ui: {},
    } as unknown as FastShadersProject);

  it('export -> import restores the palettes', () => {
    deterministicState(PALETTES);
    const embedded = embedProjectState(SCRIPT, buildProjectState());

    useAppStore.setState({ shaderPalettes: [] });
    expect(importShaderText(embedded)).toBe('project');
    expect(useAppStore.getState().shaderPalettes).toEqual(PALETTES);
  });

  it('export -> import round-trips the per-colour labels', () => {
    deterministicState(NAMED);
    const embedded = embedProjectState(SCRIPT, buildProjectState());
    expect(embedded).toContain('"names"');

    useAppStore.setState({ shaderPalettes: [] });
    expect(importShaderText(embedded)).toBe('project');
    expect(useAppStore.getState().shaderPalettes).toEqual(NAMED);
  });

  it('a label carrying the comment terminator cannot close the block early', () => {
    // The block is a trailing `/* … */` comment and JSON.stringify does not
    // escape `*/` inside a string, so every free-text field embedded here has
    // to go through embedProjectState's terminator escape. Per-colour labels
    // are the newest such field and the easiest to forget.
    deterministicState([{ id: 'p1', name: 'Metals', colors: ['#ffe39d'], names: ['Gold */ evil'] }]);
    const embedded = embedProjectState(SCRIPT, buildProjectState());
    // Exactly one terminator in the file: the block's own.
    expect(embedded.split('*/')).toHaveLength(2);

    useAppStore.setState({ shaderPalettes: [] });
    expect(importShaderText(embedded)).toBe('project');
    // And it decodes back losslessly — escaping must not corrupt the label.
    expect(useAppStore.getState().shaderPalettes[0].names).toEqual(['Gold */ evil']);
  });

  it('a file written before labels existed imports unchanged — no key is invented', () => {
    useAppStore.setState({ shaderPalettes: [] });
    importShaderText(projectWith(PALETTES));
    const out = useAppStore.getState().shaderPalettes;
    expect(out).toEqual(PALETTES);
    // Not `names: []`. An invented empty array would be re-exported on the next
    // download, so simply opening and saving an old shader would change its
    // bytes — the exact thing the omission rule exists to prevent.
    expect(out.every((p) => !('names' in p))).toBe(true);
  });

  it('a shared file cannot misalign the labels: a rejected colour drops its OWN', () => {
    // The import boundary rebuilds both arrays in one loop, so a colour the
    // whitelist refuses takes its label with it. Reading `names` in a second
    // pass would keep ['Red', 'Bogus'] and label the BLUE swatch "Bogus" —
    // every later name shifted by one, and nothing on screen looking broken.
    useAppStore.setState({ shaderPalettes: [] });
    importShaderText(projectWith([
      { id: 'q1', name: 'Mixed', colors: ['#ff0000', 'nope', '#0000ff'], names: ['Red', 'Bogus', 'Blue'] },
    ]));
    const out = useAppStore.getState().shaderPalettes[0];
    expect(out.colors).toEqual(['#ff0000', '#0000ff']);
    expect(out.names).toEqual(['Red', 'Blue']);
  });

  it('sanitizes the labels too — they are rendered, and they are newer and quieter', () => {
    useAppStore.setState({ shaderPalettes: [] });
    importShaderText(projectWith([
      { id: 'q2', name: 'ok', colors: ['#ff0000', '#00ff00'], names: ['ev\u202eil', 42] },
    ]));
    const out = useAppStore.getState().shaderPalettes[0];
    // A non-string label is not a label; it must NOT shift the one after it.
    expect(out.names).toEqual(['evil', '']);
  });

  it('a file carrying NO palettes CLEARS the ones already open', () => {
    // Same reasoning as the uniform-values else-branch: an import replaces the
    // graph, so it must replace the palettes that belong to it — otherwise
    // someone else's shader silently adopts yours and re-exports them as its own.
    useAppStore.setState({ shaderPalettes: PALETTES });
    expect(importShaderText(projectWith(undefined))).toBe('project');
    expect(useAppStore.getState().shaderPalettes).toEqual([]);
  });

  it('an empty palettes array clears them too', () => {
    useAppStore.setState({ shaderPalettes: PALETTES });
    importShaderText(projectWith([]));
    expect(useAppStore.getState().shaderPalettes).toEqual([]);
  });

  it('sanitizes an adversarial palettes block from a shared file', () => {
    useAppStore.setState({ shaderPalettes: [] });
    importShaderText(projectWith([
      { id: '__proto__', name: 'ev\u202eil', colors: ['#FF0000', 'red', '#abc'] },
      { name: 'colourless', colors: ['nope'] },
      'not an object',
    ]));

    const out = useAppStore.getState().shaderPalettes;
    expect(out).toHaveLength(1);
    expect(out[0].id).not.toBe('__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(out[0].name).toBe('evil');
    expect(out[0].colors).toEqual(['#ff0000']);
  });

  it('a pre-palette file (no key) still imports as a full project', () => {
    // The compatibility half of "no version bump": nothing about the block's
    // acceptance depends on the new field.
    const result = extractProjectState(projectWith(undefined));
    expect(result).not.toBeNull();
    expect(result!.project.palettes).toBeUndefined();
    expect(result!.project.version).toBe(1);
  });

  it('a NEW file stays readable by a build that knows nothing of palettes', () => {
    // extractProjectState reads fields by name; an unknown key is inert.
    const parsed = extractProjectState(projectWith(PALETTES))!;
    expect(parsed.project.version).toBe(1);
    expect(parsed.project.graph.nodes).toHaveLength(1);
    expect(parsed.stripped).toBe(SCRIPT);
  });
});

describe('bare-script import clears palettes', () => {
  it('a bare .js carries no palettes, so the previous shader’s must not ride onto it', () => {
    useAppStore.setState({ shaderPalettes: [{ id: 'p1', name: 'Old', colors: ['#ff0000'] }] });
    expect(useAppStore.getState().shaderPalettes).toHaveLength(1);
    // A minimal shaderloader-style module with no FASTSHADERS_PROJECT_V1 block.
    importShaderText(
      "import { Fn, vec3 } from 'three/tsl';\nconst shader = Fn(() => vec3(1, 0, 0));\nexport default shader;\n",
    );
    expect(useAppStore.getState().shaderPalettes).toEqual([]);
  });
});
