import { describe, it, expect } from 'vitest';
import { sanitizeOutputTargets, meshTargetName, MAX_TARGETED_OUTPUTS } from './outputTargets';
import { makeNode } from '@/test-utils';
import type { AppNode } from '@/types';

const output = (id: string, meshTarget?: unknown): AppNode => {
  const n = makeNode(id, 'output');
  if (meshTarget !== undefined) (n.data as Record<string, unknown>).meshTarget = meshTarget;
  return n;
};
const targetOf = (n: AppNode) => (n.data as Record<string, unknown>).meshTarget;

describe('meshTargetName', () => {
  it('reads a usable name and refuses everything else', () => {
    expect(meshTargetName(output('a', { name: 'Glass' }))).toBe('Glass');
    expect(meshTargetName(output('a'))).toBeNull();
    expect(meshTargetName(output('a', { name: '__proto__' }))).toBeNull();
    expect(meshTargetName(output('a', { name: 42 }))).toBeNull();
    expect(meshTargetName(output('a', 'Glass'))).toBeNull();
    expect(meshTargetName(output('a', null))).toBeNull();
    expect(meshTargetName(output('a', ['Glass']))).toBeNull();
  });

  it('is only ever a question about an Output node', () => {
    const notAnOutput = makeNode('c1', 'color');
    (notAnOutput.data as Record<string, unknown>).meshTarget = { name: 'Glass' };
    expect(meshTargetName(notAnOutput)).toBeNull();
  });
});

describe('sanitizeOutputTargets', () => {
  it('returns the SAME array when nothing needed changing', () => {
    // The autosave subscriber and selectionOnlyGraphChange compare by
    // reference; a fresh array on every load would defeat both.
    const nodes = [makeNode('c1', 'color'), output('o1'), output('o2', { name: 'Glass' })];
    expect(sanitizeOutputTargets(nodes)).toBe(nodes);
  });

  it('strips an unusable target but keeps the node', () => {
    // The Output carries the user's wiring — deleting it would take a whole
    // subgraph with it.
    const nodes = [output('o1', { name: '__proto__' })];
    const out = sanitizeOutputTargets(nodes);
    expect(out).not.toBe(nodes);
    expect(out).toHaveLength(1);
    expect(targetOf(out[0])).toBeUndefined();
  });

  it('drops extra keys smuggled onto the target object', () => {
    const out = sanitizeOutputTargets([output('o1', { name: 'Glass', evil: 1 })]);
    expect(targetOf(out[0])).toEqual({ name: 'Glass' });
  });

  it('lets the first claim win when two Outputs want one mesh', () => {
    // A mesh has one material, so the second claim cannot render. First-wins
    // matches emission, so a reloaded graph renders like the live one did.
    const out = sanitizeOutputTargets([
      output('o1', { name: 'Glass' }),
      output('o2', { name: 'Glass' }),
    ]);
    expect(targetOf(out[0])).toEqual({ name: 'Glass' });
    expect(targetOf(out[1])).toBeUndefined();
  });

  it('caps how many Outputs may be targeted', () => {
    const many = Array.from({ length: MAX_TARGETED_OUTPUTS + 3 }, (_, i) =>
      output(`o${i}`, { name: `M${i}` }),
    );
    const out = sanitizeOutputTargets(many);
    expect(out.filter((n) => targetOf(n) !== undefined)).toHaveLength(MAX_TARGETED_OUTPUTS);
  });

  it('leaves non-output nodes untouched', () => {
    const colour = makeNode('c1', 'color', { hex: '#ffffff' });
    const out = sanitizeOutputTargets([colour, output('o1', { name: 'Glass' })]);
    expect(out[0]).toBe(colour);
  });

  it('survives a target that is a primitive rather than an object', () => {
    // `getNodeValues`-style nullish guards do not cover this: a tampered file
    // can put any JSON value here, and a throw inside loadGraph is caught by
    // its outer handler, which then returns null and lets the autosave
    // overwrite the user's real graph with the demo one.
    for (const junk of [5, 'Glass', true, [], null]) {
      expect(() => sanitizeOutputTargets([output('o1', junk)])).not.toThrow();
    }
  });
});
