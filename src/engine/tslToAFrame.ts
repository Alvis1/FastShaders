/**
 * Converts graph-generated TSL code into a self-contained A-Frame HTML file.
 *
 * Uses the a-frame-shaderloader IIFE bundle (aframe-171-a-0.1.min.js) which
 * bundles A-Frame 1.7, Three.js (WebGPU), and tsl-textures together with
 * matching versions, so all features (including tsl-textures) work correctly.
 *
 * The shader code runs inside a custom A-Frame component that destructures
 * TSL functions from the global THREE.TSL namespace and tsl-textures from
 * window.tslTextures — both provided by the IIFE bundle.
 */

import {
  GEOMETRY_MAP,
  CHANNEL_TO_PROP,
  collectImports,
  extractFnBody,
  fixTDZ,
  parseBody,
} from './tslCodeProcessor';
import type { MaterialSettings } from '@/types';

export interface AFrameOptions {
  /** A-Frame geometry primitive (default: 'sphere') */
  geometry?: 'sphere' | 'cube' | 'torus' | 'plane';
  /** Embedded mode — hides VR button, minimal styling (for preview iframe) */
  embedded?: boolean;
  /** Add slow rotation animation to the entity */
  animate?: boolean;
  /** Material settings from the output node (displacement mode, etc.) */
  materialSettings?: MaterialSettings;
}

// IIFE bundle from the a-frame-shaderloader project — includes A-Frame 1.7,
// Three.js WebGPU build, and tsl-textures with matching compatible versions.
const IIFE_BUNDLE_URL =
  'https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/aframe-171-a-0.1.min.js';

export function tslToAFrame(
  tslCode: string,
  shaderName = 'tsl-shader',
  options: AFrameOptions = {},
): string {
  const {
    geometry = 'sphere',
    embedded = false,
    animate = false,
  } = options;

  // Sanitize name for use as component name (kebab-case, no special chars)
  const componentName = shaderName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'tsl-shader';

  const pageTitle = shaderName || 'TSL Shader';

  // Map geometry types to Three.js constructors
  const aframePrimitive = geometry === 'cube' ? 'box' : geometry;
  const threeGeometry = GEOMETRY_MAP[aframePrimitive] ?? GEOMETRY_MAP.sphere;

  // Extract imports (exclude 'Fn' — not needed in IIFE context), body, fix TDZ, parse channels
  const { tslNames, texNames } = collectImports(tslCode, true);
  const body = extractFnBody(tslCode, tslNames);
  const { processedBody, texAliases } = fixTDZ(body, tslNames, texNames);
  const { defLines, channels } = parseBody(processedBody, tslNames);

  // Ensure positionLocal (and normalLocal for normal-based displacement) are available
  const displacementMode = options.materialSettings?.displacementMode ?? 'normal';
  if (channels.position) {
    if (!tslNames.includes('positionLocal')) tslNames.push('positionLocal');
    if (displacementMode === 'normal' && !tslNames.includes('normalLocal')) {
      tslNames.push('normalLocal');
    }
  }

  // Build the full HTML document
  const lines: string[] = [];

  lines.push('<!DOCTYPE html>');
  lines.push('<html lang="en">');
  lines.push('<head>');
  lines.push('  <meta charset="UTF-8">');
  lines.push('  <meta name="viewport" content="width=device-width, initial-scale=1.0">');
  lines.push(`  <title>${pageTitle}</title>`);
  lines.push(`  <script src="${IIFE_BUNDLE_URL}"><${''}/script>`);

  if (embedded) {
    lines.push('  <style>');
    lines.push('    html, body { margin: 0; padding: 0; overflow: hidden; width: 100%; height: 100%; }');
    lines.push('  </style>');
  }

  lines.push('</head>');
  lines.push('<body>');
  lines.push('');

  // --- Inline component script (uses globals from IIFE bundle) ---
  lines.push('<script>');
  lines.push(`AFRAME.registerComponent('${componentName}', {`);
  lines.push('  init: function() {');
  lines.push('    try {');

  // Destructure TSL functions from the bundled globals
  if (tslNames.length > 0) {
    lines.push(`      var _TSL = THREE.TSL || THREE;`);
    // Destructure in groups of ~5 to keep lines readable
    const chunks = chunkArray(tslNames, 5);
    for (const chunk of chunks) {
      const assignments = chunk.map(n => `${n} = _TSL.${n}`).join(', ');
      lines.push(`      var ${assignments};`);
    }
  }

  // Destructure tsl-textures from the bundled globals
  if (texAliases.length > 0) {
    for (const { original, alias } of texAliases) {
      lines.push(`      var ${alias} = window.tslTextures.${original};`);
    }
  }
  lines.push('');

  // Emit node definitions
  for (const line of defLines) {
    lines.push('      ' + line.trimStart());
  }
  lines.push('');

  // Create mesh with node material — assign each channel
  lines.push('      var material = new THREE.MeshPhysicalNodeMaterial();');
  for (const [ch, ref] of Object.entries(channels)) {
    const prop = CHANNEL_TO_PROP[ch];
    if (prop) {
      if (ch === 'position') {
        const displacement = displacementMode === 'normal'
          ? `normalLocal.mul(${ref})`
          : ref;
        lines.push(`      material.${prop} = positionLocal.add(${displacement});`);
      } else {
        lines.push(`      material.${prop} = ${ref};`);
      }
    }
  }
  lines.push(`      var geometry = ${threeGeometry};`);
  lines.push('      var mesh = new THREE.Mesh(geometry, material);');
  lines.push("      this.el.setObject3D('mesh', mesh);");
  lines.push('    } catch (e) {');
  lines.push('      console.error("[FastShaders]", e);');
  lines.push('    }');
  lines.push('  },');
  lines.push('  remove: function() {');
  lines.push("    var mesh = this.el.getObject3D('mesh');");
  lines.push('    if (mesh) {');
  lines.push('      mesh.material.dispose();');
  lines.push('      mesh.geometry.dispose();');
  lines.push("      this.el.removeObject3D('mesh');");
  lines.push('    }');
  lines.push('  }');
  lines.push('});');
  lines.push(`<${''}/script>`);
  lines.push('');

  // --- Scene ---
  const sceneAttrs = embedded ? ' embedded' : '';

  const animAttr = animate
    ? ' animation="property: rotation; to: 0 360 0; loop: true; dur: 12000; easing: linear"'
    : '';

  lines.push(`<a-scene${sceneAttrs} background="color: #1a1a2e">`);
  lines.push(`  <a-entity ${componentName} position="0 1.5 -3" rotation="45 45 0"${animAttr}></a-entity>`);
  lines.push('  <a-light type="directional" position="1 2 1" intensity="1"></a-light>');
  lines.push('  <a-light type="ambient" intensity="0.4"></a-light>');
  lines.push('</a-scene>');
  lines.push('');
  lines.push('</body>');
  lines.push('</html>');
  lines.push('');

  return lines.join('\n');
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
