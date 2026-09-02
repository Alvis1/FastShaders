import { describe, it, expect } from 'vitest';
import { buildGeoAttr, GEOMETRY_ROTATIONS, SDF_WINDOW_GEOMETRY, isModelGeometry } from './tslToPreviewHTML';
import { buildAFrameEmbedHTML } from './tslToAFrameHTML';
import { sdfMaterialSettings } from './exportShader';
import { graphToCode } from './graphToCode';
import { makeNode, makeEdge } from '@/test-utils';

/**
 * An SDF Output renders through ITS OWN window, not the Model dropdown's
 * choice: the preview sphere clipped a box's corners, and a plane or a bunny
 * as the ray-start surface meant nothing. `drivingSdfOutput` is the ONE
 * predicate every surface asks (preview, PreviewLink, export, A-Frame tab).
 */
describe('the SDF window', () => {
  it('is a 2-unit single-segment box, a primitive, with the cube\'s resting tilt', () => {
    expect(buildGeoAttr(SDF_WINDOW_GEOMETRY as 'sdfBox', 64)).toBe(
      'primitive: box; width: 2; height: 2; depth: 2; segmentsWidth: 1; segmentsHeight: 1; segmentsDepth: 1',
    );
    expect(isModelGeometry(SDF_WINDOW_GEOMETRY)).toBe(false);
    expect(GEOMETRY_ROTATIONS[SDF_WINDOW_GEOMETRY]).toBe(GEOMETRY_ROTATIONS.cube);
  });

  it('the A-Frame page hangs the shader on a 2-unit <a-box>', () => {
    const mod = `import { vec3 } from 'three/tsl';\nexport default function() { return { colorNode: vec3(1) }; }\n`;
    const html = buildAFrameEmbedHTML(mod, { shaderFile: 'x.js', title: 'x', geometry: SDF_WINDOW_GEOMETRY });
    expect(html).toMatch(/<a-box position="0 1\.6 -3"\s+width="2" height="2" depth="2"/);
    const plain = buildAFrameEmbedHTML(mod, { shaderFile: 'x.js', title: 'x', geometry: 'cube' });
    expect(plain).not.toContain('width="2"');
  });
});

describe('sdfMaterialSettings', () => {
  const nodes = [makeNode('pos', 'positionLocal'), makeNode('sd', 'sdCircle'), makeNode('sdf', 'sdfOutput')];
  const wired = [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'sdf', 'field')];
  it('forces a double-sided material only while an SDF Output drives', () => {
    expect(sdfMaterialSettings(nodes, wired, { transparent: true })).toEqual({ transparent: true, side: 'double' });
    expect(sdfMaterialSettings(nodes, wired.slice(0, 1), { transparent: true })).toEqual({ transparent: true });
    expect(sdfMaterialSettings(nodes, wired.slice(0, 1), undefined)).toBeUndefined();
  });
});

describe('the march starts at the camera on a back face', () => {
  it('so a viewer inside the window still sees the shape', () => {
    const nodes = [makeNode('pos', 'positionLocal'), makeNode('sd', 'sdCircle'), makeNode('sdf', 'sdfOutput')];
    const edges = [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'sdf', 'field')];
    const { code } = graphToCode(nodes, edges);
    expect(code).toContain('const rd = normalize(sub(positionLocal, cam));');
    expect(code).toContain('const ro = select(frontFacing, positionLocal, cam);');
    expect(code.split('\n')[0]).toMatch(/\bfrontFacing\b/);
    expect(code.split('\n')[0]).toMatch(/\bselect\b/);
  });
});
