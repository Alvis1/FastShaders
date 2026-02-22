/**
 * Generates a self-contained A-Frame HTML page that renders a TSL shader
 * using the a-frame-shaderloader component. Used for the in-app preview iframe.
 *
 * Loads the IIFE bundle (A-Frame 1.7 + Three.js WebGPU + tsl-textures) and
 * the shaderloader from local files served via Vite's public directory.
 * The editor's TSL code is converted into a shaderloader-compatible ES module,
 * served as a blob URL, and applied via the shaderloader's `shader` component.
 */

import {
  CHANNEL_TO_PROP,
  collectImports,
  extractFnBody,
  fixTDZ,
  parseBody,
} from './tslCodeProcessor';
import type { MaterialSettings } from '@/types';

export interface PreviewOptions {
  geometry?: 'sphere' | 'cube' | 'torus' | 'plane';
  animate?: boolean;
  materialSettings?: MaterialSettings;
  bgColor?: string;
}

// Resolve full absolute URLs for the IIFE bundle and shaderloader at runtime.
// Blob URL iframes can't resolve path-only URLs, so we need the full origin.
function getScriptUrls() {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const base = import.meta.env.BASE_URL; // e.g. '/FastShaders/'
  return {
    iife: `${origin}${base}js/aframe-171-a-0.1.min.js`,
    shaderloader: `${origin}${base}js/a-frame-shaderloader-0.2.js`,
    orbitControls: `${origin}${base}js/aframe-orbit-controls.min.js`,
  };
}

/** THREE.FrontSide=0, THREE.BackSide=1, THREE.DoubleSide=2 */
const SIDE_VALUES: Record<string, number> = {
  front: 0,
  back: 1,
  double: 2,
};

/** A-Frame geometry component strings with high segment counts for TSL effects */
const AFRAME_GEO: Record<string, string> = {
  sphere: 'primitive: sphere; radius: 1; segmentsWidth: 64; segmentsHeight: 64',
  box: 'primitive: box; width: 1.4; height: 1.4; depth: 1.4',
  torus: 'primitive: torus; radius: 0.7; radiusTubular: 0.3; segmentsRadial: 64; segmentsTubular: 64',
  plane: 'primitive: plane; width: 2; height: 2',
};

/**
 * Convert editor TSL code (with Fn wrapper) into a shaderloader-compatible
 * ES module that exports a default function returning shader node properties.
 */
function convertToShaderModule(
  tslCode: string,
  materialSettings?: MaterialSettings,
): string {
  const { tslNames, texNames } = collectImports(tslCode, true);
  const body = extractFnBody(tslCode, tslNames);
  const { processedBody, texAliases } = fixTDZ(body, tslNames, texNames);
  const { defLines, channels } = parseBody(processedBody, tslNames);

  // Ensure positionLocal (and normalLocal for normal-based displacement) are available
  const displacementMode = materialSettings?.displacementMode ?? 'normal';
  if (channels.position) {
    if (!tslNames.includes('positionLocal')) tslNames.push('positionLocal');
    if (displacementMode === 'normal' && !tslNames.includes('normalLocal')) {
      tslNames.push('normalLocal');
    }
  }

  // Build import statements
  const imports: string[] = [];
  if (tslNames.length > 0) {
    imports.push(`import { ${tslNames.join(', ')} } from 'three/tsl';`);
  }
  if (texAliases.length > 0) {
    const specs = texAliases.map(t => `${t.original} as ${t.alias}`).join(', ');
    imports.push(`import { ${specs} } from 'tsl-textures';`);
  }

  // Build return object with node property names (colorNode, normalNode, etc.)
  const returnProps: string[] = [];
  for (const [ch, ref] of Object.entries(channels)) {
    const prop = CHANNEL_TO_PROP[ch];
    if (prop) {
      if (ch === 'position') {
        const displacement = displacementMode === 'normal'
          ? `normalLocal.mul(${ref})`
          : ref;
        returnProps.push(`${prop}: positionLocal.add(${displacement})`);
      } else {
        returnProps.push(`${prop}: ${ref}`);
      }
    }
  }

  // Material settings supported by the shaderloader
  if (materialSettings?.transparent) {
    returnProps.push('transparent: true');
  }
  if (materialSettings?.side) {
    returnProps.push(`side: ${SIDE_VALUES[materialSettings.side] ?? 0}`);
  }

  const lines = [
    ...imports,
    '',
    'export default function() {',
    ...defLines.map(l => '  ' + l.trimStart()),
    `  return { ${returnProps.join(', ')} };`,
    '}',
  ];

  return lines.join('\n');
}

export function tslToPreviewHTML(
  tslCode: string,
  options: PreviewOptions = {},
): string {
  const {
    geometry = 'sphere',
    animate = false,
    materialSettings,
    bgColor = '#1a1a2e',
  } = options;

  const shaderModule = convertToShaderModule(tslCode, materialSettings);
  const geoKey = geometry === 'cube' ? 'box' : geometry;
  const geoAttr = AFRAME_GEO[geoKey] ?? AFRAME_GEO.sphere;
  const { iife, shaderloader, orbitControls } = getScriptUrls();

  const animAttr = animate
    ? ' animation="property: rotation; to: 0 360 0; loop: true; dur: 12000; easing: linear"'
    : '';

  const lines: string[] = [];

  lines.push('<!DOCTYPE html>');
  lines.push('<html lang="en">');
  lines.push('<head>');
  lines.push('  <meta charset="UTF-8">');
  lines.push(`  <script src="${iife}" onerror="document.getElementById('error').textContent='Failed to load A-Frame bundle'"><${''}/script>`);
  lines.push(`  <script src="${shaderloader}" onerror="document.getElementById('error').textContent='Failed to load shaderloader'"><${''}/script>`);
  lines.push(`  <script src="${orbitControls}" onerror="document.getElementById('error').textContent='Failed to load orbit controls'"><${''}/script>`);
  lines.push('  <style>');
  lines.push('    html, body { margin: 0; padding: 0; overflow: hidden; width: 100%; height: 100%; }');
  lines.push('    #error { position: absolute; top: 8px; left: 8px; right: 8px; color: #ff6b6b; font: 12px/1.4 monospace; white-space: pre-wrap; z-index: 10; pointer-events: none; }');
  lines.push('  </style>');
  lines.push('</head>');
  lines.push('<body>');
  lines.push('<div id="error"></div>');
  lines.push('');

  // Create shader blob URL before the scene is parsed
  lines.push('<script>');
  lines.push(`  var __shaderCode = ${JSON.stringify(shaderModule)};`);
  lines.push('  var __shaderBlob = new Blob([__shaderCode], { type: "text/javascript" });');
  lines.push('  window.__shaderUrl = URL.createObjectURL(__shaderBlob);');
  lines.push(`<${''}/script>`);
  lines.push('');

  // A-Frame scene with camera (FOV 20) and orbit controls
  lines.push(`<a-scene vr-mode-ui="enabled: false" loading-screen="enabled: false" background="color: ${bgColor}">`);
  lines.push('  <a-entity camera="fov: 20; active: true" look-controls="enabled: false" orbit-controls="target: 0 0 0; minDistance: 2; maxDistance: 80; initialPosition: 0 0 8; rotateSpeed: 0.5">');
  lines.push('    <a-entity light="type: point" position="-2.54828 0.68055 -0.48012"></a-entity>');
  lines.push('    <a-entity light="type: point" position="0.93609 0.28506 2.65279"></a-entity>');
  lines.push('  </a-entity>');
  lines.push(`  <a-entity id="preview-entity" geometry="${geoAttr}" material="color: #808080" position="0 0 0" rotation="45 45 0"${animAttr}></a-entity>`);
  lines.push('  <a-light type="directional" position="1 2 1" intensity="1"></a-light>');
  lines.push('  <a-light type="ambient" intensity="0.4"></a-light>');
  lines.push('</a-scene>');
  lines.push('');

  // Set shader attribute after the entity element exists in the DOM
  lines.push('<script>');
  lines.push('  try {');
  lines.push('    document.getElementById("preview-entity").setAttribute("shader", "src: " + window.__shaderUrl);');
  lines.push('  } catch (e) {');
  lines.push('    console.error("[FastShaders Preview]", e);');
  lines.push('    var errEl = document.getElementById("error");');
  lines.push('    if (errEl) errEl.textContent = String(e);');
  lines.push('  }');
  lines.push(`<${''}/script>`);
  lines.push('');

  lines.push('</body>');
  lines.push('</html>');
  lines.push('');

  return lines.join('\n');
}
