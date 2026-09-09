import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildRows, visiblePortRows, centersOutputSocket } from './ShaderNode';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const SHADER_NODE = read('./ShaderNode.tsx');
const NODE_VISUAL = read('./NodeVisual.tsx');

const imageDef = NODE_REGISTRY.get('imageNode')!;

describe('centersOutputSocket', () => {
  it('is the Image node, and nothing else', () => {
    // Deliberately a TYPE list: for every other rows-layout node the first row
    // IS the top of the body, so row-anchoring already puts the output where
    // the content starts. The Image node's card is a filename and a thumbnail
    // first, so its first row sits below the picture.
    expect(centersOutputSocket('imageNode')).toBe(true);
    for (const type of NODE_REGISTRY.keys()) {
      if (type !== 'imageNode') expect(centersOutputSocket(type)).toBe(false);
    }
    expect(centersOutputSocket(undefined)).toBe(false);
  });
});

describe('the Image node rows', () => {
  it('drop the strip that existed only to carry the output', () => {
    // With no parameter exposed — the Image node's default, since its params
    // are opt-in — the only row was the one holding the output socket, which
    // read as a band of empty card under the thumbnail.
    const rows = buildRows({ ...imageDef, inputs: [] });
    expect(visiblePortRows(rows, {}, imageDef.outputs, true)).toEqual([]);
    // Row-anchored (the old behaviour) that same row still draws.
    expect(visiblePortRows(rows, {}, imageDef.outputs, false)).toHaveLength(1);
  });

  it('keep an EXPOSED param row, minus its right half', () => {
    const rows = buildRows({ ...imageDef, inputs: [imageDef.inputs[0]] });
    const visible = visiblePortRows(rows, {}, imageDef.outputs, true);
    expect(visible).toHaveLength(1);
    expect(visible[0].input?.id).toBe('uv');
  });
});

describe('where the centred socket is rendered', () => {
  it('is anchored to the CARD, not the rows region, on both surfaces', () => {
    // The distinction IS the fix: the region is the strip below the
    // thumbnail, so centring on it would land the socket in the same wrong
    // place. In both files the block sits outside the region — beside
    // RevealSockets in ShaderNode, after the region closes in NodeVisual.
    expect(SHADER_NODE).toMatch(/\{centerOut && def\.outputs\[0\][\s\S]{0,500}RevealSockets/);
    expect(NODE_VISUAL).toMatch(/\{centerOut && def\.outputs\[0\]/);
    // The region-relative detached-out path (the designer's own socket
    // override) still comes first and is untouched by this.
    expect(SHADER_NODE.indexOf('rowsOutOff != null && def.outputs[0]'))
      .toBeLessThan(SHADER_NODE.indexOf('{centerOut && def.outputs[0]'));
  });

  it('sets no `top` of its own', () => {
    // React Flow's own `.react-flow__handle-right` is already
    // `top: 50%; right: 0; transform: translate(50%, -50%)` — card-centred and
    // straddling the border. A `top` here would be a second, drifting copy of
    // that, and the row rule in NodeBase.css is scoped to `.node-base__row`
    // so it cannot reach a card-level handle.
    const block = /\{centerOut && def\.outputs\[0\] && \(([\s\S]*?)\)\}/.exec(SHADER_NODE);
    expect(block).not.toBeNull();
    expect(block![1]).not.toMatch(/top:/);
    expect(block![1]).not.toMatch(/style=/);
  });

  it('is not ALSO drawn by the region path', () => {
    // Both would mount a handle with the same id — React Flow measures one of
    // them and the wire lands on whichever it picked.
    expect(NODE_VISUAL).toMatch(/\{outMoved && !centerOut && \(/);
  });
});
