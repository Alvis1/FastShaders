import { describe, it, expect } from 'vitest';
import { buildRows, visiblePortRows } from './ShaderNode';
import { nodeSockets } from './glyphs/NodeGlyph';
import { getAllDefinitions, getFlowNodeType } from '@/registry/nodeRegistry';
import type { PortDefinition } from '@/types';

/**
 * A port row exists to carry a socket, its label and its value. A designer
 * socket override takes all three OUT of the row and places them against the
 * region's centre — so a row can end up drawing literally nothing, and because
 * `.shader-node__region` carries the authored height EXACTLY, that empty strip
 * hangs outside the card's own bottom border.
 *
 * MEASURED in Chromium before this filter existed: 26 of the registry's
 * ShaderNode-rendered types hung 5–39px of empty row below their frame, on the
 * canvas AND on every asset tile. Nothing failed — the row is transparent, so
 * it only shows up as a ragged bottom edge, and worse on a multi-channel node
 * where the offset stack layers give the spill something to sit against.
 */

const port = (id: string): PortDefinition =>
  ({ id, label: id, dataType: 'float' }) as PortDefinition;

const IN = port('x');
const OUT = port('out');

describe('visiblePortRows', () => {
  const row = (input: PortDefinition | null, output: PortDefinition | null) =>
    ({ input, output, settingKey: null, settingType: null });

  it('keeps a row whose input is still in place', () => {
    expect(visiblePortRows([row(IN, null)], {}, [OUT])).toHaveLength(1);
  });

  it('keeps a row whose output is still in place', () => {
    expect(visiblePortRows([row(null, OUT)], {}, [OUT])).toHaveLength(1);
  });

  it('drops a row once BOTH its sockets have been moved out', () => {
    // The `oneMinus` shape: one input and the first output, both authored to
    // sit against the region centre. Nothing is left in the row itself.
    expect(visiblePortRows([row(IN, OUT)], { x: -12, out: 0 }, [OUT])).toEqual([]);
  });

  it('drops a source node\'s lone row when its output is moved', () => {
    // `cameraNear`, `positionGeometry`, `screenUV`: no inputs at all, and the
    // one output placed by the designer. This was the worst case at 39px.
    expect(visiblePortRows([row(null, OUT)], { out: 4 }, [OUT])).toEqual([]);
  });

  it('keeps a moved-input row that still draws a NON-first output', () => {
    // Only `out` is detached (`sockets['out']`), so a second output — split's
    // y/z/w, toHsl's h/s/l — is still drawn in its row and the row must stay.
    const second = port('y');
    expect(visiblePortRows([row(IN, second)], { x: -12, out: 0 }, [OUT, second]))
      .toHaveLength(1);
  });

  it('is identity when the design moves nothing', () => {
    const rows = [row(IN, OUT), row(port('y'), null)];
    expect(visiblePortRows(rows, {}, [OUT])).toEqual(rows);
  });
});

describe('the shipped registry', () => {
  const shaderDefs = getAllDefinitions().filter((d) => getFlowNodeType(d) === 'shader');

  it('has types whose every row is emptied by their authored design', () => {
    // Guards the guard: if this ever drops to zero the assertions below are
    // vacuous, and the filter could be deleted without a single test failing.
    const emptied = shaderDefs.filter((d) => {
      const rows = buildRows(d);
      return rows.length > 0 && visiblePortRows(rows, nodeSockets(d.type), d.outputs).length === 0;
    });
    expect(emptied.length).toBeGreaterThan(10);
  });

  it('never drops a row that still draws a socket', () => {
    for (const d of shaderDefs) {
      const sockets = nodeSockets(d.type);
      const kept = new Set(visiblePortRows(buildRows(d), sockets, d.outputs));
      for (const row of buildRows(d)) {
        const drawsInput = !!row.input && sockets[row.input.id] == null;
        const drawsOutput = !!row.output && !(sockets['out'] != null && row.output === d.outputs[0]);
        if (drawsInput || drawsOutput) {
          // Compare by content: buildRows mints fresh row objects per call.
          const match = [...kept].some(
            (k) => k.input?.id === row.input?.id && k.output?.id === row.output?.id,
          );
          expect(match, `${d.type} dropped a row that still draws`).toBe(true);
        }
      }
    }
  });
});
