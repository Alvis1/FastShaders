import { describe, it, expect } from 'vitest';
import * as TSL from 'three/tsl';
import { FORMULA_TSL_SYMBOLS } from '@/utils/dataRangeFormula';

/**
 * Contract test: the TSL method chains graphToCode WRITES AS TEXT are real.
 *
 * Every other test in this suite compares generated source against expected
 * source — which proves the emitter is consistent with itself and nothing more.
 * A method that does not exist (`.sign()`, `.log2()`, `.oneMinus()`) produces
 * source that looks perfect, passes every string assertion, and then throws
 * "is not a function" inside the preview iframe, where the only symptom is a
 * blank pane.
 *
 * So this file builds the exact chains the dataviz branches emit, against the
 * real `three/tsl` the app ships. It also fails when a three upgrade renames or
 * drops one of them, which is the other direction the drift can come from.
 */

/**
 * three's TSL types model exact vector arities, so a chain written the way the
 * EMITTER writes it (untyped text) does not always typecheck when written as
 * TypeScript. The question here is runtime existence, not static arity — the
 * generated module is a string that never sees the type checker — so the arity
 * types are deliberately erased at this boundary.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Chain = any;
const T = TSL as unknown as {
  float: (v: number) => Chain;
  uv: () => Chain;
  color: (v: number) => Chain;
  mix: (a: Chain, b: Chain, t: Chain) => Chain;
  dFdx: (n: Chain) => Chain;
  dFdy: (n: Chain) => Chain;
};

describe('TSL chains used by the dataviz emitters exist in the shipped three', () => {
  it('exports every symbol the branches import by name', () => {
    for (const name of ['float', 'vec2', 'vec3', 'color', 'texture', 'uv', 'dFdx', 'dFdy']) {
      expect(typeof (TSL as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  it('exposes every node method the emitted expressions chain', () => {
    const n = T.float(0.5);
    for (const m of [
      'sub', 'mul', 'add', 'div', 'clamp', 'fract', 'abs',
      'max', 'min', 'log2', 'sign', 'floor', 'oneMinus', 'smoothstep', 'mix', 'pow',
    ]) {
      expect(typeof (n as unknown as Record<string, unknown>)[m], m).toBe('function');
    }
  });

  it('builds the Isolines chain', () => {
    // Mirrors the emitted lines exactly, including the derivative-of-continuous
    // -phase ordering and the sub-pixel average fade.
    const p = T.uv().x.sub(0.25).mul(10);
    const fw = T.dFdx(p).abs().add(T.dFdy(p).abs()).max(0.00001);
    const hw = fw.mul(1.5).mul(0.5);
    const d = T.float(0.5).sub(p.fract().sub(0.5).abs());
    const ln = d.smoothstep(T.float(0.0), hw).oneMinus();
    const avg = fw.mul(1.5).clamp(0.0, 1.0);
    expect(ln.mix(avg, fw.mul(2.0).sub(1.0).clamp(0.0, 1.0))).toBeTruthy();
  });

  it('builds the Data Range affine, log and symlog chains', () => {
    const src = T.uv().x;
    expect(src.sub(-4).mul(0.125).clamp(0.0, 1.0)).toBeTruthy();
    expect(src.max(0.001).log2().sub(-9.96).mul(0.07).clamp(0.0, 1.0)).toBeTruthy();
    expect(
      src.sign().mul(src.abs().mul(250).add(1.0).log2().mul(0.09)).mul(0.5).add(0.5).clamp(0.0, 1.0),
    ).toBeTruthy();
  });

  it('builds the Colormap quantize + LUT coordinate chain', () => {
    const t = T.uv().x;
    const q = t.clamp(0.0, 0.999999).mul(4).floor().add(0.5).div(4);
    expect(q.mul(0.99609375).add(0.001953125)).toBeTruthy();
  });

  it('builds the color(0x…) ramp mix the Stripes / Data Viz branches emit', () => {
    // The colour-space fix: `color()` is what converts the picked hex from sRGB
    // into the renderer's linear working space.
    expect(T.mix(T.color(0x1b2a4a), T.color(0xffd24d), T.uv().x)).toBeTruthy();
  });

  it('mix() puts the two ENDPOINTS first and the factor last — the chained form does NOT', () => {
    // The defect this pins, verified against the shipped three by structure.
    // TSL registers the method as `mixElement = (t, e1, e2) => mix(e1, e2, t)`
    // (MathNode.js), so the RECEIVER of `.mix()` lands in the FACTOR slot.
    // Written as a chain the ramp built mix(highColour, t, lowColour): the low
    // colour used as a per-channel blend factor and the scalar `t` as an
    // endpoint, which held the output within ~2% of the high colour for every
    // t — the low swatch did nothing.
    //
    // Method chaining wraps its result in a VarNode, hence the unwrap.
    const unwrap = (n: Chain): Chain => (n && n.isVarNode ? n.node : n);
    const hex = (n: Chain): string | undefined => unwrap(n)?.value?.getHexString?.();
    const lo = T.color(0x1b2a4a), hi = T.color(0xffd24d), t = T.uv().x;

    const fn = unwrap(T.mix(lo, hi, t));
    expect(fn.method).toBe('mix');
    expect(hex(fn.aNode)).toBe('1b2a4a');   // endpoint A = low
    expect(hex(fn.bNode)).toBe('ffd24d');   // endpoint B = high
    expect(hex(fn.cNode)).toBeUndefined();  // factor = the scalar, not a colour

    const chained = unwrap(lo.mix(hi, t));
    expect(hex(chained.aNode)).toBe('ffd24d');
    expect(hex(chained.cNode)).toBe('1b2a4a'); // the low colour AS THE FACTOR
  });

  /**
   * The Data Range formula language's function table IS a contract with
   * three/tsl: a table row naming a symbol that does not exist emits
   * perfect-looking source and a blank preview pane. Driving the assertion off
   * the exported table means a future row is pinned automatically.
   */
  it('exports every symbol the Data Range formula emitter can write', () => {
    for (const name of FORMULA_TSL_SYMBOLS) {
      expect(typeof (TSL as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  /**
   * `mix` is NOT the only chained method whose receiver is displaced —
   * `smoothstep` and `step` are too. Measured here rather than asserted from
   * documentation, because CLAUDE.md claimed otherwise and was wrong.
   *
   * This is why the formula emitter writes every named function in FREE
   * form: one rule that removes the whole receiver-slot bug class, instead of a
   * per-function table of which slot the receiver lands in. If a future refactor
   * "tidies" the emitter into method chains, this test explains the damage.
   */
  it('confirms mix, smoothstep and step ALL displace a chained receiver', () => {
    const unwrap = (n: Chain): Chain => (n && n.isVarNode ? n.node : n);
    const val = (n: Chain): number | undefined => unwrap(n)?.value;
    const a = T.float(1), b = T.float(2), c = T.float(3);

    // Free form: strictly positional, which is what the emitter relies on.
    const freeMix = unwrap((TSL as Record<string, unknown> as { mix: (...x: Chain[]) => Chain }).mix(a, b, c));
    expect([val(freeMix.aNode), val(freeMix.bNode), val(freeMix.cNode)]).toEqual([1, 2, 3]);

    const freeSs = unwrap(
      (TSL as Record<string, unknown> as { smoothstep: (...x: Chain[]) => Chain }).smoothstep(a, b, c),
    );
    expect([val(freeSs.aNode), val(freeSs.bNode), val(freeSs.cNode)]).toEqual([1, 2, 3]);

    const freeStep = unwrap(
      (TSL as Record<string, unknown> as { step: (...x: Chain[]) => Chain }).step(a, b),
    );
    expect([val(freeStep.aNode), val(freeStep.bNode)]).toEqual([1, 2]);

    // Method form: the receiver moves. THREE separate methods, not one.
    const chMix = unwrap(a.mix(b, c));
    expect([val(chMix.aNode), val(chMix.bNode), val(chMix.cNode)]).toEqual([2, 3, 1]);

    const chSs = unwrap(a.smoothstep(b, c));
    expect([val(chSs.aNode), val(chSs.bNode), val(chSs.cNode)]).toEqual([2, 3, 1]);

    const chStep = unwrap(a.step(b));
    expect([val(chStep.aNode), val(chStep.bNode)]).toEqual([2, 1]);

    // ...while clamp and pow really are positional as methods, so the rule is
    // about these three specifically and not about chaining in general.
    const chClamp = unwrap(a.clamp(b, c));
    expect([val(chClamp.aNode), val(chClamp.bNode), val(chClamp.cNode)]).toEqual([1, 2, 3]);
  });
});
