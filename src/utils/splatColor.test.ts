/**
 * utils/splatColor.ts — tint, not paint: the colour MODE's pure pieces, the
 * carry across a code-panel Apply against the REAL emitter and parse.
 */
import { describe, it, expect } from 'vitest';
import { makeNode } from '@/test-utils';
import type { AppNode } from '@/types';
import { graphToCode } from '@/engine/graphToCode';
import { codeToGraph } from '@/engine/codeToGraph';
import { carrySplatReplaceColor, isSplatReplaceColor, splatReplaceColorValues } from './splatColor';

function splat(values: Record<string, unknown>): AppNode {
  const n = makeNode('sp', 'splatOutput');
  return { ...n, data: { ...n.data, values, activeOutput: true } } as AppNode;
}
const parsedValuesOf = (values: Record<string, unknown>) =>
  (codeToGraph(graphToCode([splat(values)], []).code).nodes.find((n) => n.data.registryType === 'splatOutput')!.data as { values: Record<string, unknown> }).values;

describe('splatColor — the colour mode', () => {
  it('isSplatReplaceColor is the own key, strictly the literal true; the toggle adds it or DELETES it', () => {
    expect(isSplatReplaceColor({ replaceColor: true })).toBe(true);
    for (const junk of [undefined, null, 'x', {}, { replaceColor: 'true' }, { replaceColor: 1 }, { replaceColor: false }, Object.create({ replaceColor: true })]) {
      expect(isSplatReplaceColor(junk), String(junk)).toBe(false);
    }
    const before = { color: '#ff0000' };
    expect(splatReplaceColorValues(before, true)).toEqual({ color: '#ff0000', replaceColor: true });
    expect(before).toEqual({ color: '#ff0000' });
    expect('replaceColor' in splatReplaceColorValues({ replaceColor: true }, false)).toBe(false);
  });

  it('an Apply with Color neither wired nor stored cannot see the mode — the carry keeps it', () => {
    const parsed = parsedValuesOf({ replaceColor: true, opacity: 0.5 });
    expect(parsed).not.toHaveProperty('replaceColor'); // `vec4(c.rgb, 0.5)` reads the same in both modes
    expect(carrySplatReplaceColor(parsed, { replaceColor: true }, false)).toEqual({ ...parsed, replaceColor: true });
  });

  it('with Color fed, the code decides: a tint in the code clears the old key, a replace sets it itself', () => {
    const tinted = parsedValuesOf({ color: '#2d6cdf' });
    expect(tinted).not.toHaveProperty('replaceColor');
    expect(carrySplatReplaceColor(tinted, { replaceColor: true }, true)).toBeNull();
    const replaced = parsedValuesOf({ color: '#2d6cdf', replaceColor: true });
    expect(replaced.replaceColor).toBe(true);
    expect(carrySplatReplaceColor(replaced, {}, true)).toBeNull();
    // Nothing to carry: the old node tinted too.
    expect(carrySplatReplaceColor({}, {}, false)).toBeNull();
    expect(carrySplatReplaceColor({}, { replaceColor: 'true' }, false)).toBeNull();
  });
});
