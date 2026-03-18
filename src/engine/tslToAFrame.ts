/**
 * Converts graph-generated TSL code into a self-contained A-Frame HTML file.
 *
 * Uses the a-frame-shaderloader to apply the shader — loads the IIFE bundle
 * (aframe-171-a-0.1.min.js) which bundles A-Frame 1.7 + Three.js WebGPU +
 * tsl-textures, and the shaderloader component (a-frame-shaderloader-0.3.js).
 *
 * The shader module code is embedded inline as a blob URL and applied via
 * the shaderloader's `shader` component attribute.
 */

import { tslToShaderModule, type PropertyInfo } from './tslToShaderModule';
import { AFRAME_GEO } from './tslCodeProcessor';
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
  /** Property definitions for configurable uniforms */
  properties?: PropertyInfo[];
}

// IIFE bundle from the a-frame-shaderloader project — includes A-Frame 1.7,
// Three.js WebGPU build, and tsl-textures with matching compatible versions.
const CDN_BASE = 'https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js';
const IIFE_BUNDLE_URL = `${CDN_BASE}/aframe-171-a-0.1.min.js`;
const SHADERLOADER_URL = `${CDN_BASE}/a-frame-shaderloader-0.3.js`;

/**
 * Strip usage comment lines from the top of tslToShaderModule output,
 * returning just the bare module code for embedding.
 */
function stripHeaderComments(code: string): string {
  const lines = code.split('\n');
  let start = 0;
  // Skip leading comment and blank lines
  while (start < lines.length && (lines[start].startsWith('//') || lines[start].trim() === '')) {
    start++;
  }
  return lines.slice(start).join('\n').trim();
}

export function tslToAFrame(
  tslCode: string,
  shaderName = 'tsl-shader',
  options: AFrameOptions = {},
): string {
  const {
    geometry = 'sphere',
    embedded = false,
    animate = false,
    materialSettings,
    properties,
  } = options;

  const pageTitle = shaderName || 'TSL Shader';
  const geoKey = geometry === 'cube' ? 'box' : geometry;
  const geoAttr = AFRAME_GEO[geoKey] ?? AFRAME_GEO.sphere;

  // Generate shader module code (same as Script tab) and strip header comments
  const fullModule = tslToShaderModule(tslCode, materialSettings, properties);
  const shaderModule = stripHeaderComments(fullModule);

  const animAttr = animate
    ? ' animation="property: rotation; to: 0 360 0; loop: true; dur: 12000; easing: linear"'
    : '';

  const sceneAttrs = embedded ? ' embedded' : '';

  const lines: string[] = [];

  lines.push('<!DOCTYPE html>');
  lines.push('<html lang="en">');
  lines.push('<head>');
  lines.push('  <meta charset="UTF-8">');
  lines.push('  <meta name="viewport" content="width=device-width, initial-scale=1.0">');
  lines.push(`  <title>${pageTitle}</title>`);
  lines.push(`  <script src="${IIFE_BUNDLE_URL}"><${''}/script>`);
  lines.push(`  <script src="${SHADERLOADER_URL}"><${''}/script>`);

  if (embedded) {
    lines.push('  <style>');
    lines.push('    html, body { margin: 0; padding: 0; overflow: hidden; width: 100%; height: 100%; }');
    lines.push('  </style>');
  }

  lines.push('</head>');
  lines.push('<body>');
  lines.push('');

  // Create shader blob URL from inline module code
  lines.push('<script>');
  lines.push(`var __shaderCode = ${JSON.stringify(shaderModule)};`);
  lines.push('var __blob = new Blob([__shaderCode], { type: "text/javascript" });');
  lines.push('window.__shaderUrl = URL.createObjectURL(__blob);');
  lines.push(`<${''}/script>`);
  lines.push('');

  // A-Frame scene
  lines.push(`<a-scene${sceneAttrs} background="color: #1a1a2e">`);
  lines.push(`  <a-entity id="shader-entity" geometry="${geoAttr}" position="0 1.5 -3" rotation="45 45 0"${animAttr}></a-entity>`);
  lines.push('  <a-light type="directional" position="1 2 1" intensity="1"></a-light>');
  lines.push('  <a-light type="ambient" intensity="0.4"></a-light>');
  lines.push('</a-scene>');
  lines.push('');

  // Apply shader after the entity exists in the DOM
  lines.push('<script>');
  lines.push('document.getElementById("shader-entity").setAttribute("shader", "src: " + window.__shaderUrl);');
  lines.push(`<${''}/script>`);
  lines.push('');

  lines.push('</body>');
  lines.push('</html>');
  lines.push('');

  return lines.join('\n');
}
