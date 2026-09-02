import { describe, it, expect } from 'vitest';
import { codeToGraph } from './codeToGraph';
import { graphToCode } from './graphToCode';

/**
 * A `Loop(...)` / `If(...)` statement has no graph equivalent. The parser used
 * to drop it in SILENCE while walking into its callback: the loop body's
 * `const`s became flat top-level nodes and every `.assign` vanished, so a
 * raymarcher came back out of the next Apply as a constant with `errors: []`.
 * Now the block is skipped whole and the warning names it.
 */
const LOOPED = `import { Fn, vec3, float, Loop, length, mx_noise_float } from 'three/tsl';

const shader = Fn(() => {
  const acc = vec3(0).toVar();
  const t = float(0).toVar();
  Loop(8, () => {
    const d = length(acc);
    const n = mx_noise_float(acc.mul(4));
    acc.addAssign(vec3(n, d, 0));
  });
  t.assign(0.5);
  return acc;
});

export default shader;
`;

describe('codeToGraph refuses imperative blocks out loud', () => {
  it('drops the Loop with a warning and does NOT flatten its body into nodes', () => {
    const r = codeToGraph(LOOPED);
    const types = r.nodes.map((n) => n.data.registryType);
    expect(types).not.toContain('length');
    expect(types).not.toContain('perlin');
    const loopWarn = r.errors.find((e) => e.message.startsWith('Loop('));
    expect(loopWarn, 'a Loop warning').toBeTruthy();
    expect(loopWarn!.severity).toBe('warning');
    expect(loopWarn!.line).toBe(6);
  });

  it('names a dropped .assign and which variable keeps its initial value', () => {
    const r = codeToGraph(LOOPED);
    const assignWarn = r.errors.find((e) => e.message.startsWith('t.assign('));
    expect(assignWarn).toBeTruthy();
    expect(assignWarn!.message).toContain('"t" keeps its initial value');
  });

  it('If(...).Else(...) is recognised through the chain', () => {
    const code = `import { Fn, vec3, float, If } from 'three/tsl';

const shader = Fn(() => {
  const c = vec3(0).toVar();
  If(float(1).greaterThan(0.5), () => { c.assign(vec3(1)); }).Else(() => { c.assign(vec3(0)); });
  return c;
});
`;
    const r = codeToGraph(code);
    expect(r.errors.some((e) => e.message.startsWith('If('))).toBe(true);
    // Neither branch body leaked a node or an assign warning (the If warning
    // itself mentions `.assign()` in prose, so match the dropped-write form).
    expect(r.errors.filter((e) => e.message.startsWith('c.assign('))).toHaveLength(0);
    expect(r.nodes.map((n) => n.data.registryType)).not.toContain('greaterThan');
  });

  it('the warnings never block the sync, and the re-emit is a valid flat module', () => {
    const r = codeToGraph(LOOPED);
    expect(r.errors.every((e) => e.severity === 'warning')).toBe(true);
    const back = graphToCode(r.nodes, r.edges);
    expect(back.code).not.toContain('Loop(');
    expect(back.code).toContain('export default shader;');
  });
});
