import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildGeoAttr, GEOMETRY_ROTATIONS, MARCH_WINDOW_GEOMETRY, isModelGeometry, tslToPreviewHTML } from './tslToPreviewHTML';
import { buildAFrameEmbedHTML } from './tslToAFrameHTML';
import { marchMaterialSettings } from './exportShader';
import { graphToCode } from './graphToCode';
import { makeNode, makeEdge } from '@/test-utils';

/**
 * A driving Raymarch Output renders through ITS OWN window: a sphere whose
 * radius is the node's Window setting. Large = the camera is inside it and the
 * sky fills the view (the material is double-sided; the march starts at the
 * camera on a back face).
 */
describe('the march window', () => {
  it('is a sphere of the Window radius, a primitive, with the cube\'s resting tilt', () => {
    expect(buildGeoAttr('marchSphere', 64, 40)).toBe('primitive: sphere; radius: 40; segmentsWidth: 48; segmentsHeight: 32');
    expect(buildGeoAttr('marchSphere', 64)).toContain('radius: 1;');
    expect(isModelGeometry(MARCH_WINDOW_GEOMETRY)).toBe(false);
    expect(GEOMETRY_ROTATIONS[MARCH_WINDOW_GEOMETRY]).toBe(GEOMETRY_ROTATIONS.cube);
  });

  it('the A-Frame page hangs the shader on an <a-sphere> of that radius', () => {
    const mod = `import { vec3 } from 'three/tsl';\nexport default function() { return { colorNode: vec3(1) }; }\n`;
    const html = buildAFrameEmbedHTML(mod, { shaderFile: 'x.js', title: 'x', geometry: MARCH_WINDOW_GEOMETRY, marchWindow: 40 });
    expect(html).toMatch(/<a-sphere position="0 1\.6 -3"\s+radius="40"/);
  });
});

describe('marchMaterialSettings + the camera-start march', () => {
  const nodes = [makeNode('pos', 'positionLocal'), makeNode('sd', 'sdCircle'), makeNode('rm', 'raymarchOutput')];
  const wired = [makeEdge('pos', 'out', 'sd', 'p'), makeEdge('sd', 'out', 'rm', 'field')];
  it('forces a double-sided material only while a Raymarch Output drives', () => {
    expect(marchMaterialSettings(nodes, wired, { transparent: true })).toEqual({ transparent: true, side: 'double' });
    expect(marchMaterialSettings(nodes, wired.slice(0, 1), undefined)).toBeUndefined();
  });
  it('the ray starts at the camera on a back face and exits at Window × 1.05', () => {
    const { code } = graphToCode(nodes, wired);
    expect(code).toContain('const pos = select(frontFacing, positionLocal, cam).toVar();');
    expect(code).toContain('If(r.greaterThan(mul(win, 1.05)), () => { Break(); });');
  });
});

/**
 * The VR popup renders what the PANE renders. `handleOpenVR` used to hand
 * `tslToPreviewHTML` the persisted Model choice (`geometry`) — which is PARKED
 * while a Raymarch Output drives — so the black hole was projected onto the
 * teapot in VR (2026-09-03). The popup must take `previewGeometry` plus the
 * window radius, exactly like the pane's own document.
 */
describe('the VR popup takes the march window', () => {
  it('the xr document itself hangs the shader on the window sphere', () => {
    const html = tslToPreviewHTML("import { vec3 } from 'three/tsl';\nconst shader = Fn(() => { return vec3(1); });\nexport default shader;\n", {
      geometry: MARCH_WINDOW_GEOMETRY, marchWindow: 40, xr: true, materialSettings: { side: 'double' },
    });
    expect(html).toContain('primitive: sphere; radius: 40;');
    expect(html).not.toMatch(/\sobj-model="/);
  });

  it('ShaderPreview.handleOpenVR passes previewGeometry + marchWindow, never the parked Model choice', () => {
    const src = readFileSync(resolve(__dirname, '../components/Preview/ShaderPreview.tsx'), 'utf8');
    const start = src.indexOf('const handleOpenVR = useCallback(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('}, [', start));
    expect(body).toContain('geometry: previewGeometry,');
    expect(body).toContain('marchWindow: marchWindow ?? 1,');
    expect(body).not.toMatch(/\n\s+geometry,\n/);
    expect(body).toContain("previewGeometry === 'custom' && previewMesh");
  });
});
