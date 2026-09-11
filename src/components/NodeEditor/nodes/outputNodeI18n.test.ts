/**
 * The Output and Raymarch Output nodes speak the UI language.
 *
 * They render their own markup rather than going through ShaderNode, so they
 * never got its `portLabel` path: header, section labels and socket labels all
 * printed raw English in Latvian mode, on the canvas AND on the palette tile
 * (owner, 2026-09-11: "Output nodes needs LV language").
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { t, portLabel, formatNodeLabel } from '@/i18n';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const OUTPUT = read('./OutputNode.tsx');
const MARCH = read('./RaymarchOutputNode.tsx');
const CARD = read('../NodePreviewCard.tsx');
const cardPart = (start: string, end: string) => CARD.slice(CARD.indexOf(start), CARD.indexOf(end, CARD.indexOf(start)));
const OUTPUT_CARD = cardPart('function OutputCardContent(', 'function MarchOutputCardContent(');
const MARCH_CARD = cardPart('function MarchOutputCardContent(', 'ColorCardContent');

describe('the output nodes are translated on every surface', () => {
  const surfaces: [string, string][] = [
    ['OutputNode', OUTPUT], ['RaymarchOutputNode', MARCH], ['Output tile', OUTPUT_CARD], ['Raymarch tile', MARCH_CARD],
  ];

  it('never prints a raw socket or section label', () => {
    for (const [name, src] of surfaces) {
      expect(src, name).not.toContain('{port.label}</span>');
      expect(src, name).not.toContain('>{section.label}<');
      expect(src, name).not.toMatch(/>(Pixel|Vertex) Shader</);
      expect(src, name).toContain('portLabel(port.label, language)');
    }
  });

  it('takes the header from the node name, never a literal', () => {
    for (const [name, src] of surfaces) {
      expect(src, name).not.toContain('>Output</span>');
      expect(src, name).not.toContain('>{config.title}</span>');
      expect(src, name).toMatch(/formatNodeLabel\([^)]*, language, false\)/);
    }
  });

  it('has a Latvian entry for every label those nodes draw', () => {
    for (const type of ['output', 'raymarchOutput']) {
      const def = NODE_REGISTRY.get(type)!;
      expect(formatNodeLabel(def.label, type, 'lv', false), type).not.toBe(def.label);
      for (const port of def.inputs) {
        expect(portLabel(port.label, 'lv'), `${type}.${port.id}`).not.toBe(port.label);
      }
    }
    const sections = [...MARCH.matchAll(/\{ label: '([^']+)', ports:/g)].map((m) => m[1]);
    expect(sections.length).toBeGreaterThan(3);
    for (const label of ['Pixel Shader', 'Vertex Shader', ...sections]) {
      expect(t(label, 'lv'), label).not.toBe(label);
    }
  });
});
