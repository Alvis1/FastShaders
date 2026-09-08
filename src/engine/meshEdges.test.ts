import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildShaderModule } from './tslCodeProcessor';

/**
 * Mesh edges: how this app draws the model's REAL triangle edges.
 *
 * It does it in the shader, from a per-corner barycentric attribute the loader
 * injects on request. It deliberately does NOT set three's `material.wireframe`,
 * and that is a fix rather than an omission — see the last block.
 */

const TSL = `import { vec3 } from 'three/tsl';\nconst shader = Fn(() => {\n  return vec3(1, 0, 0);\n});`;

describe('the module asks the loader for barycentric corners', () => {
  it('emits `barycentric: true` when the code reads the bary attribute', () => {
    const withBary = buildShaderModule(
      `import { vec3, attribute } from 'three/tsl';\nconst shader = Fn(() => {\n  const b = attribute('bary', 'vec3');\n  return vec3(b);\n});`,
    );
    expect(withBary).toContain('barycentric: true');
  });

  it('emits nothing for a shader that does not use it', () => {
    // Byte-stability: every module written before this key is unchanged.
    expect(buildShaderModule(TSL)).not.toContain('barycentric');
  });

  it('the loader injects the attribute and can put the geometry back', () => {
    const loader = readFileSync('a-frame-shaderloader/js/a-frame-shaderloader-0.6.js', 'utf8');
    expect(loader).toContain('shaderResult.barycentric === true');
    expect(loader).toContain('toNonIndexed()');
    expect(loader).toContain('__fsBarySource');
  });

  it('welds BEFORE expanding, or the weld is undone', () => {
    // Welding makes coincident corners share a vertex; toNonIndexed then copies
    // that shared vertex's values into each corner, so a displaced surface still
    // deforms as one skin. The other order welds nothing.
    const loader = readFileSync('a-frame-shaderloader/js/a-frame-shaderloader-0.6.js', 'utf8');
    expect(loader.indexOf('this.syncBary();')).toBeGreaterThan(loader.indexOf('this.syncWeld();'));
    // ...and syncWeld drops ours first, or its identity guards are all false.
    expect(loader).toMatch(/syncWeld: function \(\)[\s\S]{0,400}this\.unbary\(\);/);
  });

  it('a failed apply puts every geometry back', () => {
    // unbary BEFORE unweld: unweld asks "is the mesh still wearing the geometry
    // WE welded", and our expanded one on top makes that false, stranding the
    // welded geometry with its source reference already dropped.
    const loader = readFileSync('a-frame-shaderloader/js/a-frame-shaderloader-0.6.js', 'utf8');
    const catchBlock = loader.slice(loader.indexOf('} catch (err) {'));
    expect(catchBlock.indexOf('this.unbary();')).toBeLessThan(catchBlock.indexOf('this.unweld();'));
  });

  it('never builds from a geometry that cannot describe a triangle', () => {
    // Reachable while a geometry is being swapped, and it would throw INSIDE
    // applyShader's try — surfacing as a "Shader error" banner over a shader
    // that is otherwise fine.
    const loader = readFileSync('a-frame-shaderloader/js/a-frame-shaderloader-0.6.js', 'utf8');
    expect(loader).toMatch(/if \(!pos \|\| pos\.count < 3\) return;/);
  });
});

describe('three.material.wireframe is deliberately NOT used', () => {
  /*
   * It looks like the cheapest possible wireframe — real triangle edges, zero
   * shader points, one line in the loader — and it was shipped that way for a
   * few hours. It crashes.
   *
   * `Geometries.js` reads, and ONLY when `material.wireframe === true`:
   *
   *     getWireframeId(geometry) {
   *       return geometry.index !== null
   *         ? geometry.index.id
   *         : geometry.attributes.position.id;   // <-- undefined.id
   *     }
   *
   * so a NON-INDEXED geometry with no position attribute throws
   * "Cannot read properties of undefined (reading 'id')". The mesh carries
   * exactly such a geometry for a moment while A-Frame swaps one in, which is
   * why it fired when the subdivision slider moved. REPRODUCED deterministically
   * in Chromium against the real renderer, and there is nothing to guard: the
   * throw is inside three's own render, not in any code this repo controls.
   *
   * Nothing is lost by dropping it — the Wireframe node's edges mode draws the
   * same edges antialiased, at a controllable pixel width, composited OVER the
   * shaded surface instead of replacing it. The trade is that it costs points
   * and triples the vertex count.
   */
  const files = {
    'MaterialSettings': 'src/types/node.types.ts',
    'the emitter': 'src/engine/tslCodeProcessor.ts',
    'the import parser': 'src/engine/scriptToTSL.ts',
    'Shader Settings': 'src/components/NodeEditor/menus/ShaderSettingsMenu.tsx',
    'the loader': 'a-frame-shaderloader/js/a-frame-shaderloader-0.6.js',
  };

  for (const [what, path] of Object.entries(files)) {
    it(`${what} does not set material.wireframe`, () => {
      const src = readFileSync(path, 'utf8');
      // Comments explaining the absence are fine; a live reference is not.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\*).*$/gm, '');
      expect(code).not.toMatch(/\bwireframe\b\s*[:=]/);
    });
  }
});
