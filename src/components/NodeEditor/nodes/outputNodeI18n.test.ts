/**
 * The Output, Raymarch Output and Splat Output nodes speak the UI language.
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
const SPLAT = read('./SplatOutputNode.tsx');
const CARD = read('../NodePreviewCard.tsx');
const cardPart = (start: string, end: string) => CARD.slice(CARD.indexOf(start), CARD.indexOf(end, CARD.indexOf(start)));
const OUTPUT_CARD = cardPart('function OutputCardContent(', 'function SinkCardContent(');
// The Raymarch and Splat tiles are ONE body; each wrapper hands it its config.
const SINK_CARD = cardPart('function SinkCardContent(', 'function MarchOutputCardContent(');
const MARCH_CARD = cardPart('function MarchOutputCardContent(', 'function SplatOutputCardContent(');
const SPLAT_CARD = cardPart('function SplatOutputCardContent(', 'ColorCardContent');

describe('the output nodes are translated on every surface', () => {
  const surfaces: [string, string][] = [
    ['OutputNode', OUTPUT], ['RaymarchOutputNode', MARCH], ['Output tile', OUTPUT_CARD],
    ['SplatOutputNode', SPLAT], ['Raymarch + Splat tile', SINK_CARD],
  ];

  it('slices every tile out of the card file (a vacuous slice would pass the checks below)', () => {
    for (const part of [OUTPUT_CARD, SINK_CARD]) expect(part.length).toBeGreaterThan(500);
    // Both wrappers render the shared body, each with its OWN config.
    for (const part of [MARCH_CARD, SPLAT_CARD]) expect(part).toContain('<SinkCardContent');
    expect(MARCH_CARD).toContain('config={MARCH_NODE_CONFIG}');
    expect(MARCH_CARD).not.toContain('SPLAT_NODE_CONFIG');
    expect(SPLAT_CARD).toContain('config={SPLAT_NODE_CONFIG}');
    expect(SINK_CARD).not.toMatch(/(MARCH|SPLAT)_NODE_CONFIG/);
  });

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
      // Either the formatter inline (the plain Output) or OutputTitle, which
      // calls it — see the "original name" test below.
      expect(src, name).toMatch(/formatNodeLabel\([^)]*, language, false\)|<OutputTitle\b[^>]*\blanguage=\{language\}/);
    }
  });

  it("prints the technique's original name under a translated header, on every surface", () => {
    // Neither raymarching nor Gaussian splatting has an official Latvian term
    // (termini.gov.lv knows only ray tracing, "staru izsekošana"), so the
    // Latvian names are the owner's choices (2026-09-26: "Staru soļi", renamed
    // the same day to "SDF Izvade"; "Gausa pleķi") and the ORIGINAL technique
    // name is printed under them, always —
    // by ONE component, on the canvas and the tile alike.
    const TITLE = read('./OutputTitle.tsx');
    expect(TITLE).toContain('formatNodeLabel(title, type, language, false)');
    expect(TITLE).toContain('output-node__original');
    // Only under a TRANSLATED title: in English the line would repeat the header.
    expect(TITLE).toMatch(/shown !== title &&/);
    expect(MARCH).toMatch(/original: 'Raymarching',/);
    expect(SPLAT).toMatch(/original: 'Gaussian splat',/);
    const glossed: [string, string][] = [
      ['RaymarchOutputNode', MARCH], ['SplatOutputNode', SPLAT], ['Raymarch + Splat tile', SINK_CARD],
    ];
    for (const [name, src] of glossed) {
      expect(src, name).toMatch(/<OutputTitle\b[^>]*\boriginal=\{config\.original\}/);
      expect(src, name).not.toContain('output-node__original'); // drawn by OutputTitle alone
    }
    // The plain Output needs no gloss ("Izvade") and keeps its own span.
    expect(OUTPUT).not.toContain('OutputTitle');
    // A class nothing styles would render the gloss inline, on the SAME line.
    expect(read('./OutputNode.css')).toMatch(/\.output-node__original\s*\{[^}]*display:\s*block/);
  });

  it('has a Latvian entry for every label those nodes draw', () => {
    for (const type of ['output', 'raymarchOutput', 'splatOutput']) {
      const def = NODE_REGISTRY.get(type)!;
      expect(formatNodeLabel(def.label, type, 'lv', false), type).not.toBe(def.label);
      for (const port of def.inputs) {
        expect(portLabel(port.label, 'lv'), `${type}.${port.id}`).not.toBe(port.label);
      }
    }
    const sections = [...MARCH.matchAll(/\{ label: '([^']+)', ports:/g)].map((m) => m[1]);
    expect(sections.length).toBeGreaterThan(3);
    const splatSections = [...SPLAT.matchAll(/\{ label: '([^']+)', ports:/g)].map((m) => m[1]);
    expect(splatSections).toEqual(['Shade', 'Cut', 'Shape', 'Light']);
    sections.push(...splatSections);
    // The splat's own UI strings: the "Own colour" state and its menu.
    for (const label of ['Own colour', 'Splat Settings', 'Invert cut', 'React to light', 'Replace own colour']) expect(t(label, 'lv'), label).not.toBe(label);
    // The Latvian names (owner, 2026-09-26): a Gaussian-splat scene is "Gausa
    // pleķu aina", one splat "pleķis". The marching sink is named after what it
    // renders — "SDF Output" / "SDF Izvade" (owner, 2026-09-26, replacing
    // "Raymarch Output" / "Staru soļi"); raymarching itself is "staru soļi",
    // never ray tracing's "staru izsekošana".
    expect(formatNodeLabel('Splat Output', 'splatOutput', 'lv', false)).toBe('Gausa pleķi');
    expect(formatNodeLabel('SDF Output', 'raymarchOutput', 'lv', false)).toBe('SDF Izvade');
    for (const label of ['Pixel Shader', 'Vertex Shader', ...sections]) {
      expect(t(label, 'lv'), label).not.toBe(label);
    }
  });
});
