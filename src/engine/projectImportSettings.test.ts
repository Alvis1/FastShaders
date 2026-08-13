/**
 * BUG-1 regression: a bare `.js` import must bring its OWN material settings
 * and must not inherit the previous graph's. Both halves were broken —
 * scriptToTSL deleted the incoming settings while useSyncEngine's mergeMatch
 * re-applied the outgoing ones.
 *
 * Node-env safe: importShaderText's bare-script branch only touches the store
 * and window-guarded CustomEvents. Same shape as projectImportMesh.test.ts,
 * which already drives importShaderText here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useAppStore } from '@/store/useAppStore';
import { makeNode } from '@/test-utils';
import { importShaderText } from './projectImport';
import { embedProjectState } from './fastShadersProject';
import type { OutputNodeData } from '@/types';

/** A shaderloader module whose return object carries `props` verbatim. */
const moduleWith = (props: string) => `import { color } from "three/tsl";

export default function (params) {
  return { colorNode: color(0xffffff)${props} };
}
`;

function outputSettings(): OutputNodeData['materialSettings'] {
  const out = useAppStore.getState().nodes.find((n) => n.data.registryType === 'output');
  return (out?.data as OutputNodeData | undefined)?.materialSettings;
}

beforeEach(() => {
  const out = makeNode('output-1', 'output');
  (out.data as unknown as OutputNodeData).materialSettings = {
    transparent: true,
    side: 'double',
    depthWrite: false,
  };
  useAppStore.setState({
    nodes: [out],
    edges: [],
    code: '',
    syncSource: 'graph',
    codeSyncRequested: false,
  });
});

describe('importShaderText: a bare script owns its material settings', () => {
  it("replaces the previous graph settings with the file's own", () => {
    expect(importShaderText(moduleWith(', alphaTest: 0.5'))).toBe('script');
    expect(outputSettings()).toEqual({ alphaTest: 0.5 });
  });

  it('CLEARS the previous graph settings when the file ships none', () => {
    expect(importShaderText(moduleWith(''))).toBe('script');
    expect(outputSettings()).toBeUndefined();
  });

  it('round-trips transparent + side + depthWrite', () => {
    importShaderText(moduleWith(', transparent: true, side: 1, depthWrite: false'));
    expect(outputSettings()).toEqual({ transparent: true, side: 'back', depthWrite: false });
  });

  it('stamps a FRESH object, never a mutation of the previous one', () => {
    // ShaderPreview, CodeEditor and mergeMatch all subscribe to
    // `materialSettings` BY REFERENCE and bail on Object.is — an in-place
    // update would leave every one of them showing the old settings.
    const before = outputSettings();
    importShaderText(moduleWith(', alphaTest: 0.5'));
    const after = outputSettings();
    expect(after).not.toBe(before);
    expect(before).toEqual({ transparent: true, side: 'double', depthWrite: false });
  });

  it('marks the update code-sourced so graph→code cannot clobber the import', () => {
    // Load-bearing: the stamp changes the nodes array, and sameGraphSemantics
    // compares node.data by REFERENCE — with syncSource still 'graph' the
    // graph→code effect would regenerate `code` from the OLD graph and
    // overwrite the text just imported. isUndoRedo must be cleared too, or
    // doCodeSync's pushHistory silently no-ops and the import is un-undoable.
    importShaderText(moduleWith(', transparent: true'));
    const s = useAppStore.getState();
    expect(s.syncSource).toBe('code');
    expect(s.codeSyncRequested).toBe(true);
    expect(s.isUndoRedo).toBe(false);
    expect(s.code).toContain('const shader = Fn(() => {');
    expect(s.code).not.toContain('transparent');
  });

  it('leaves a PROJECT-block import alone: the project graph wins', () => {
    const projOut = makeNode('output-9', 'output');
    (projOut.data as unknown as OutputNodeData).materialSettings = { side: 'back', alphaTest: 0.25 };
    const js = embedProjectState(moduleWith(', transparent: true'), {
      version: 1, shaderName: 'p',
      graph: { nodes: [projOut], edges: [] }, preview: {}, ui: {},
    } as never);
    expect(importShaderText(js)).toBe('project');
    expect(outputSettings()).toEqual({ side: 'back', alphaTest: 0.25 });
    expect(useAppStore.getState().syncSource).toBe('graph');
  });
});
