/**
 * Generates a self-contained A-Frame HTML page that renders a TSL shader
 * using the a-frame-shaderloader component. Used for the in-app preview iframe.
 *
 * Loads the IIFE bundle (A-Frame 1.7 + Three.js WebGPU) and the shaderloader
 * from local files served via Vite's public directory. The editor's TSL code
 * is converted into a shaderloader-compatible ES module, served as a blob URL,
 * and applied via the shaderloader's `shader` component.
 */

import {
  AFRAME_GEO,
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
    shaderloader: `${origin}${base}js/a-frame-shaderloader-0.3.js`,
    orbitControls: `${origin}${base}js/aframe-orbit-controls.min.js`,
  };
}

/** THREE.FrontSide=0, THREE.BackSide=1, THREE.DoubleSide=2 */
const SIDE_VALUES: Record<string, number> = {
  front: 0,
  back: 1,
  double: 2,
};

/**
 * Convert editor TSL code (with Fn wrapper) into a shaderloader-compatible
 * ES module that exports a default function returning shader node properties.
 */
function convertToShaderModule(
  tslCode: string,
  materialSettings?: MaterialSettings,
): string {
  const { tslNames } = collectImports(tslCode, true);
  const body = extractFnBody(tslCode, tslNames);
  const processedBody = fixTDZ(body, tslNames);
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
  if (materialSettings?.alphaTest) {
    returnProps.push(`alphaTest: ${materialSettings.alphaTest}`);
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
    bgColor = '#808080',
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

  // A-Frame scene with three-point lighting rig for material evaluation
  // Key light: strong directional at ~55° raking angle — exposes normal/bump detail
  // Rim light: backlight behind object — defines specularity and silhouette
  // Fill light: soft low-intensity opposite key — lifts shadows without flattening
  // Ambient: minimal base to prevent pure black
  lines.push(`<a-scene vr-mode-ui="enabled: false" loading-screen="enabled: false" background="color: ${bgColor}">`);
  lines.push('  <a-entity camera="fov: 20; active: true" look-controls="enabled: false" orbit-controls="target: 0 0 0; minDistance: 2; maxDistance: 80; initialPosition: 0 0 8; rotateSpeed: 0.5"></a-entity>');
  lines.push(`  <a-entity id="preview-entity" geometry="${geoAttr}" material="color: #808080" position="0 0 0" rotation="45 45 0"${animAttr}></a-entity>`);
  // Key light — raking angle (~55° from camera axis), warm, high intensity
  lines.push('  <a-light type="directional" color="#fff5e6" position="-3 4 2" intensity="2.5"></a-light>');
  // Rim light — behind and above, cool tint, high intensity for specular edge
  lines.push('  <a-light type="directional" color="#d4e5ff" position="2 3 -4" intensity="2.0"></a-light>');
  // Fill light — opposite key, neutral, low intensity
  lines.push('  <a-light type="directional" color="#e8e8e8" position="4 1 3" intensity="0.6"></a-light>');
  // Ambient — very low, just enough to prevent pure black in crevices
  lines.push('  <a-light type="ambient" color="#ffffff" intensity="0.15"></a-light>');
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
