/**
 * The Image (Texture) node's OUTPUTS are labelled rows, Color first
 * (GLB Phase 4 Step 4). Replaces `imageOutputSocket.test.ts`, which pinned the
 * one-output era's centred card socket (`centersOutputSocket`, retired with
 * it: five sockets have no single centre).
 *
 * Five things, each a way the two surfaces drift apart without a test failing:
 *  1. the centred socket is GONE from both files — a leftover card-level
 *     handle beside the row handle would mount `out` twice, and React Flow
 *     measures whichever it picked;
 *  2. the rows: Color on row 0, then Alpha / R / G / B, and no param rows on a
 *     fresh node;
 *  3. `outputRowLabel` is the exception set to NODE_DESIGN_REQUIREMENTS #8 —
 *     the Data node verbatim, the Image node translated, every other node
 *     null (a third labelled type fails here);
 *  4. both files draw `.shader-node__out-label` ONLY through `outputRowLabel`;
 *  5. the only card-level first-output handle left is the designer-moved one.
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
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { effectiveNodeDef } from '@/utils/exposedPorts';
import { t } from '@/i18n';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const SHADER_NODE = read('./ShaderNode.tsx');
const NODE_VISUAL = read('./NodeVisual.tsx');

const imageDef = NODE_REGISTRY.get('imageNode')!;
const CHANNEL_ORDER = ['out', 'alpha', 'r', 'g', 'b'];

describe('the centred card socket is retired', () => {
  it('is no longer exported, and neither surface mentions it', () => {
    expect('centersOutputSocket' in ShaderNodeModule).toBe(false);
    for (const src of [SHADER_NODE, NODE_VISUAL]) {
      expect(src).not.toContain('centersOutputSocket');
      expect(src).not.toMatch(/\bcenterOut\b/);
    }
  });

  it('visiblePortRows takes three arguments — the outCentered flag went with it', () => {
    expect(visiblePortRows.length).toBe(3);
    expect(SHADER_NODE).not.toContain('outCentered');
  });
});

describe('the Image node rows', () => {
  it('a fresh node: five output-only rows, Color first', () => {
    const rows = buildRows(effectiveNodeDef(imageDef, []));
    expect(rows.map((r) => r.output?.id)).toEqual(CHANNEL_ORDER);
    for (const r of rows) {
      expect(r.input).toBeNull();
      expect(r.settingKey).toBeNull();
    }
    // Nothing is designer-moved, so every row still draws.
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
});

describe('outputRowLabel — the recorded exceptions to rule #8', () => {
  it('labels the Image node, translated', () => {
    const en = imageDef.outputs.map((o) => outputRowLabel('imageNode', o, false, 'en'));
    expect(en).toEqual(['Color', 'Alpha', 'R', 'G', 'B']);
    const lv = imageDef.outputs.map((o) => outputRowLabel('imageNode', o, false, 'lv'));
    expect(lv).toEqual(['Krāsa', 'Alfa', 'R', 'G', 'B']);
  });

  it('prints a Data column header VERBATIM, even in Latvian', () => {
    // A CSV header is user data: one named "Color" must not become "Krāsa".
    const col = { id: 'col0', label: 'Color', dataType: 'float' as const };
    expect(outputRowLabel('dataNode', col, true, 'lv')).toBe('Color');
    expect(outputRowLabel('dataNode', col, true, 'en')).toBe('Color');
  });

  it('is null for every other node — the exception set is exactly the Image node', () => {
    expect([...LABELLED_OUTPUT_TYPES]).toEqual(['imageNode']);
    for (const [type, def] of NODE_REGISTRY) {
      if (type === 'imageNode') continue;
      for (const o of def.outputs) {
        expect(outputRowLabel(type, o, false, 'en'), `${type}.${o.id}`).toBeNull();
      }
    }
    expect(outputRowLabel(undefined, imageDef.outputs[0], false, 'en')).toBeNull();
  });
});

describe('where the label is drawn', () => {
  it('only ever through outputRowLabel, on both surfaces', () => {
    // The Data node's old inline form is gone.
    expect(SHADER_NODE).not.toMatch(/data\.dynamicOutputs && \(/);
    for (const [name, src] of [['ShaderNode', SHADER_NODE], ['NodeVisual', NODE_VISUAL]] as const) {
      const at = [...src.matchAll(/className="shader-node__out-label"/g)].map((m) => m.index!);
      expect(at.length, name).toBeGreaterThan(0);
      for (const i of at) {
        expect(src.slice(Math.max(0, i - 300), i), name).toContain('outputRowLabel(');
      }
    }
  });

  it('beside its own socket only — one condition drops both when the designer moves `out`', () => {
    expect(SHADER_NODE).toMatch(/if \(!output \|\| \(outDetached && output === def\.outputs\[0\]\)\) return null;/);
    expect(NODE_VISUAL).toMatch(/if \(!output \|\| \(outMoved && output === def\.outputs\[0\]\)\) return null;/);
  });

  it('the replica never claims dynamic outputs', () => {
    expect(NODE_VISUAL).toContain('outputRowLabel(def.type, output, false, language)');
  });
});

describe('one handle per output id', () => {
  it('the only card-level first-output handle left is the designer-moved one', () => {
    // ShaderNode: two `id={def.outputs[0].id}` handles — the operator
    // layout's own (a different branch, never rendered beside the rows) and
    // the rows layout's region-relative designer-moved one.
    expect(SHADER_NODE.match(/id=\{def\.outputs\[0\]\.id\}/g)).toHaveLength(2);
    expect(SHADER_NODE).toMatch(/\{def\.outputs\[0\] && \(\s*<TypedHandle/);
    expect(SHADER_NODE).toMatch(/\{rowsOutOff != null && def\.outputs\[0\] && \(\s*<TypedHandle/);
    // NodeVisual: the operator layout's own, and the rows layout's moved one.
    expect(NODE_VISUAL.match(/port=\{def\.outputs\[0\]\.id\}/g)).toHaveLength(2);
    expect(NODE_VISUAL).toMatch(/\{outMoved && \(\s*<StaticHandle/);
  });
});

describe('the empty slot', () => {
  it('has a Latvian label and hint', () => {
    expect(t('No image', 'lv')).toBe('Nav attēla');
    expect(t(IMAGE_EMPTY_HINT, 'lv')).not.toBe(IMAGE_EMPTY_HINT);
  });
});
