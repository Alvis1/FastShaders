import { describe, it, expect } from 'vitest';
import { buildAFrameEmbedHTML, parseShaderModuleSchema } from './tslToAFrameHTML';
import { tslToShaderModule, CDN_BASE, LOADER_FILE, type PropertyInfo } from './tslToShaderModule';

/** graphToCode-style TSL with a float property, a colour property and a mic. */
const TSL_WITH_PROPS = `import { Fn, uniform, color, mix, vec3 } from 'three/tsl';

const shader = Fn(() => {
  const speed = uniform(2.5);
  const tint = uniform(color(0xff8800));
  const mic1_level = uniform(0);
  const mix1 = mix(vec3(0, 0, 0), tint, speed.mul(mic1_level));

  return mix1;
});

export default shader;
`;

/** No properties at all — buildShaderModule omits the schema block entirely. */
const TSL_BARE = `import { Fn, vec3 } from 'three/tsl';

const shader = Fn(() => {
  return vec3(1, 0, 0);
});

export default shader;
`;

describe('parseShaderModuleSchema', () => {
  it('reads every uniform the generated module declares, with its type', () => {
    const mod = tslToShaderModule(TSL_WITH_PROPS);
    expect(mod).toContain('export const schema = {');
    expect(parseShaderModuleSchema(mod)).toEqual([
      { name: 'speed', type: 'number', defaultValue: '2.5' },
      { name: 'tint', type: 'color', defaultValue: '#ff8800' },
      { name: 'mic1_level', type: 'number', defaultValue: '0' },
    ]);
  });

  it('returns [] for a module with no schema block', () => {
    expect(parseShaderModuleSchema(tslToShaderModule(TSL_BARE))).toEqual([]);
  });

  it('stops at the closing brace instead of eating the module body', () => {
    const mod = tslToShaderModule(TSL_WITH_PROPS);
    const names = parseShaderModuleSchema(mod).map((u) => u.name);
    // `const speed = params.speed;` lives below the block and must not re-enter.
    expect(names.filter((n) => n === 'speed')).toHaveLength(1);
  });
});

describe('buildAFrameEmbedHTML', () => {
  const mod = tslToShaderModule(TSL_WITH_PROPS);
  const html = buildAFrameEmbedHTML(mod, { shaderFile: 'my-shader.js', title: 'My Shader' });

  it('loads the bundle and the loader from the same CDN base as the module header', () => {
    expect(html).toContain(`<script src="${CDN_BASE}/a-frame-180-a-01.min.js">`);
    expect(html).toContain(`<script src="${CDN_BASE}/${LOADER_FILE}">`);
  });

  it('references the shader as a bare sibling path', () => {
    expect(html).toContain('shader="src: my-shader.js;');
    // No directory prefix — the whole install step is "put the .js next to it".
    expect(html).not.toMatch(/src:\s*[./]*\w*\/my-shader\.js/);
  });

  it('exposes every uniform as an editable attribute row', () => {
    expect(html).toContain('speed: 2.5;');
    expect(html).toContain('tint: #ff8800;');
    expect(html).toContain('mic1_level: 0"></a-sphere>');
  });

  it('emits a bare src attribute when the shader has no uniforms', () => {
    const bare = buildAFrameEmbedHTML(tslToShaderModule(TSL_BARE), { shaderFile: 's.js' });
    expect(bare).toContain('<a-sphere position="0 1.6 -3" shader="src: s.js"></a-sphere>');
  });

  // "Use A-Frame defaults" is the whole design of this page: the default camera
  // (eye height + look/wasd controls), the default light rig and the default
  // Enter-VR button. Anything the page sets that A-Frame would have set itself
  // is a regression, so this pins their ABSENCE.
  it('overrides none of A-Frame\'s defaults', () => {
    expect(html).toContain('<a-scene>');
    for (const attr of ['vr-mode-ui', 'loading-screen', 'background', 'orbit-controls',
      'look-controls', 'wasd-controls', 'a-light', 'a-camera', 'a-entity camera', 'geometry=',
      'material=', 'segments-width', 'animation=', 'rotation=']) {
      expect(html, `page must not set ${attr}`).not.toContain(attr);
    }
  });

  it('carries no comments at all', () => {
    expect(html).not.toContain('<!--');
    expect(html).not.toMatch(/^\s*\/\//m);
  });

  it('places the object at eye height, three metres out, for a headset', () => {
    expect(html).toContain('position="0 1.6 -3"');
  });

  // Enter VR is the point of the page, and three's WebGPU backend throws in
  // XRManager.setSession — so the page must arrive on the WebGL2 path.
  it('hides navigator.gpu before A-Frame loads so WebXR can start', () => {
    const gpuAt = html.indexOf('Navigator.prototype,"gpu"');
    const aframeAt = html.indexOf('a-frame-180-a-01.min.js');
    expect(gpuAt).toBeGreaterThan(-1);
    expect(gpuAt).toBeLessThan(aframeAt);
    // Both defines: some browsers expose gpu on the prototype only.
    expect(html).toContain('Object.defineProperty(navigator,"gpu"');
  });

  it('is a complete document with a single scene and one balanced primitive', () => {
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(html.match(/<a-scene>/g)).toHaveLength(1);
    expect(html.match(/<\/a-scene>/g)).toHaveLength(1);
    expect(html.match(/<a-sphere /g)).toHaveLength(1);
    expect(html.match(/<\/a-sphere>/g)).toHaveLength(1);
  });

  it('follows the preview onto the matching A-Frame primitive', () => {
    expect(buildAFrameEmbedHTML(mod, { shaderFile: 'x.js', geometry: 'plane' })).toContain('<a-plane ');
    expect(buildAFrameEmbedHTML(mod, { shaderFile: 'x.js', geometry: 'cube' })).toContain('<a-box ');
    // A model-backed preview has no sibling model file; fall back to the sphere.
    expect(buildAFrameEmbedHTML(mod, { shaderFile: 'x.js', geometry: 'teapot' })).toContain('<a-sphere ');
    expect(buildAFrameEmbedHTML(mod, { shaderFile: 'x.js', geometry: 'custom' })).toContain('<a-sphere ');
  });

  // The page is assembled by string concatenation, and both of these arrive
  // from a .fastshader / pasted TSL — i.e. adversarial input.
  it('cannot be broken out of by a hostile file name', () => {
    const out = buildAFrameEmbedHTML(mod, {
      shaderFile: 'evil".js"><img src=x onerror=alert(1)>',
    });
    expect(/shader="src: ([^;"]+)/.exec(out)![1]).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(out.match(/<a-scene>/g)).toHaveLength(1);
    expect(out).not.toContain('<img');
  });

  it('escapes the title rather than letting it close the tag', () => {
    const out = buildAFrameEmbedHTML(mod, { shaderFile: 'x.js', title: '</title><script>x' });
    expect(out).toContain('&lt;/title&gt;&lt;script&gt;x');
  });
});

/**
 * A property named `src` sanitizes to the `shader` component's own schema key.
 * A-Frame's style parser is last-wins, so emitting it as a row would replace
 * the module path with the property's default — the page would load no shader
 * at all. The row is dropped so the path survives.
 */
describe('reserved attribute keys', () => {
  const TSL_SRC_PROP = `import { Fn, uniform, vec3 } from 'three/tsl';

const shader = Fn(() => {
  const src = uniform(0.5);
  const speed = uniform(2);
  return vec3(src, speed, 0);
});

export default shader;
`;

  it('keeps the module path when a property is named src', () => {
    const mod = tslToShaderModule(TSL_SRC_PROP);
    // The module itself still declares it — only the HTML row is dropped.
    expect(parseShaderModuleSchema(mod).map((u) => u.name)).toContain('src');

    const html = buildAFrameEmbedHTML(mod, { shaderFile: 'my-shader.js' });
    expect(html).toContain('src: my-shader.js');
    expect(html).toContain('speed: 2');
    // Exactly one `src:` chunk, and it is the file.
    expect(html.match(/\bsrc:/g)).toHaveLength(1);
  });

  // The module's own usage header writes the same `<a-entity …>` example and
  // had the identical collision, so the guard is shared rather than duplicated.
  // The header's example is driven by the DECLARED property list (what the
  // export passes from collectShaderProperties), not by the code's uniform
  // lines, so these two pass it explicitly.
  const PROPS: PropertyInfo[] = [
    { name: 'src', type: 'float', defaultValue: 0.5 },
    { name: 'speed', type: 'float', defaultValue: 2 },
  ];
  const headerLines = (tsl: string, props: PropertyInfo[]) =>
    tslToShaderModule(tsl, undefined, props).split('\n').filter((l) => l.startsWith('//'));

  it('keeps the module header example loadable too', () => {
    const header = headerLines(TSL_SRC_PROP, PROPS);
    const example = header.find((l) => l.includes('<a-entity'))!;
    expect(example.match(/\bsrc:/g)).toHaveLength(1);
    expect(example).toContain('speed: 2');
    expect(header.some((l) => l.includes('{ src:'))).toBe(false);
  });

  it('falls back to the no-property example when src is the only property', () => {
    const header = headerLines(TSL_SRC_PROP, [PROPS[0]]);
    const example = header.find((l) => l.includes('<a-entity'))!;
    // No dangling `; ` and no empty runtime-update list.
    expect(example).toContain('<a-entity shader="src: shader.js"></a-entity>');
    expect(header.some((l) => l.includes('can be updated at runtime'))).toBe(false);
  });
});

/**
 * The ONE deliberate exception to "A-Frame defaults only", and it is a
 * correctness fix: `<a-plane>`/`<a-box>` default to a SINGLE segment per axis,
 * so a plane is four vertices sharing one normal and a `positionNode` has
 * nothing to move — the relief the editor shows disappears entirely.
 */
describe('displacement tessellation', () => {
  const DISPLACE = `import { Fn, uniform, positionLocal, normalLocal, sin, vec3 } from 'three/tsl';

const shader = Fn(() => {
  const amount = uniform(0.2);
  const wave = sin(positionLocal.y.mul(8)).mul(amount);
  return { color: vec3(1, 0.5, 0), position: positionLocal.add(normalLocal.mul(wave)) };
});

export default shader;
`;
  const displacing = tslToShaderModule(DISPLACE);

  it('the fixture really does declare a positionNode', () => {
    // Guards the gate itself: if buildShaderModule stops emitting this key the
    // tests below would pass vacuously against a shader that never displaced.
    expect(displacing).toMatch(/positionNode\s*:/);
  });

  it('tessellates every primitive when the module displaces vertices', () => {
    for (const [geometry, tag] of [['sphere', 'a-sphere'], ['plane', 'a-plane'], ['cube', 'a-box']] as const) {
      const out = buildAFrameEmbedHTML(displacing, { shaderFile: 'd.js', geometry });
      expect(out, geometry).toContain(`<${tag} `);
      expect(out, geometry).toContain('segments-width="64"');
      expect(out, geometry).toContain('segments-height="64"');
      // Only the box has a third axis.
      expect(out.includes('segments-depth="64"'), geometry).toBe(tag === 'a-box');
    }
  });

  it('leaves a non-displacing shader on the bare defaults', () => {
    const out = buildAFrameEmbedHTML(tslToShaderModule(TSL_WITH_PROPS), { shaderFile: 'x.js', geometry: 'plane' });
    expect(out).not.toContain('segments-');
  });

  it('keeps the uniform rows aligned once the tag carries extra attributes', () => {
    const out = buildAFrameEmbedHTML(displacing, { shaderFile: 'd.js', geometry: 'plane' });
    const lines = out.split('\n');
    const openAt = lines.findIndex((l) => l.includes('<a-plane '));
    const col = (needle: string, from: number) => {
      const i = lines.findIndex((l, n) => n >= from && l.includes(needle));
      return lines[i].indexOf(needle);
    };
    // `segments-width` and `shader=` both sit under `position=`.
    expect(col('segments-width', openAt + 1)).toBe(col('position=', openAt));
    expect(col('shader="', openAt + 1)).toBe(col('position=', openAt));
    // …and the uniform rows sit under `src:`.
    expect(col('amount:', openAt + 1)).toBe(col('src:', openAt + 1));
  });
});
