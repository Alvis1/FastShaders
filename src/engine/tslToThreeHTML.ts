/**
 * Builds the copy-ready `index.html` the code panel's **Three.js** tab shows: a
 * minimal plain-Three.js page that loads the exported shader module from the
 * SAME directory and puts it on a mesh.
 *
 * It is the A-Frame tab's sibling and shares its rules — the shader is a
 * sibling source file, every uniform is read off the module's own `schema`
 * block, and the page carries no comments — but it differs in one way that is
 * the whole reason this file exists:
 *
 * **A-Frame gets the material wiring for free; a plain page does not.** There,
 * the shaderloader component takes the module's return value and assigns each
 * key onto the built NodeMaterial. Here the page has to do it itself, and if it
 * restated the mapping it would drift from `tslCodeProcessor`'s the first time
 * a channel was added. It does not restate it: `buildShaderModule` already
 * emits the return object keyed by MATERIAL PROPERTY name (`colorNode`,
 * `emissiveNode`, …) rather than by channel, because it maps through
 * `CHANNEL_TO_PROP` at emission. So the page can assign the returned object
 * wholesale, and a new channel reaches this page with no change here at all.
 *
 * What it must NOT assign wholesale is the two keys in that object which are
 * not THREE.Material properties:
 *   · `parts` — the per-sub-mesh materials of a multimesh Output. They mean
 *     nothing on a primitive, and the loader's own fallback is to paint the
 *     FIRST part when a parts-only module meets a single mesh, so the page does
 *     the same rather than silently rendering the default material.
 *   · `mergeVertices` — the loader's opt-OUT of the vertex weld. A weld only
 *     matters for a displaced primitive whose shared corners would otherwise
 *     separate, so the page welds under exactly the loader's condition and
 *     honours the opt-out.
 *
 * Three r184 comes from jsdelivr, pinned to the version this app is built
 * against: the module is authored against that TSL surface, and a floating
 * `@latest` would let a future rename break a page the user has already saved.
 */
import type { GeometryType } from './tslToPreviewHTML.ts';
import { isModelGeometry } from './tslToPreviewHTML.ts';
import { parseShaderModuleSchema, readPreviewGeometry, type EmbedUniform } from './tslToAFrameHTML.ts';

/**
 * The three version the page loads. Pinned deliberately — see the header.
 * Keep in step with `package.json`'s `three` dependency; `threeEmbed.test.ts`
 * fails when they diverge, because a page built against a different TSL
 * surface than the module was emitted for fails at import time with a name
 * error and no hint as to why.
 */
export const THREE_VERSION = '0.184.0';

const CDN = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build`;

export interface ThreeEmbedOptions {
  /** File name of the exported module, expected beside this page. */
  shaderFile: string;
  /** Document title; falls back to the file name. */
  title?: string;
  /** The preview's current primitive, so the page shows what the editor shows. */
  geometry?: GeometryType;
  /** Radius of the Raymarch Output's window sphere, when one drives. */
  marchWindow?: number;
}

/** Same guard the A-Frame page applies: a bare, relative, single-segment name. */
function safeShaderFile(name: string): string {
  const base = String(name).split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '');
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'shader.js';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * A displacing module needs vertices to displace. The predicate is this file's
 * own — the same one the A-Frame page uses and for the same reason: only the
 * loader can answer it structurally off the built material, so a page built
 * from source text has to read the source text.
 */
function hasDisplacement(moduleSource: string): boolean {
  return /positionNode\s*:/.test(moduleSource);
}

/**
 * The geometry line, and the segment counts that make displacement visible.
 *
 * A `PlaneGeometry` or `BoxGeometry` at its default single segment per axis has
 * no interior vertices at all, so a `positionNode` moves nothing and the relief
 * the editor shows is ABSENT rather than coarse. 64 matches what the app's own
 * preview passes.
 */
function geometryExpr(geometry: GeometryType | undefined, displaced: boolean, marchWindow?: number): string {
  const seg = displaced ? 64 : 0;
  switch (geometry) {
    case 'cube':
      return seg ? `new THREE.BoxGeometry(1, 1, 1, ${seg}, ${seg}, ${seg})` : 'new THREE.BoxGeometry(1, 1, 1)';
    case 'plane':
      return seg ? `new THREE.PlaneGeometry(1.6, 1.6, ${seg}, ${seg})` : 'new THREE.PlaneGeometry(1.6, 1.6)';
    case 'teapot':
      // The editor tessellates the teapot from Bezier patches at runtime; a
      // standalone page has no such generator, so it shows the sphere the rest
      // of the defaults assume rather than pretending otherwise.
      return `new THREE.SphereGeometry(0.8, ${seg ? 128 : 64}, ${seg ? 64 : 32})`;
    case 'marchSphere': {
      // The march window: a ray-marched shader renders THROUGH this sphere, so
      // its radius is the Raymarch Output's Window and the camera may be inside
      // it — which is why the material below goes double-sided for this case.
      const r = Number.isFinite(marchWindow) && (marchWindow as number) > 0 ? marchWindow : 1;
      return `new THREE.SphereGeometry(${r}, 64, 32)`;
    }
    default:
      return `new THREE.SphereGeometry(0.8, ${seg ? 128 : 64}, ${seg ? 64 : 32})`;
  }
}

/**
 * The uniform defaults, as a JS object literal.
 *
 * `EmbedUniform.defaultValue` is normalized for direct interpolation into an
 * A-Frame ATTRIBUTE, where everything is an unquoted string — so a colour
 * arrives as a bare `#1b2a4a`, which in JS is a comment, and the object would
 * silently lose that key and every one after it on the same line. Numbers pass
 * through bare; anything else is quoted, and the quote character is escaped
 * because a `schema` default reaches here from the user's own property names
 * and values.
 */
function jsLiteral(u: EmbedUniform): string {
  if (u.type === 'number' && Number.isFinite(Number(u.defaultValue))) return u.defaultValue;
  return `'${u.defaultValue.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function uniformLines(uniforms: EmbedUniform[]): string[] {
  if (uniforms.length === 0) return ['const params = {};'];
  const out = ['const params = {'];
  uniforms.forEach((u, i) => {
    const last = i === uniforms.length - 1;
    out.push(`  ${u.name}: ${jsLiteral(u)}${last ? '' : ','}`);
  });
  out.push('};');
  return out;
}

/**
 * The page.
 *
 * Deliberately plain: one module script, no build step, no framework, no
 * orbit-controls import (a `pointermove` drag is six lines and keeps the page
 * to a single dependency). What it demonstrates is the part a reader cannot
 * guess — how the exported module becomes a material — and nothing else.
 */
export function buildThreeEmbedHTML(moduleSource: string, options: ThreeEmbedOptions): string {
  const uniforms = parseShaderModuleSchema(moduleSource);
  const file = safeShaderFile(options.shaderFile);
  const title = escapeHtml(options.title?.trim() || file);
  const geometry = isModelGeometry(options.geometry ?? 'sphere') ? 'sphere' : options.geometry;
  const displaced = hasDisplacement(moduleSource);
  const march = geometry === 'marchSphere';

  const L: string[] = [];
  L.push('<!DOCTYPE html>');
  L.push('<html lang="en">');
  L.push('<head>');
  L.push('  <meta charset="utf-8">');
  L.push('  <meta name="viewport" content="width=device-width, initial-scale=1">');
  L.push(`  <title>${title}</title>`);
  L.push('  <style>');
  L.push('    body { margin: 0; overflow: hidden; background: #808080; }');
  L.push('  </style>');
  L.push('  <script type="importmap">');
  L.push('  {');
  L.push('    "imports": {');
  L.push(`      "three": "${CDN}/three.webgpu.min.js",`);
  L.push(`      "three/webgpu": "${CDN}/three.webgpu.min.js",`);
  L.push(`      "three/tsl": "${CDN}/three.tsl.min.js"`);
  L.push('    }');
  L.push('  }');
  L.push(`  <${''}/script>`);
  L.push('</head>');
  L.push('<body>');
  L.push('  <script type="module">');
  L.push("    import * as THREE from 'three/webgpu';");
  L.push(`    import shader from './${file}';`);
  L.push('');
  L.push(...uniformLines(uniforms).map((l) => `    ${l}`));
  L.push('');
  L.push('    const renderer = new THREE.WebGPURenderer({ antialias: true });');
  L.push('    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));');
  L.push('    renderer.setSize(innerWidth, innerHeight);');
  L.push('    document.body.appendChild(renderer.domElement);');
  L.push('    await renderer.init();');
  L.push('');
  L.push('    const scene = new THREE.Scene();');
  L.push('    const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);');
  L.push(`    camera.position.set(0, 0, ${march ? '0.001' : '3'});`);
  L.push('');
  L.push('    scene.add(new THREE.AmbientLight(0xffffff, 0.6));');
  L.push('    const key = new THREE.DirectionalLight(0xffffff, 2);');
  L.push('    key.position.set(2, 3, 2);');
  L.push('    scene.add(key);');
  L.push('');
  L.push('    const material = new THREE.MeshStandardNodeMaterial();');
  L.push('    const out = shader(params);');
  // The two non-material keys, handled rather than assigned. `parts` first, so
  // a parts-only module still paints something on a single mesh.
  L.push('    const { parts, mergeVertices, ...nodes } = out;');
  L.push('    Object.assign(material, nodes);');
  L.push('    if (parts) Object.assign(material, Object.values(parts)[0] ?? {});');
  if (march) L.push('    material.side = THREE.DoubleSide;');
  L.push('');
  L.push(`    let geometry = ${geometryExpr(geometry, displaced, options.marchWindow)};`);
  if (displaced) {
    // The loader welds a displaced primitive so its shared corners move
    // together; without it a box splits into six floating faces.
    L.push("    if (mergeVertices !== false) {");
    L.push("      const { mergeVertices: weld } = await import('three/addons/utils/BufferGeometryUtils.js');");
    L.push('      geometry = weld(geometry);');
    L.push('    }');
  }
  L.push('    const mesh = new THREE.Mesh(geometry, material);');
  L.push('    scene.add(mesh);');
  L.push('');
  L.push('    let down = false, px = 0, py = 0;');
  L.push('    addEventListener(\'pointerdown\', (e) => { down = true; px = e.clientX; py = e.clientY; });');
  L.push('    addEventListener(\'pointerup\', () => { down = false; });');
  L.push('    addEventListener(\'pointermove\', (e) => {');
  L.push('      if (!down) return;');
  L.push('      mesh.rotation.y += (e.clientX - px) * 0.01;');
  L.push('      mesh.rotation.x += (e.clientY - py) * 0.01;');
  L.push('      px = e.clientX; py = e.clientY;');
  L.push('    });');
  L.push('');
  L.push('    addEventListener(\'resize\', () => {');
  L.push('      camera.aspect = innerWidth / innerHeight;');
  L.push('      camera.updateProjectionMatrix();');
  L.push('      renderer.setSize(innerWidth, innerHeight);');
  L.push('    });');
  L.push('');
  L.push('    renderer.setAnimationLoop(() => renderer.render(scene, camera));');
  L.push(`  <${''}/script>`);
  L.push('</body>');
  L.push('</html>');
  return L.join('\n') + '\n';
}

export { readPreviewGeometry };
