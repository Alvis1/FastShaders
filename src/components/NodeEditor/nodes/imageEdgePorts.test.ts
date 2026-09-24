/**
 * The Image (Texture) node's sockets ride the card's BORDER, spread evenly and
 * centred on the picture, and carry NO text (2026-09-19). Replaces
 * `imageOutputRows.test.ts`, which pinned the labelled-rows era — itself a
 * replacement for `imageOutputSocket.test.ts` and its one-output centred card
 * socket. Each of the three had to go for the same reason: it pinned the
 * layout, and the layout is what changed.
 *
 * What this file guards, in the order the failures would be confusing in:
 *  1. the geometry is ONE pure module (`edgePorts.ts`) and both surfaces read
 *     it — a copied formula is how the canvas and a palette tile end up
 *     drawing the same node with its sockets in different places;
 *  2. rule #8 is RESTORED, not re-excepted: `LABELLED_OUTPUT_TYPES` is EMPTY
 *     and `.shader-node__in-label` is gone from the app. Both are NEGATIVE
 *     pins — they fail when the labels come BACK, which is the direction this
 *     drifts;
 *  3. the Data node keeps its exception (8a): its labels are CSV headers, user
 *     data, and the only thing telling N identical float sockets apart;
 *  4. the output order after `out` is r, g, b, alpha, on both surfaces;
 *  5. one handle per output id — a leftover row-anchored handle beside a rail
 *     handle mounts the same port twice and React Flow measures whichever it
 *     picked.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as ShaderNodeModule from './ShaderNode';
import {
  buildRows,
  visiblePortRows,
  outputRowLabel,
  LABELLED_OUTPUT_TYPES,
  IMAGE_EMPTY_HINT,
} from './ShaderNode';
import { edgePortOffset, edgePortRailHeight, usesEdgePorts, EDGE_PORT_PITCH, EDGE_PORT_TYPES } from './edgePorts';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { effectiveNodeDef } from '@/utils/exposedPorts';
import { IMAGE_CHANNEL_COMPONENTS } from '@/utils/imageChannels';
import { t } from '@/i18n';
import { plainStr } from '@/utils/valueCoerce';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const SHADER_NODE = read('./ShaderNode.tsx');
const NODE_VISUAL = read('./NodeVisual.tsx');
const SHADER_CSS = read('./ShaderNode.css');
const EDGE_PORTS = read('./edgePorts.ts');

const imageDef = NODE_REGISTRY.get('imageNode')!;
const CHANNEL_ORDER = ['out', 'r', 'g', 'b', 'alpha'];

describe('edgePorts — the ONE geometry', () => {
  it('is a LEAF: it imports nothing', () => {
    // The costTable lesson. ShaderNode, NodeVisual and these tests all read
    // it; a module in that position inside the store's import cycle throws a
    // TDZ ReferenceError that depends on which file a worker reached first.
    expect(EDGE_PORTS).not.toMatch(/^\s*import /m);
  });

  it('centres the column whatever the port count is', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 9]) {
      const offs = Array.from({ length: n }, (_, i) => edgePortOffset(i, n));
      const sum = offs.reduce((a, b) => a + b, 0);
      expect(sum, `n=${n}`).toBeCloseTo(0, 10);
      // Ascending, and exactly one pitch apart.
      for (let i = 1; i < n; i++) expect(offs[i] - offs[i - 1]).toBeCloseTo(EDGE_PORT_PITCH, 10);
    }
  });

  it('a lone port sits dead centre — and so does a degenerate count', () => {
    expect(edgePortOffset(0, 1)).toBe(0);
    expect(edgePortOffset(0, 0)).toBe(0);
    expect(edgePortOffset(3, -2)).toBe(0);
  });

  it('the pitch is one row: an edge-port column is as dense as the rows it replaced', () => {
    const rule = /\.node-base__row \{([^}]*)\}/.exec(read('./NodeBase.css'))!;
    expect(rule[1]).toContain(`min-height: ${EDGE_PORT_PITCH}px`);
  });

  it('the rail floor covers the TALLER column and never goes negative', () => {
    expect(edgePortRailHeight(6, 5)).toBe(6 * EDGE_PORT_PITCH);
    expect(edgePortRailHeight(0, 5)).toBe(5 * EDGE_PORT_PITCH);
    expect(edgePortRailHeight(0, 0)).toBe(0);
    expect(edgePortRailHeight(-3, -1)).toBe(0);
  });

  it('is the Image node alone — the Data node is NOT one', () => {
    expect([...EDGE_PORT_TYPES]).toEqual(['imageNode']);
    expect(usesEdgePorts('imageNode')).toBe(true);
    // A CSV column's header is the only thing telling its socket from the
    // next; an edge-port node has no text, so the Data node cannot be one.
    expect(usesEdgePorts('dataNode')).toBe(false);
    expect(usesEdgePorts(undefined)).toBe(false);
    for (const type of NODE_REGISTRY.keys()) {
      if (type === 'imageNode') continue;
      expect(usesEdgePorts(type), type).toBe(false);
    }
  });

  it('the Image node keeps a socket for every registry port, both edges', () => {
    // The rail is indexed against the FULL lists, so this is what it spreads.
    expect(imageDef.inputs).toHaveLength(6);
    expect(imageDef.outputs).toHaveLength(5);
    expect(edgePortRailHeight(imageDef.inputs.length, imageDef.outputs.length)).toBe(84);
  });
});

describe('both surfaces read the same geometry', () => {
  it('ShaderNode and NodeVisual each call the shared helpers', () => {
    for (const [name, src] of [['ShaderNode', SHADER_NODE], ['NodeVisual', NODE_VISUAL]] as const) {
      expect(src, name).toContain("from './edgePorts'");
      expect(src, name).toMatch(/usesEdgePorts\(/);
      expect(src, name).toMatch(/edgePortOffset\(/);
      expect(src, name).toMatch(/edgePortRailHeight\(/);
      // The rows are EMPTIED rather than the body being branched around, so
      // `.node-base__body` collapses instead of rendering an empty strip.
      expect(src, name).toMatch(/edgePorts \? \[\] : visiblePortRows\(/);
      // An authored designer offset still wins, per socket — same px units.
      expect(src, name).toMatch(/\?\? edgePortOffset\(/);
      expect(src, name).toContain('shader-node__edge-region');
    }
  });

  it('the region is the positioning ancestor and centres its content', () => {
    const css = SHADER_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const block = /\.shader-node__edge-region \{([^}]*)\}/.exec(css);
    expect(block).not.toBeNull();
    expect(block![1]).toContain('justify-content: center');
    // NOT the default `stretch`: the cross axis of a column is horizontal, so
    // stretch pulls the thumbnail to the card width and distorts every picture.
    expect(block![1]).toContain('align-items: center');
  });

  it('the picture lives INSIDE the region on both surfaces', () => {
    // The sockets are centred on the region; a picture outside it would leave
    // them centred on nothing the user can see.
    for (const [name, src] of [['ShaderNode', SHADER_NODE], ['NodeVisual', NODE_VISUAL]] as const) {
      const region = src.indexOf('shader-node__edge-region');
      const slot = src.indexOf('<ImageThumbEmpty');
      expect(region, name).toBeGreaterThan(-1);
      expect(slot, name).toBeGreaterThan(region);
    }
    // ShaderNode's real thumbnail too.
    const region = SHADER_NODE.indexOf('shader-node__edge-region');
    expect(SHADER_NODE.indexOf('className="shader-node__image-thumb"')).toBeGreaterThan(region);
  });

  it('the drag-reveal happens IN the rail, never twice', () => {
    // Two independent placements of the same six hidden sockets is how they
    // end up drawn on top of each other.
    expect(SHADER_NODE).toMatch(/\{revealHidden && !edgePorts && \(/);
    expect(SHADER_NODE).toMatch(/if \(!exposed && !revealHidden\) return null;/);
  });

  it('the handle re-measure key follows the thing the sockets are centred on', () => {
    // Offsets from the region's CENTRE: the region changing height moves every
    // socket, and React Flow measures handles once per updateNodeInternals.
    expect(SHADER_NODE).toMatch(/const imageGeomKey = edgePorts/);
    expect(SHADER_NODE).toMatch(/imageGeomKey;/);
    expect(SHADER_NODE).toMatch(/onLoad=\{\(\) => updateNodeInternals\(id\)\}/);
  });
});

describe('rule #8 is restored, not re-excepted', () => {
  it('LABELLED_OUTPUT_TYPES is EMPTY — the negative pin', () => {
    // It fails when a type comes BACK, which is the direction this drifts.
    expect([...LABELLED_OUTPUT_TYPES]).toEqual([]);
    for (const [type, def] of NODE_REGISTRY) {
      for (const o of def.outputs) {
        expect(outputRowLabel(type, o, false, 'en'), `${type}.${o.id}`).toBeNull();
      }
    }
    expect(outputRowLabel(undefined, imageDef.outputs[0], false, 'en')).toBeNull();
  });

  it('the Image node draws no text beside any socket, output or input', () => {
    for (const o of imageDef.outputs) {
      expect(outputRowLabel('imageNode', o, false, 'en'), o.id).toBeNull();
      expect(outputRowLabel('imageNode', o, false, 'lv'), o.id).toBeNull();
    }
    // `.shader-node__in-label` was the ONE on-card input label in the app.
    // The RENDER is what must be gone; both files keep a scar comment naming
    // the retired class, which is the thing that stops it being re-added.
    expect(SHADER_NODE).not.toContain('className="shader-node__in-label"');
    expect(NODE_VISUAL).not.toContain('className="shader-node__in-label"');
    const css = SHADER_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toContain('.shader-node__in-label');
  });

  it('the names are still reachable — the socket carries them itself', () => {
    // Hover, a touch tap, and the double-click pin all read TypedHandle's
    // `data-tooltip`, which is built from the `label` prop. Every rail handle
    // must pass one or the node becomes anonymous.
    const rail = SHADER_NODE.slice(SHADER_NODE.indexOf('{edgePorts && ('));
    expect(rail).toMatch(/label=\{inp\.label\}/);
    expect(rail).toMatch(/label=\{out\.label\}/);
    const vRail = NODE_VISUAL.slice(NODE_VISUAL.indexOf('{edgePorts &&'));
    expect(vRail).toMatch(/label=\{out\.label\}/);
  });

  it('keeps 8a: a Data column header prints VERBATIM, even in Latvian', () => {
    // A CSV header is user data: one named "Color" must not become "Krāsa".
    const col = { id: 'col0', label: 'Color', dataType: 'float' as const };
    expect(outputRowLabel('dataNode', col, true, 'lv')).toBe('Color');
    expect(outputRowLabel('dataNode', col, true, 'en')).toBe('Color');
  });

  it('the out-label span survives for the Data node, and only through outputRowLabel', () => {
    expect(SHADER_NODE).not.toMatch(/data\.dynamicOutputs && \(/);
    for (const [name, src] of [['ShaderNode', SHADER_NODE], ['NodeVisual', NODE_VISUAL]] as const) {
      const at = [...src.matchAll(/className="shader-node__out-label"/g)].map((m) => m.index!);
      expect(at.length, name).toBeGreaterThan(0);
      for (const i of at) {
        expect(src.slice(Math.max(0, i - 300), i), name).toContain('outputRowLabel(');
      }
    }
    expect(NODE_VISUAL).toContain('outputRowLabel(def.type, output, false, language)');
  });
});

describe('the Image node rows are gone, but its port TABLE is intact', () => {
  it('buildRows still pairs in registry order: Color, R, G, B, Alpha', () => {
    // buildRows is not reached for this node any more (visibleRows is []), but
    // it is the shared shape every other surface and test reasons about, and
    // the order IS the socket order the rail spreads.
    const rows = buildRows(effectiveNodeDef(imageDef, []));
    expect(rows.map((r) => r.output?.id)).toEqual(CHANNEL_ORDER);
    expect(imageDef.outputs.map((o) => o.id)).toEqual(['out', ...IMAGE_CHANNEL_COMPONENTS.keys()]);
    expect(imageDef.outputs.map((o) => o.label)).toEqual(['Color', 'R', 'G', 'B', 'Alpha']);
    for (const r of rows) {
      expect(r.input).toBeNull();
      expect(r.settingKey).toBeNull();
    }
    expect(visiblePortRows(rows, {}, imageDef.outputs)).toHaveLength(5);
  });

  it('an exposed param pairs with Color on row 0', () => {
    const rows = buildRows(effectiveNodeDef(imageDef, ['uv']));
    expect(rows[0].input?.id).toBe('uv');
    expect(rows[0].output?.id).toBe('out');
    expect(rows.map((r) => r.output?.id)).toEqual(CHANNEL_ORDER);
  });

  it('all six params exposed: six rows, the sixth input-only', () => {
    const rows = buildRows(effectiveNodeDef(imageDef, imageDef.inputs.map((i) => i.id)));
    expect(rows).toHaveLength(6);
    expect(rows[5].input?.id).toBe('dir');
    expect(rows[5].output).toBeNull();
  });

  it('`out` is still outputs[0] — the one line that cannot be relaxed', () => {
    // Drop-on-edge insertion, a dropped wire, ⌘-click Preview, cpuEvaluator's
    // shape fallback and dragConnect's phantom-tile tie-break all mean it.
    expect(imageDef.outputs[0]).toMatchObject({ id: 'out', dataType: 'vec3' });
  });
});

describe('one handle per output id', () => {
  it('the only card-level first-output handle left is the designer-moved one', () => {
    // ShaderNode: two `id={def.outputs[0].id}` handles — the operator layout's
    // own (a different branch) and the rows layout's designer-moved one. The
    // rail maps over `def.outputs` and indexes nothing, so it adds none.
    expect(SHADER_NODE.match(/id=\{def\.outputs\[0\]\.id\}/g)).toHaveLength(2);
    expect(SHADER_NODE).toMatch(/\{def\.outputs\[0\] && \(\s*<TypedHandle/);
    // Guarded on !edgePorts: an edge-port node placed every socket in the
    // rail, designer override included, and reaching here too mounts it twice.
    expect(SHADER_NODE).toMatch(/\{!edgePorts && rowsOutOff != null && def\.outputs\[0\] && \(\s*<TypedHandle/);
    expect(SHADER_NODE).toMatch(/if \(edgePorts \|\| off == null\) return null;/);
    // NodeVisual: the operator layout's own, and the rows layout's moved one.
    expect(NODE_VISUAL.match(/port=\{def\.outputs\[0\]\.id\}/g)).toHaveLength(2);
    // Guarded on !edgePorts for the same reason ShaderNode's is: the rail
    // already placed `out`, designer override included, and the Designer's
    // corner drag authors `sockets.out` on any height change — so an
    // unguarded mirror here mounts the same dot twice at the same `top`.
    expect(NODE_VISUAL).toMatch(/\{!edgePorts && outMoved && \(\s*<StaticHandle/);
  });

  it('the one-output era stays retired', () => {
    expect('centersOutputSocket' in ShaderNodeModule).toBe(false);
    for (const src of [SHADER_NODE, NODE_VISUAL]) {
      expect(src).not.toContain('centersOutputSocket');
      expect(src).not.toMatch(/\bcenterOut\b/);
    }
    expect(visiblePortRows.length).toBe(3);
    expect(SHADER_NODE).not.toContain('outCentered');
  });

  it('beside its own socket only — one condition drops both when the designer moves `out`', () => {
    expect(SHADER_NODE).toMatch(/if \(!output \|\| \(outDetached && output === def\.outputs\[0\]\)\) return null;/);
    expect(NODE_VISUAL).toMatch(/if \(!output \|\| \(outMoved && output === def\.outputs\[0\]\)\) return null;/);
  });
});

describe('the empty slot still names the one control that fills the node', () => {
  it('IMAGE_EMPTY_HINT is translated and points at the Texture row', () => {
    expect(t(IMAGE_EMPTY_HINT, 'lv')).not.toBe(IMAGE_EMPTY_HINT);
  });
});

/**
 * The handle re-measure key reads FOUR untrusted `values` entries, in a render
 * body, on every Image node. `values` arrives verbatim from a `.fastshader`,
 * `fs:graph` or `fs:savedGroups` and no sanitizer coerces its entries —
 * `sanitizeImageNodes` deliberately leaves a NON-STRING payload in place, and
 * `width`/`height` are seen by no sanitizer at all.
 *
 * `String()` THROWS on `{toString: 1}`. Thrown from a render body, with no
 * error boundary anywhere in this app, that unmounts the root and the screen
 * goes blank — and the 300 ms autosave is a store SUBSCRIPTION, outside React,
 * so it writes the poisoned graph back and every reload blanks again. This is
 * the guard.
 */
describe('the re-measure key is adversarial-safe', () => {
  it('plainStr never throws, whatever a tampered file carries', () => {
    const poison: unknown[] = [
      { toString: 1 },
      { toString: null },
      Object.create(null),
      { valueOf: 1, toString: 1 },
      Symbol('x'),
      [1, 2, 3],
      () => 'x',
      null,
      undefined,
      true,
      new Map(),
    ];
    for (const v of poison) {
      expect(() => plainStr(v), String(typeof v)).not.toThrow();
      expect(typeof plainStr(v)).toBe('string');
    }
  });

  it('keeps the only two types a real payload has, and nothing else', () => {
    expect(plainStr('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(plainStr(1024)).toBe('1024');
    expect(plainStr(0)).toBe('0');
    // An ARRAY coerces without throwing — the quiet variant: a million-element
    // array would build a multi-megabyte key twice per render.
    expect(plainStr(new Array(1000).fill(7))).toBe('');
  });

  it('every entry the key reads goes through it — no bare String() survives', () => {
    const key = SHADER_NODE.slice(
      SHADER_NODE.indexOf('const geomPayload ='),
      SHADER_NODE.indexOf('const exposedKey ='),
    );
    expect(key.length).toBeGreaterThan(0);
    expect(key).not.toMatch(/String\(/);
    for (const entry of ['imageB64', 'srcWidth', 'srcHeight', 'width', 'height', 'fileName']) {
      expect(key, entry).toContain(entry);
    }
    expect([...key.matchAll(/plainStr\(/g)]).toHaveLength(6);
  });
});
