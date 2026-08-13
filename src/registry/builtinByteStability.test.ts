import { describe, it, expect } from 'vitest';
import { getBuiltinTextures } from './builtinTextures';
import { getBuiltinPresets } from './builtinPresets';
import { graphToCode } from '@/engine/graphToCode';
import type { AppNode, AppEdge } from '@/types';

/**
 * Every shipped texture and preset, re-emitted — pinned byte for byte.
 *
 * The 23 built-in assets are parsed from TSL into graphs at startup
 * (`codeToGraph` → `buildCodeGroup`), so a change to a registry `defaultValues`
 * entry can silently alter what a shipped preset RENDERS: any argument the
 * source omitted now resolves through the new default. Nothing in the suite
 * pinned that, which is exactly why a whole class of missing defaults sat
 * undetected — each fix had to be byte-checked by hand.
 *
 * This snapshot is the standing version of that check. If a default change
 * shows up here as a diff, decide deliberately: either the asset's appearance
 * genuinely changes (rare, and it must be intended) or the default is wrong.
 */
function emit(nodes: AppNode[], edges: AppEdge[]): string {
  // Group containers carry no shader semantics; graphToCode ignores the node
  // but reads through the boundary edges, so pass the set through untouched.
  return graphToCode(nodes, edges).code;
}

describe('built-in textures and presets emit byte-identical code', () => {
  it('textures', () => {
    const out: Record<string, string> = {};
    for (const t of getBuiltinTextures()) out[t.id] = emit(t.nodes, t.edges);
    expect(out).toMatchSnapshot();
  });

  it('presets', () => {
    const out: Record<string, string> = {};
    for (const p of getBuiltinPresets()) out[p.id] = emit(p.nodes, p.edges);
    expect(out).toMatchSnapshot();
  });

  it('covers every shipped asset, so a new one cannot slip past unpinned', () => {
    expect(getBuiltinTextures().length + getBuiltinPresets().length).toBeGreaterThanOrEqual(23);
  });
});
