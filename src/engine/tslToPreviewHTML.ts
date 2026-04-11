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
  CHANNEL_TO_PROP,
  collectImports,
  extractFnBody,
  fixTDZ,
  parseBody,
} from './tslCodeProcessor';
import type { MaterialSettings } from '@/types';

export type LightingMode = 'studio' | 'moon' | 'laboratory';

export interface CameraPosition {
  x: number;
  y: number;
  z: number;
}

export interface PreviewOptions {
  geometry?: 'sphere' | 'cube' | 'torus' | 'plane';
  animate?: boolean;
  materialSettings?: MaterialSettings;
  bgColor?: string;
  lighting?: LightingMode;
  /** Mesh subdivision count — applied symmetrically to each axis. */
  subdivision?: number;
  /**
   * Camera position to restore after orbit-controls initialization. Passed
   * out-of-band rather than baked into orbit-controls' `initialPosition` so
   * the controls' internal `position0` stays at the original `0 0 8` and
   * `reset()` snaps back there instead of to the saved view.
   */
  initialCameraPosition?: CameraPosition | null;
}

/**
 * Build the A-Frame `geometry` attribute string with the requested
 * subdivision count baked into the per-primitive segment fields. The
 * subdivision is clamped to a sensible range so the slider can't lock the
 * tab up with millions of vertices.
 */
function buildGeoAttr(
  geometry: 'sphere' | 'cube' | 'torus' | 'plane',
  subdivision: number,
): string {
  const seg = Math.max(1, Math.min(256, Math.round(subdivision)));
  switch (geometry) {
    case 'cube':
      return `primitive: box; width: 1.4; height: 1.4; depth: 1.4; segmentsWidth: ${seg}; segmentsHeight: ${seg}; segmentsDepth: ${seg}`;
    case 'torus':
      return `primitive: torus; radius: 0.7; radiusTubular: 0.3; segmentsRadial: ${seg}; segmentsTubular: ${seg}`;
    case 'plane':
      return `primitive: plane; width: 2; height: 2; segmentsWidth: ${seg}; segmentsHeight: ${seg}`;
    case 'sphere':
    default:
      return `primitive: sphere; radius: 1; segmentsWidth: ${seg}; segmentsHeight: ${seg}`;
  }
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

  // Rewrite property uniforms so the live overlay can drive them.
  //
  // Without this, `const property1 = uniform(1.0)` in the function body would
  // create an anonymous TSL uniform every render — the shaderloader's
  // auto-detected `_propertyUniforms.property1` would be a *separate* uniform
  // instance that's never passed into the function, so mutating its `.value`
  // (e.g. from a slider drag) would have no visible effect.
  //
  // By rewriting each line to `const property1 = params.property1` and
  // exporting an explicit `schema`, the shaderloader creates the uniforms
  // up-front, passes them in as `params`, and the function uses *those*
  // uniforms — so `_propertyUniforms.property1.value = N` reaches the material.
  const schemaEntries: Record<string, number> = {};
  const uniformLineRe = /^(\s*)const\s+(\w+)\s*=\s*uniform\(\s*(-?\d+(?:\.\d+)?)\s*\)\s*;?\s*$/;
  const rewrittenDefLines = defLines.map((line) => {
    const m = line.match(uniformLineRe);
    if (!m) return line;
    const [, indent, name, rawVal] = m;
    const val = parseFloat(rawVal);
    schemaEntries[name] = isNaN(val) ? 0 : val;
    return `${indent}const ${name} = params.${name};`;
  });
  const hasParams = Object.keys(schemaEntries).length > 0;

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

  // Build the explicit schema export so the shaderloader honors original
  // default values (its fallback `params.X` auto-detection always defaults to 0).
  const schemaLines: string[] = [];
  if (hasParams) {
    const schemaObj = Object.fromEntries(
      Object.entries(schemaEntries).map(([k, v]) => [k, { type: 'number', default: v }]),
    );
    schemaLines.push(`export const schema = ${JSON.stringify(schemaObj)};`);
    schemaLines.push('');
  }

  const lines = [
    ...imports,
    '',
    ...schemaLines,
    `export default function(${hasParams ? 'params' : ''}) {`,
    ...rewrittenDefLines.map(l => '  ' + l.trimStart()),
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
    lighting = 'studio',
    subdivision = 64,
    initialCameraPosition = null,
  } = options;

  const shaderModule = convertToShaderModule(tslCode, materialSettings);
  const geoAttr = buildGeoAttr(geometry, subdivision);
  const { iife, shaderloader, orbitControls } = getScriptUrls();

  // Plane spins on its Z axis (in-plane, like a record), since the flat face
  // is already pointed at the camera. Everything else spins on Y like a turntable.
  const animTo = geometry === 'plane' ? '0 0 360' : '0 360 0';
  const animAttr = animate
    ? ` animation="property: rotation; to: ${animTo}; loop: true; dur: 12000; easing: linear"`
    : '';

  // Plane is meant to be viewed flat-on, so leave it un-rotated (it already
  // faces +Z, which is where the camera sits). All other primitives keep the
  // 45/45 tilt so multiple faces are visible.
  const rotationAttr = geometry === 'plane' ? '0 0 0' : '45 45 0';

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

  lines.push(`<a-scene vr-mode-ui="enabled: false" loading-screen="enabled: false" background="color: ${bgColor}">`);
  lines.push('  <a-entity camera="fov: 20; active: true" look-controls="enabled: false" orbit-controls="target: 0 0 0; minDistance: 2; maxDistance: 80; initialPosition: 0 0 8; rotateSpeed: 0.5"></a-entity>');
  lines.push(`  <a-entity id="preview-entity" geometry="${geoAttr}" material="color: #808080" position="0 0 0" rotation="${rotationAttr}"${animAttr}></a-entity>`);

  if (lighting === 'studio') {
    // Three-point rig for material evaluation:
    // Key — raking angle, warm, exposes normal/bump detail
    // Rim — backlight, cool tint, defines specular silhouette
    // Fill — opposite key, neutral, lifts shadows
    // Ambient — minimal base so crevices aren't pure black
    lines.push('  <a-light type="directional" color="#fff5e6" position="-3 4 2" intensity="2.5"></a-light>');
    lines.push('  <a-light type="directional" color="#d4e5ff" position="2 3 -4" intensity="2.0"></a-light>');
    lines.push('  <a-light type="directional" color="#e8e8e8" position="4 1 3" intensity="0.6"></a-light>');
    lines.push('  <a-light type="ambient" color="#ffffff" intensity="0.15"></a-light>');
  } else if (lighting === 'moon') {
    // Single cool directional angled in front of the object so roughly 2/3 of
    // the camera-facing hemisphere is lit (terminator runs ~65° off the camera
    // axis). A faint ambient floor keeps the unlit side from going pure black.
    lines.push('  <a-light type="directional" color="#cfd8ff" position="-4 1.5 2" intensity="4.0"></a-light>');
    lines.push('  <a-light type="ambient" color="#1a1f33" intensity="0.05"></a-light>');
  } else if (lighting === 'laboratory') {
    // Pure flat ambient — every surface lit identically, no shadows.
    lines.push('  <a-light type="ambient" color="#ffffff" intensity="1.0"></a-light>');
  }

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

  // Bridge to parent: expose property uniforms for live overlay control AND
  // restore/sync camera position across iframe rebuilds.
  //
  // - Shader uniforms: poll for the shaderloader's `_propertyUniforms` (it's
  //   populated asynchronously after fetch/import/extendSchema), then
  //   announce readiness and listen for direct value updates. We mutate
  //   `.value` directly — going through setAttribute would round-trip through
  //   A-Frame's component data layer for no benefit.
  //
  // - Camera persistence: if the parent passed a saved position, apply it
  //   after orbit-controls initializes — and only after, so the controls'
  //   internal `position0` snapshot remains the original `0 0 8` and
  //   `reset()` snaps back to the home view, not the saved view. Then poll
  //   the camera position and post any changes back to the parent so the
  //   next iframe rebuild can restore it.
  const savedCamLiteral = initialCameraPosition
    ? JSON.stringify({ x: initialCameraPosition.x, y: initialCameraPosition.y, z: initialCameraPosition.z })
    : 'null';
  lines.push('<script>');
  lines.push(`  window.__savedCameraPos = ${savedCamLiteral};`);
  lines.push('  (function() {');
  lines.push('    var entity = document.getElementById("preview-entity");');
  lines.push('    var camEl = document.querySelector("[camera]");');
  lines.push('');
  lines.push('    // ----- shader uniform readiness + live updates -----');
  lines.push('    var shaderRetries = 0;');
  lines.push('    function checkShaderReady() {');
  lines.push('      var comp = entity && entity.components && entity.components.shader;');
  lines.push('      if (comp && comp._propertyUniforms) {');
  lines.push('        try {');
  lines.push('          window.parent.postMessage({');
  lines.push('            type: "fs:preview-ready",');
  lines.push('            uniforms: Object.keys(comp._propertyUniforms)');
  lines.push('          }, "*");');
  lines.push('        } catch (e) {}');
  lines.push('        return;');
  lines.push('      }');
  lines.push('      if (shaderRetries++ < 200) setTimeout(checkShaderReady, 50);');
  lines.push('    }');
  lines.push('    checkShaderReady();');
  lines.push('');
  lines.push('    // ----- orbit-controls readiness + camera persistence -----');
  lines.push('    var camRetries = 0;');
  lines.push('    function whenOrbitReady(cb) {');
  lines.push('      var oc = camEl && camEl.components && camEl.components["orbit-controls"];');
  lines.push('      if (oc && oc.controls) { cb(oc); return; }');
  lines.push('      if (camRetries++ < 200) setTimeout(function() { whenOrbitReady(cb); }, 50);');
  lines.push('    }');
  lines.push('    whenOrbitReady(function(oc) {');
  lines.push('      // Restore saved view (if any) AFTER controls init so position0 stays at home.');
  lines.push('      var saved = window.__savedCameraPos;');
  lines.push('      if (saved && camEl && camEl.object3D) {');
  lines.push('        camEl.object3D.position.set(saved.x, saved.y, saved.z);');
  lines.push('        try { oc.controls.update(); } catch (e) {}');
  lines.push('      }');
  lines.push('      // Post position back to the parent whenever it changes (cheap throttle).');
  lines.push('      var lx = NaN, ly = NaN, lz = NaN;');
  lines.push('      setInterval(function() {');
  lines.push('        var p = camEl && camEl.object3D && camEl.object3D.position;');
  lines.push('        if (!p) return;');
  lines.push('        if (p.x === lx && p.y === ly && p.z === lz) return;');
  lines.push('        lx = p.x; ly = p.y; lz = p.z;');
  lines.push('        try {');
  lines.push('          window.parent.postMessage({ type: "fs:camera", x: p.x, y: p.y, z: p.z }, "*");');
  lines.push('        } catch (e) {}');
  lines.push('      }, 200);');
  lines.push('    });');
  lines.push('');
  lines.push('    // ----- inbound messages from parent -----');
  lines.push('    window.addEventListener("message", function(e) {');
  lines.push('      var msg = e.data;');
  lines.push('      if (!msg) return;');
  lines.push('      if (msg.type === "fs:uniform") {');
  lines.push('        var comp = entity && entity.components && entity.components.shader;');
  lines.push('        if (!comp || !comp._propertyUniforms) return;');
  lines.push('        var u = comp._propertyUniforms[msg.name];');
  lines.push('        if (u) u.value = msg.value;');
  lines.push('      } else if (msg.type === "fs:reset-camera") {');
  lines.push('        var oc = camEl && camEl.components && camEl.components["orbit-controls"];');
  lines.push('        if (oc && oc.controls && typeof oc.controls.reset === "function") {');
  lines.push('          oc.controls.reset();');
  lines.push('        }');
  lines.push('      }');
  lines.push('    });');
  lines.push('  })();');
  lines.push(`<${''}/script>`);
  lines.push('');

  lines.push('</body>');
  lines.push('</html>');
  lines.push('');

  return lines.join('\n');
}
