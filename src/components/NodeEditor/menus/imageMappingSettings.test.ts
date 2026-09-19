import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { UV_MAPPING_KEYS } from '@/utils/imageUvMapping';

/**
 * Source pins for the glTF mapping block (vitest runs in `node`, so the React
 * component cannot be rendered): where it is mounted, that it reads and writes
 * through the ONE reader and writer, and that nothing else reads the keys.
 */
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const MAPPING = read('./ImageMappingSettings.tsx');
const IMAGE_SETTINGS = read('./ImageNodeSettings.tsx');
const CODEGEN = read('../../../engine/graphToCode.ts');
const SHADER_NODE = read('../nodes/ShaderNode.tsx');
const NODE_VISUAL = read('../nodes/NodeVisual.tsx');
const CARD = read('../NodePreviewCard.tsx');

describe('the glTF mapping block', () => {
  it('is mounted in the Image settings only outside a study session', () => {
    expect(IMAGE_SETTINGS).toContain('{!study && <ImageMappingSettings nodeId={nodeId} />}');
    expect(IMAGE_SETTINGS).toMatch(/const study = isEvalMode\(\);/);
  });

  it('opens collapsed, and a menu moved to another node arrives collapsed', () => {
    expect(MAPPING).toContain('useState<string | null>(null)');
    expect(MAPPING).toContain('const open = openFor === nodeId;');
    expect(MAPPING).toContain('aria-expanded={open}');
  });

  it('reads through readImageUvMapping and writes through withUvMapping against the LIVE node', () => {
    expect(MAPPING).toContain('readImageUvMapping(getNodeValues(node))');
    expect(MAPPING).toContain('useAppStore.getState().nodes.find((n) => n.id === nodeId)');
    expect(MAPPING).toContain('updateNodeData(nodeId, { values: withUvMapping(getNodeValues(live), patch) })');
    // One write path: every control goes through `write`.
    expect(MAPPING.match(/updateNodeData\(/g)?.length).toBe(1);
    for (const k of UV_MAPPING_KEYS) {
      expect(MAPPING, k).not.toMatch(new RegExp(`values\\??\\.${k}\\b`));
      expect(MAPPING, k).not.toContain(`'${k}'`);
    }
  });

  it('maps the UV-set select through a closed table, never Number()', () => {
    expect(MAPPING).not.toMatch(/Number\(e\.target\.value\)/);
  });
});

describe('the mapping keys have one reader', () => {
  it('codegen reads them only through readImageUvMapping', () => {
    expect(CODEGEN).toContain('const mapping = readImageUvMapping(nv);');
    expect(CODEGEN).toContain('readImageUvMapping(getNodeValues(sourceNode)).normalGreenFlip');
    for (const k of UV_MAPPING_KEYS) {
      expect(CODEGEN, k).not.toContain(`nv.${k}`);
      expect(CODEGEN, k).not.toContain(`nv['${k}']`);
      expect(CODEGEN, k).not.toContain(`numVal('${k}'`);
    }
  });

  it('the node face and every replica leave them alone (the card shows the picture, not its mapping)', () => {
    for (const [name, src] of [['ShaderNode', SHADER_NODE], ['NodeVisual', NODE_VISUAL], ['NodePreviewCard', CARD]] as const) {
      for (const k of UV_MAPPING_KEYS) expect(src, `${name} ${k}`).not.toContain(`.${k}`);
    }
  });
});
