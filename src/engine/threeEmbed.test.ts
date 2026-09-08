/**
 * The code panel's **Three.js** tab: a copy-ready `index.html` that loads the
 * exported module from beside it and puts it on a mesh.
 *
 * It is the A-Frame tab's sibling, so `tslToAFrameHTML.test.ts` covers the
 * rules they share (the schema is the uniform source, the shader is a sibling
 * file, the page carries no comments). What is pinned HERE is what only this
 * page has to get right: it does its own material wiring, where A-Frame's
 * loader component did that for it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildThreeEmbedHTML, THREE_VERSION } from './tslToThreeHTML';

const MODULE = `// TSL Shader Module
import { Fn, uniform, vec3, mix, positionLocal } from 'three/tsl';

export const schema = {
  colorA: { type: 'color', default: '#1b2a4a' },
  speed: { type: 'number', default: 2 },
};

export default function(params) {
  const colorA = uniform(params.colorA);
  const speed = uniform(params.speed);
  return { colorNode: mix(colorA, vec3(1), speed), roughnessNode: speed };
}
`;

const DISPLACING = MODULE.replace(
  'return { colorNode:',
  'return { positionNode: positionLocal.add(vec3(0, 0.1, 0)), colorNode:',
);

const build = (src = MODULE, opts = {}) =>
  buildThreeEmbedHTML(src, { shaderFile: 'my-shader.js', title: 'My Shader', ...opts });

describe('the Three.js embed page', () => {
  it('loads the module from beside it, by a bare relative path', () => {
    const html = build();
    expect(html).toContain("import shader from './my-shader.js';");
    // A traversal or an absolute path would make "drop the .js next to it"
    // false, which is the page's entire install step.
    // The guard takes the last segment and strips everything that is not a
    // bare file-name character, so a traversal cannot survive it.
    expect(buildThreeEmbedHTML(MODULE, { shaderFile: '../../etc/passwd' }))
      .toContain("import shader from './passwd';");
  });

  it('pins three to the version the app is built against', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    // The module is authored against THIS TSL surface. A floating tag would let
    // a later rename break a page the user has already saved, with an import
    // error that names nothing the user recognises.
    expect(pkg.dependencies.three).toContain(THREE_VERSION);
    const html = build();
    expect(html).toContain(`three@${THREE_VERSION}/build/three.webgpu.min.js`);
    expect(html).toContain(`three@${THREE_VERSION}/build/three.tsl.min.js`);
    expect(html).not.toContain('@latest');
  });

  it('maps three, three/webgpu and three/tsl — the module imports the last of them', () => {
    const html = build();
    for (const spec of ['"three"', '"three/webgpu"', '"three/tsl"']) {
      expect(html, `${spec} missing from the import map`).toContain(spec);
    }
  });

  it('assigns the module output onto the material WITHOUT restating the channel map', () => {
    const html = build();
    // buildShaderModule already emits the return object keyed by material
    // property name, so the page assigns it wholesale — which is what lets a
    // new channel reach this page with no change to the generator.
    expect(html).toContain('const out = shader(params);');
    expect(html).toContain('Object.assign(material, nodes);');
    // A hardcoded list here would be the drift this design exists to avoid.
    for (const prop of ['colorNode:', 'emissiveNode:', 'roughnessNode:']) {
      expect(html, `${prop} is being restated in the generator`).not.toContain(`material.${prop}`);
    }
  });

  it('separates the two returned keys that are NOT material properties', () => {
    const html = build();
    expect(html).toContain('const { parts, mergeVertices, ...nodes } = out;');
    // A parts-only module on a single mesh paints the first part — the same
    // fallback the loader applies, rather than silently showing the default.
    expect(html).toContain('if (parts) Object.assign(material, Object.values(parts)[0] ?? {});');
  });

  it('gives a displacing shader vertices to displace, and welds them', () => {
    const flat = build();
    const bumpy = build(DISPLACING, { geometry: 'plane' });
    // A default PlaneGeometry is four corners: a positionNode moves nothing and
    // the relief is ABSENT, not coarse.
    expect(flat).toContain('new THREE.SphereGeometry(0.8, 64, 32)');
    expect(bumpy).toContain('new THREE.PlaneGeometry(1.6, 1.6, 64, 64)');
    // …and the weld, which is what stops a displaced box splitting into six
    // floating faces. Honours the module's opt-out.
    expect(bumpy).toContain('if (mergeVertices !== false) {');
    expect(flat).not.toContain('mergeVertices !== false');
  });

  it('renders a march window from inside, double-sided', () => {
    const html = build(MODULE, { geometry: 'marchSphere', marchWindow: 4 });
    expect(html).toContain('new THREE.SphereGeometry(4, 64, 32)');
    // The camera sits inside the window sphere, so a back face is what it sees.
    expect(html).toContain('material.side = THREE.DoubleSide;');
    expect(html).toContain('camera.position.set(0, 0, 0.001);');
  });

  it('lists every uniform the module declares, and only those', () => {
    const html = build();
    // A colour must be a JS STRING here. The schema's `defaultValue` is
    // normalized for an A-Frame attribute, where a bare `#1b2a4a` is fine; in a
    // JS object literal it is a comment that swallows the rest of the line.
    expect(html).toContain("colorA: '#1b2a4a'");
    expect(html).toContain('speed: 2');
    const none = buildThreeEmbedHTML(MODULE.replace(/export const schema = \{[\s\S]*?\};/, ''), {
      shaderFile: 'x.js',
    });
    expect(none).toContain('const params = {};');
  });

  it('falls back to a primitive for a model geometry, which it cannot load', () => {
    // `custom` and `bunny` are model files the editor fetches; a standalone
    // page has no such file beside it, so promising one would render nothing.
    for (const g of ['custom', 'bunny', 'teapot'] as const) {
      expect(build(MODULE, { geometry: g })).toContain('new THREE.SphereGeometry(0.8,');
    }
  });

  it('carries no comments, like its A-Frame sibling', () => {
    const html = build();
    const body = html.slice(html.indexOf('<body>'));
    expect(body).not.toMatch(/^\s*\/\//m);
    expect(body).not.toContain('<!--');
  });

  it('escapes the title rather than interpolating it into markup', () => {
    const html = buildThreeEmbedHTML(MODULE, { shaderFile: 'x.js', title: '</title><script>x' });
    expect(html).not.toContain('</title><script>x');
    expect(html).toContain('&lt;/title&gt;');
  });
});
