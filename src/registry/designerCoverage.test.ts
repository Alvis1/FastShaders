import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { getAllDefinitions, getFlowNodeType } from '@/registry/nodeRegistry';

/**
 * `node-designer.html` is a standalone vanilla tool that carries its own inline
 * `const NODES=[...]` snapshot of the node set (it imports nothing from src/).
 * A snapshot is a copy, and copies drift — `stripes`/`dataviz` were missing from
 * it for their whole lifetime, so a `?node=stripes` deep-link silently showed a
 * different node.
 *
 * WHY the two sets must match EXACTLY: the designer only edits GLYPHS, and
 * glyphs only exist on ShaderNode-rendered nodes. `getFlowNodeType(def)` in
 * nodeRegistry is the authoritative rule for which renderer a definition gets —
 * anything it maps to 'shader' is designable and MUST appear in the snapshot;
 * anything else (live-canvas nodes: the noise family, sin/cos, color, time,
 * output) has no glyph and MUST NOT appear. So:
 *   - a node in the registry but not the snapshot = undesignable in the tool
 *     (the drift this test was written for)
 *   - a node in the snapshot but not the registry = a stale entry the designer
 *     would let you author a glyph for that nothing renders
 * Fix drift by editing the snapshot in `node-designer.html` (repo root — NEVER
 * `public/node-designer.html`, which vite's nodeDesignerSyncPlugin regenerates).
 */
const DESIGNER = path.resolve(__dirname, '../../node-designer.html');

/** Categories used as the 3rd tuple element — the discriminator for OUTER entries. */
const CATEGORIES = [
  'input',
  'type',
  'arithmetic',
  'math',
  'interpolation',
  'logic',
  'vector',
  'noise',
  'color',
  'texture',
  'unknown',
  'output',
];

/**
 * Extract the node types from the designer's `NODES` snapshot.
 *
 * Each outer entry is `['type','Label','category',[...ins],[...outs],{defaults}?]`
 * and the nested socket tuples are `['id','dataType']`. A naive "first string of
 * any bracketed tuple" regex therefore also captures sockets ('out', 'x', 'rgb',
 * …). Matching THREE leading strings and requiring the third to be a known
 * category rejects every nested tuple (a socket tuple has only two strings, and
 * its 2nd is a dataType, not a category).
 */
function designerNodeTypes(): string[] {
  const html = readFileSync(DESIGNER, 'utf8');
  const block = html.match(/const NODES=\[([\s\S]*?)\n\];/);
  expect(block, 'could not find the `const NODES=[...]` snapshot in node-designer.html').toBeTruthy();
  const re = /\['([A-Za-z0-9_]+)','([^']*)','([A-Za-z]+)'/g;
  const types: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block![1]))) {
    if (CATEGORIES.includes(m[3])) types.push(m[1]);
  }
  return types;
}

describe('node-designer.html NODES snapshot covers exactly the ShaderNode-rendered registry', () => {
  const designer = designerNodeTypes();
  const registry = getAllDefinitions()
    .filter((d) => getFlowNodeType(d) === 'shader')
    .map((d) => d.type);

  it('extracts only real node types from the snapshot (no nested socket tuples)', () => {
    // Locks the parse in: sockets like 'out'/'x'/'rgb'/'channel' must never appear.
    expect(designer).not.toContain('out');
    expect(designer).not.toContain('x');
    expect(designer).not.toContain('rgb');
    expect(new Set(designer).size, 'duplicate entries in the NODES snapshot').toBe(designer.length);
    // Against the registry, not a literal: a hardcoded count fails the day a 56th
    // shader node is added AND correctly snapshotted — zero drift, red test, in a
    // case this test doesn't even claim to police. This still catches a regex that
    // captures nothing or everything, which is what the assertion is here for.
    expect(designer.length).toBe(registry.length);
  });

  it('lists every shader-rendered definition (missing = undesignable in the tool)', () => {
    const missing = registry.filter((t) => !designer.includes(t));
    expect(
      missing,
      `add these to the NODES snapshot in node-designer.html: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('lists no node the registry no longer renders as a ShaderNode', () => {
    const stale = designer.filter((t) => !registry.includes(t));
    expect(
      stale,
      `remove these from the NODES snapshot in node-designer.html: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('matches the registry set exactly', () => {
    expect([...designer].sort()).toEqual([...registry].sort());
  });
});
