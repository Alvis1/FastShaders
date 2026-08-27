/**
 * "Which Output is THE output?" — asked by codegen and by six UI surfaces.
 *
 * Before per-mesh materials each of them wrote `nodes.find(registryType ===
 * 'output')` independently, which was fine while the answer could only be one
 * node. With several Outputs those copies stop agreeing, and every way they
 * disagree is silent: the settings menu editing one material while the export
 * writes another's, the Light dropdown naming an environment map that only
 * lights one mesh, a cost badge describing a chain nothing renders.
 *
 * So there is now one definition, and this pins both it and the rule that the
 * consumers use it rather than re-deriving their own.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { findDefaultOutput, outputNodes, meshTargetName } from './outputTargets';
import { makeNode } from '@/test-utils';
import type { AppNode } from '@/types';

const output = (id: string, target?: string): AppNode => {
  const n = makeNode(id, 'output');
  if (target) (n.data as Record<string, unknown>).meshTarget = { name: target };
  return n;
};

describe('findDefaultOutput', () => {
  it('is the only Output when there is one', () => {
    const only = output('o1');
    expect(findDefaultOutput([makeNode('c1', 'color'), only])).toBe(only);
  });

  it('skips a TARGETED Output to find the untargeted one', () => {
    // Targeting the Output you already had, then adding a second for the rest
    // of the model, is an ordinary way to reach two materials — and it puts
    // the targeted one first in the array.
    const glass = output('o1', 'Glass');
    const rest = output('o2');
    expect(findDefaultOutput([glass, rest])).toBe(rest);
  });

  it('is null when every Output is targeted', () => {
    // A legitimate document: it shades the meshes it names and leaves the rest
    // on the materials the model was authored with.
    expect(findDefaultOutput([output('o1', 'Glass'), output('o2', 'Body')])).toBeNull();
  });

  it('is null when there is no Output at all', () => {
    expect(findDefaultOutput([makeNode('c1', 'color')])).toBeNull();
  });

  it('follows ARRAY order, which is creation order and stable under wiring', () => {
    const first = output('o1');
    const second = output('o2');
    expect(findDefaultOutput([first, second])).toBe(first);
    expect(findDefaultOutput([second, first])).toBe(second);
  });

  it('outputNodes keeps array order and only Outputs', () => {
    const nodes = [makeNode('c1', 'color'), output('o1'), makeNode('c2', 'color'), output('o2')];
    expect(outputNodes(nodes).map((n) => n.id)).toEqual(['o1', 'o2']);
  });

  it('a targeted node that is not an Output is not targeted at all', () => {
    const colour = makeNode('c1', 'color');
    (colour.data as Record<string, unknown>).meshTarget = { name: 'Glass' };
    expect(meshTargetName(colour)).toBeNull();
    expect(findDefaultOutput([colour, output('o1')])?.id).toBe('o1');
  });
});

describe('consumers ask the shared helper', () => {
  // A source assertion because these are React components and store internals
  // that the node test env cannot mount. What matters is not HOW each site
  // reads the output but that none of them re-derives its own answer.
  const files = [
    'utils/nodeCost.ts',
    'utils/connectedUniforms.ts',
    'components/CodeEditor/CodeEditor.tsx',
    'components/Layout/PreviewLink.tsx',
    'components/Preview/ShaderPreview.tsx',
    'components/NodeEditor/menus/ShaderSettingsMenu.tsx',
    'engine/exportShader.ts',
    'engine/graphToCode.ts',
    'hooks/useSyncEngine.ts',
  ];

  for (const rel of files) {
    it(`${rel} does not re-derive "the output"`, () => {
      const src = readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
      const strays = src
        .split('\n')
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => /\.find\(\s*\(?\s*n\)?\s*=>\s*n\.data\.registryType === 'output'/.test(line));
      expect(
        strays.map(([n, l]) => `${rel}:${n} ${l.trim()}`),
        'use findDefaultOutput (or outputNodes) so every surface agrees which Output is which',
      ).toEqual([]);
    });
  }
});
