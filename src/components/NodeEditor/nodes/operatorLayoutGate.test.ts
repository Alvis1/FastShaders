import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NODE_REGISTRY, growsOperands, getAllDefinitions } from '@/registry/nodeRegistry';
import { hasNodeGlyph, usesOperatorLayout } from './glyphs/NodeGlyph';

/**
 * The operator/list layout gate lives in FOUR files, and nothing fails loudly
 * when one of them drifts.
 *
 * All four used to read `hasNodeGlyph(type) && def.inputs.length === 2`, which
 * quietly made "has art" the test for "grows sockets". That is wrong for
 * exactly one node, and it was the node that needed it most: `append` is
 * DELIBERATELY glyphless (glyphCoverage.test.ts's exempt list — its socket set
 * IS its meaning), so it fell into the rows layout, and the rows layout is the
 * only branch that never calls `effectiveInputs`. The registry, the splice, the
 * operand compaction, the evaluator and codegen had all been taught to grow it;
 * the renderer showed two sockets forever, with no UI path to a third.
 *
 * That failure is invisible from every other angle. `append` still renders,
 * still emits valid code, still round-trips — it simply cannot be given a third
 * operand, which reads as the node being finished rather than broken. Restoring
 * the glyph-only gate in ANY of the four would bring it straight back, and the
 * ShaderNode/NodeVisual pair would additionally break the one-node-one-look
 * rule silently in one direction only (canvas grows, tile does not, or vice
 * versa).
 *
 * Mostly source greps: three of the four sites are React and the vitest env is
 * `node`, and the fourth (`designerApp.ts`) is `@ts-nocheck` vanilla with no
 * other coverage. A grep cannot prove the layout is right, but it can prove the
 * predicate someone would inline while tidying is still the one being asked.
 * The behavioural block at the bottom covers the predicate itself.
 */

const nodes = fileURLToPath(new URL('.', import.meta.url));
const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const glyph = readFileSync(nodes + 'glyphs/NodeGlyph.tsx', 'utf8');
const shaderNode = readFileSync(nodes + 'ShaderNode.tsx', 'utf8');
const nodeVisual = readFileSync(nodes + 'NodeVisual.tsx', 'utf8');
const layoutEngine = src('../../../engine/layoutEngine.ts');
const designerApp = src('../../../nodeDesigner/designerApp.ts');
const ndData = src('../../../nodeDesigner/ndData.ts');

/**
 * The gate as it was before the fix, in every spelling it actually appeared in:
 *   hasNodeGlyph(def.type, design) && def.inputs.length === 2   (NodeVisual)
 *   hasNodeGlyph(data.registryType) && def.inputs.length === 2  (ShaderNode)
 *   def != null && hasNodeGlyph(type) && def.inputs.length === 2 (layoutEngine)
 * plus the reversed operand order, since that is what a reformat produces.
 *
 * Deliberately tolerant about whitespace/newlines and the receiver expression,
 * and deliberately STRICT about requiring the `inputs.length === 2` half: all
 * three files still call `hasNodeGlyph` on its own to decide whether to draw the
 * glyph ART (`{!chainListMode && hasNodeGlyph(...) && (`, `hasNodeGlyph(type) ?
 * GLYPH_H : 0`). Those are correct and must keep working, so a looser regex
 * matching a bare `hasNodeGlyph(...) &&` would fail on the fixed tree.
 */
const OLD_GATE =
  /hasNodeGlyph\s*\([^)]*\)\s*&&\s*[\w.]*\binputs\.length\s*===\s*2|[\w.]*\binputs\.length\s*===\s*2\s*&&\s*hasNodeGlyph\s*\(/;

/** The three TS/TSX sites that must delegate to the shared predicate. */
const GATE_SITES: { file: string; source: string }[] = [
  { file: 'nodes/ShaderNode.tsx', source: shaderNode },
  { file: 'nodes/NodeVisual.tsx', source: nodeVisual },
  { file: 'engine/layoutEngine.ts', source: layoutEngine },
];

describe('the predicate exists and asks both questions', () => {
  it('NodeGlyph exports usesOperatorLayout', () => {
    expect(glyph).toMatch(/export function usesOperatorLayout\s*\(/);
  });

  it('its body tests hasNodeGlyph OR growsOperands', () => {
    /* Either half alone reintroduces a bug. Without `growsOperands`, `append`
       loses its grow sockets again (the original defect). Without
       `hasNodeGlyph`, every glyphed non-growing operator — pow, mod, min, max,
       the comparisons, dot/cross/distance — drops out of the operator layout
       and redraws as rows, which is the same regression aimed at twelve nodes
       instead of one. */
    const m = /export function usesOperatorLayout\([\s\S]*?\)\s*:\s*boolean\s*\{([\s\S]*?)\n\}/.exec(glyph);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body).toContain('hasNodeGlyph(');
    expect(body).toContain('growsOperands(');
    expect(body).toMatch(/hasNodeGlyph\([^)]*\)\s*\|\|\s*growsOperands\(/);
    // and it is `growsOperands` from the registry, not a local re-derivation
    // that could disagree with effectiveInputs about which nodes grow
    expect(glyph).toMatch(/import \{[^}]*growsOperands[^}]*\} from '@\/registry\/nodeRegistry'/);
  });
});

describe('all four gates ask the one predicate', () => {
  it.each(GATE_SITES)('$file calls usesOperatorLayout', ({ source }) => {
    expect(source).toContain('usesOperatorLayout(');
  });

  it.each(GATE_SITES)('$file no longer gates on the glyph alone', ({ source }) => {
    expect(OLD_GATE.test(source)).toBe(false);
  });

  it('the canvas node and its replica agree', () => {
    /* One-node-one-look: ShaderNode is the live implementation and NodeVisual
       is the static replica behind the asset tiles, the node-editor overview
       and the Node Designer's stage. If only one is converted, `append` grows
       on the canvas and shows two sockets on every preview surface (or the
       reverse) — a drift no test outside this pair would notice. */
    expect(shaderNode).toContain('usesOperatorLayout(def)');
    expect(nodeVisual).toContain('usesOperatorLayout(def, design)');
  });

  it('the Node Designer mirrors it over its own draft state', () => {
    /* The designer cannot call the predicate — it is measuring an UNSAVED draft
       glyph, not the saved table — so `layoutIsOp()` restates it. Gating on the
       draft glyph alone left `append` measured against a `.shader-node__region`
       the stage no longer draws for it. */
    const m = /function layoutIsOp\(\)\s*\{([^\n]*)/.exec(designerApp);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body).toContain('state.glyph');
    expect(body).toMatch(/\.grows/);
    expect(body).toMatch(/\.in\.length === 2/);
  });

  it('NdNodeInfo carries `grows`, sourced from the registry', () => {
    // …which is the only way the vanilla designer can see `variadic` at all.
    expect(ndData).toMatch(/grows:\s*boolean/);
    expect(ndData).toMatch(/grows:\s*growsOperands\(d\)/);
    expect(ndData).toMatch(/import \{[^}]*growsOperands[^}]*\} from '@\/registry\/nodeRegistry'/);
  });
});

describe('the predicate answers correctly for the nodes that made it necessary', () => {
  const def = (type: string) => {
    const d = NODE_REGISTRY.get(type);
    expect(d, `${type} missing from the registry`).toBeDefined();
    return d!;
  };

  it('append uses the operator layout despite having no glyph', () => {
    // the whole reason this predicate exists
    expect(hasNodeGlyph('append')).toBe(false);
    expect(growsOperands(def('append'))).toBe(true);
    expect(usesOperatorLayout(def('append'))).toBe(true);
  });

  it.each(['mul', 'add'])('%s still uses it (glyphed AND growing)', (type) => {
    expect(usesOperatorLayout(def(type))).toBe(true);
  });

  it.each(['pow', 'dot'])('%s still uses it (glyphed, not growing)', (type) => {
    // the half a `growsOperands`-only gate would silently drop
    expect(growsOperands(def(type))).toBe(false);
    expect(usesOperatorLayout(def(type))).toBe(true);
  });

  it('vec2 stays in the rows layout', () => {
    /* The negative case, and the sharpest one available: `vec2` is glyphless
       (NODE_DESIGN_REQUIREMENTS #15 — vec* are plain number rows) with exactly
       two inputs, so it differs from `append` by `variadic` alone. It is also
       the node `append` is textually confused with — an unwired Append emits
       `vec2(0, 0)` — so a predicate that widened to "glyphless 2-input" would
       grow sockets on the one node whose two ports are its definition. */
    expect(hasNodeGlyph('vec2')).toBe(false);
    expect(growsOperands(def('vec2'))).toBe(false);
    expect(usesOperatorLayout(def('vec2'))).toBe(false);
  });

  it('the operator layout is exactly the 2-input glyph-or-grows set', () => {
    /* A whole-registry sweep rather than a snapshot: it names the node if a
       future def lands on the wrong side, without pinning a list that has to be
       edited every time a node is added. */
    for (const d of getAllDefinitions()) {
      const expected = d.inputs.length === 2 && (hasNodeGlyph(d.type) || growsOperands(d));
      expect(usesOperatorLayout(d), d.type).toBe(expected);
    }
    // a non-2-input node never takes it, however it is drawn
    expect(usesOperatorLayout(def('mix'))).toBe(false);   // 3 inputs
    expect(usesOperatorLayout(def('uv'))).toBe(false);    // glyphed, 0 inputs
    expect(usesOperatorLayout(undefined)).toBe(false);    // unknown registryType
  });
});
