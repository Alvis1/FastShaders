/**
 * A wire DIVING into a Portal's hole (owner, 2026-11-24) — the pure half
 * (portalDive.ts) and where TypedEdge draws it: inside the Portal end's own
 * card, never in a layer above the node layer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { diveHostOf, diveKeyOf, edgeClassHas, setDiveHost } from './portalDive';

const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

describe('diveKeyOf — which ends of a wire dive', () => {
  it('into a Portal In, out of a Portal Out, both, or none', () => {
    expect(diveKeyOf(undefined, 'shader', 'tunnelIn')).toBe('i');
    expect(diveKeyOf(undefined, 'tunnelOut', 'shader')).toBe('o');
    expect(diveKeyOf(undefined, 'tunnelOut', 'tunnelIn')).toBe('io');
    expect(diveKeyOf(undefined, 'shader', 'shader')).toBe('');
  });

  it('nowhere for a wire hidden in a collapsed group', () => {
    expect(diveKeyOf('fs-collapsed-edge', 'shader', 'tunnelIn')).toBe('');
    expect(diveKeyOf('x fs-collapsed-edge', 'tunnelOut', 'shader')).toBe('');
  });

  it('never throws on a file\'s non-string edge className (it ran in render, on every boot)', () => {
    for (const cls of [5, true, { includes: 1 }, null, Symbol('x'), ['fs-collapsed-edge']]) {
      expect(() => diveKeyOf(cls, 'shader', 'tunnelIn')).not.toThrow();
      expect(diveKeyOf(cls, 'shader', 'tunnelIn')).toBe('i');
      expect(edgeClassHas(cls, 'fs-collapsed-edge')).toBe(false);
    }
  });

  it('TypedEdge and the hit test read the class through it, never `.includes` on the raw value', () => {
    const edge = read('./TypedEdge.tsx');
    expect(edge).toContain('diveKeyOf(s.edgeLookup.get(id)?.className');
    expect(edge).not.toMatch(/className \?\? ''\)\.includes/);
    const hit = read('../edgeHit.ts');
    expect(hit).toContain("edgeClassHas((edge as { className?: unknown }).className, 'fs-collapsed-edge')");
    expect(hit).not.toMatch(/className\?\.includes/);
  });
});

describe('the dive hosts', () => {
  const el = (n: number) => ({ n }) as unknown as HTMLElement;

  it('one per Portal end; an unmount never removes a NEWER host', () => {
    const a = el(1);
    const b = el(2);
    setDiveHost('p', a);
    expect(diveHostOf('p')).toBe(a);
    // A remount registered its new host before the old one's ref let go.
    setDiveHost('p', b, null);
    setDiveHost('p', null, a);
    expect(diveHostOf('p')).toBe(b);
    setDiveHost('p', null, b);
    expect(diveHostOf('p')).toBeNull();
    expect(diveHostOf(null)).toBeNull();
  });
});

describe('where the dive is drawn', () => {
  it('INSIDE the Portal end\'s card (its hole\'s host), never one z-step above the node layer', () => {
    // A layer at the portal's z + 1 painted over every card covering the
    // hole at the same z (a group member dropped on it).
    const edge = read('./TypedEdge.tsx');
    expect(edge).toContain('createPortal(');
    expect(edge).not.toContain('<ViewportPortal>');
    expect(edge).not.toMatch(/zIndex: z \+ 1/);
    expect(edge).toContain('const inHost = useDiveHost(diveIn ? target : null);');
    expect(edge).toContain('const outHost = useDiveHost(diveOut ? source : null);');
    const card = read('../nodes/TunnelNode.tsx');
    expect(card).toMatch(/<div ref=\{setHost\} className="tunnel-node__dive" aria-hidden="true" \/>/);
  });

  it('masked to the hole\'s OWN disc, the host growing with the hole: no band drawn twice, no gap', () => {
    const edge = read('./TypedEdge.tsx');
    // The first cut masked to 1.04 R in a layer that did not grow with the
    // hole, so between R and 1.04 R the wire was drawn twice at 0.9 opacity.
    expect(edge).not.toMatch(/TUNNEL_SIZE \/ 2\) \* 1\.04/);
    expect(edge).toContain('const r = TUNNEL_SIZE / 2;');
    const css = read('../nodes/PassThroughNode.css');
    const host = css.slice(css.indexOf('.tunnel-node__dive {'), css.indexOf('}', css.indexOf('.tunnel-node__dive {')));
    expect(host).toContain('pointer-events: none');
    expect(host).toContain('left: calc(-2px * var(--fs-node-border-scale, 1))');
  });

  it('copies only the channel LINES: no chevron is ever drawn over a hole', () => {
    const edge = read('./TypedEdge.tsx');
    const dives = [...edge.matchAll(/<PortalDive\b[\s\S]*?<\/PortalDive>/g)].map((m) => m[0]);
    expect(dives).toHaveLength(2);
    for (const d of dives) {
      expect(d).toMatch(/>\s*\{lines\}\s*<\/PortalDive>/);
      expect(d).not.toContain('arrows');
    }
  });

  it('Preview mode dims the card, and the dive with it once — never twice', () => {
    const css = read('../nodes/PassThroughNode.css');
    expect(css).toContain(
      '.node-editor__canvas.fs-previewing .react-flow__node:not([data-fs-preview]) .tunnel-node__dive .react-flow__edge {\n  opacity: 1;',
    );
  });
});
