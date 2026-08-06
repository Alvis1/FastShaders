import { describe, it, expect } from 'vitest';
import * as TSL from 'three/tsl';

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
    expect(T.color(0x1b2a4a).mix(T.color(0xffd24d), T.uv().x)).toBeTruthy();
  });
});
