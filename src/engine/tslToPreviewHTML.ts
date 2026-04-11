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

export type GeometryType = 'sphere' | 'cube' | 'plane' | 'teapot' | 'bunny';

/** Geometry types backed by an OBJ model file rather than an A-Frame primitive. */
const OBJ_GEOMETRIES: ReadonlySet<GeometryType> = new Set(['teapot', 'bunny']);

export function isObjGeometry(geometry: GeometryType): boolean {
  return OBJ_GEOMETRIES.has(geometry);
}

export interface CameraPosition {
  x: number;
  y: number;
  z: number;
}

export interface PreviewOptions {
  geometry?: GeometryType;
  animate?: boolean;
  materialSettings?: MaterialSettings;
  bgColor?: string;
  lighting?: LightingMode;
  /** Mesh subdivision count — applied symmetrically to each axis (primitives only). */
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
  geometry: 'sphere' | 'cube' | 'plane',
  subdivision: number,
): string {
  const seg = Math.max(1, Math.min(256, Math.round(subdivision)));
  switch (geometry) {
    case 'cube':
      return `primitive: box; width: 1.4; height: 1.4; depth: 1.4; segmentsWidth: ${seg}; segmentsHeight: ${seg}; segmentsDepth: ${seg}`;
    case 'plane':
      return `primitive: plane; width: 2; height: 2; segmentsWidth: ${seg}; segmentsHeight: ${seg}`;
    case 'sphere':
    default:
      return `primitive: sphere; radius: 1; segmentsWidth: ${seg}; segmentsHeight: ${seg}`;
  }
}

/**
 * Resolve the absolute URL of an OBJ model in `public/models/`. The iframe
 * loads from a blob URL, so relative paths won't resolve — we need the full
 * origin-qualified URL.
 */
function getModelUrl(geometry: 'teapot' | 'bunny'): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const base = import.meta.env.BASE_URL;
  const file = geometry === 'bunny' ? 'stanford-bunny.obj' : 'teapot.obj';
  return `${origin}${base}models/${file}`;
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
 * A-Frame component registration for OBJ-backed previews. On `model-loaded`,
 * for every Mesh in the loaded hierarchy:
 *   1. **Merge vertices by position.** OBJLoader returns non-indexed geometry
 *      where every triangle owns its own vertices, so a position shared by N
 *      faces becomes N duplicate vertices with N different face normals. Per-
 *      vertex displacement (`positionLocal + normalLocal * val`) then pushes
 *      each duplicate along *its own* face normal and the shape splits open.
 *      Merging by quantized position rebuilds an index so shared points stay
 *      a single vertex — and after \`computeVertexNormals\` they share a single
 *      averaged smooth normal, so displacement keeps faces stitched together.
 *   2. Compute vertex normals from the merged (indexed) geometry, producing
 *      smooth shading regardless of whether the source file had normals.
 *   3. Generate spherical UVs from each vertex's direction relative to the
 *      geometry's local center, so TSL shaders reading \`uv()\` get meaningful
 *      values. Spherical projection seams at the atan2 wrap; acceptable for
 *      procedural shaders (proper unwrap needs offline tools).
 *   4. Recenter the world bbox at the origin and rescale so the longest axis
 *      equals \`data.size\` — bunny (mm) and teapot (tens of units) otherwise
 *      would not frame anywhere near the primitives.
 *
 * String literal so the iframe sees raw JS — no Vite transformation pass.
 */
const FIT_BOUNDS_SCRIPT = `<script>
  if (window.AFRAME && !AFRAME.components["fit-bounds"]) {
    // Merge vertices that share a quantized position. Discards old normals/UVs
    // (they index into the old layout and we recompute both anyway) and
    // returns a freshly indexed BufferGeometry.
    function mergeByPosition(geom) {
      var pos = geom.attributes.position;
      if (!pos) return geom;
      var oldIndex = geom.index;
      var precision = 1e4; // 4 decimal places — tighter than typical OBJ precision
      var lookup = Object.create(null);
      var newPositions = [];
      var remap = new Uint32Array(pos.count);
      var nextIndex = 0;
      for (var i = 0; i < pos.count; i++) {
        var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        var key = Math.round(x * precision) + "_" + Math.round(y * precision) + "_" + Math.round(z * precision);
        var idx = lookup[key];
        if (idx === undefined) {
          idx = nextIndex++;
          lookup[key] = idx;
          newPositions.push(x, y, z);
        }
        remap[i] = idx;
      }
      var indexCount = oldIndex ? oldIndex.count : pos.count;
      var Arr = nextIndex < 65535 ? Uint16Array : Uint32Array;
      var newIndex = new Arr(indexCount);
      if (oldIndex) {
        for (var j = 0; j < indexCount; j++) newIndex[j] = remap[oldIndex.getX(j)];
      } else {
        for (var k = 0; k < indexCount; k++) newIndex[k] = remap[k];
      }
      var merged = new THREE.BufferGeometry();
      merged.setAttribute("position", new THREE.BufferAttribute(new Float32Array(newPositions), 3));
      merged.setIndex(new THREE.BufferAttribute(newIndex, 1));
      return merged;
    }

    AFRAME.registerComponent("fit-bounds", {
      schema: { size: { type: "number", default: 1.6 } },
      init: function () { this.el.addEventListener("model-loaded", this.fit.bind(this)); },
      fit: function () {
        var mesh = this.el.getObject3D("mesh");
        if (!mesh) return;
        mesh.traverse(function (node) {
          if (!node.isMesh || !node.geometry) return;
          var g = mergeByPosition(node.geometry);
          g.computeVertexNormals();
          var pos = g.attributes.position;
          g.computeBoundingBox();
          var c = new THREE.Vector3();
          g.boundingBox.getCenter(c);
          // Detect inverted winding (e.g. the Stanford bunny OBJ uses CW
          // triangles, so computeVertexNormals produces inward-facing normals
          // and displacement pushes the surface *into* the mesh). Sample a
          // sparse set of vertices: if most have a normal pointing toward the
          // centroid, the winding is reversed — flip every triangle and
          // recompute.
          var nrm = g.attributes.normal;
          var inward = 0, sampled = 0;
          var step = Math.max(1, Math.floor(pos.count / 200));
          for (var s = 0; s < pos.count; s += step) {
            var dx = pos.getX(s) - c.x;
            var dy = pos.getY(s) - c.y;
            var dz = pos.getZ(s) - c.z;
            var dot = dx * nrm.getX(s) + dy * nrm.getY(s) + dz * nrm.getZ(s);
            if (dot < 0) inward++;
            sampled++;
          }
          if (sampled > 0 && inward * 2 > sampled) {
            var idx = g.index;
            for (var t = 0; t + 2 < idx.count; t += 3) {
              var b = idx.getX(t + 1);
              idx.setX(t + 1, idx.getX(t + 2));
              idx.setX(t + 2, b);
            }
            idx.needsUpdate = true;
            g.computeVertexNormals();
          }
          var uvs = new Float32Array(pos.count * 2);
          var v = new THREE.Vector3();
          var TWO_PI = Math.PI * 2;
          for (var i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i).sub(c);
            var len = v.length();
            if (len > 0) v.multiplyScalar(1 / len);
            uvs[i * 2] = Math.atan2(v.z, v.x) / TWO_PI + 0.5;
            uvs[i * 2 + 1] = Math.asin(Math.max(-1, Math.min(1, v.y))) / Math.PI + 0.5;
          }
          g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
          node.geometry = g;
        });
        mesh.updateMatrixWorld(true);
        var box = new THREE.Box3().setFromObject(mesh);
        if (box.isEmpty()) return;
        var size = new THREE.Vector3();
        var center = new THREE.Vector3();
        box.getSize(size);
        box.getCenter(center);
        var scale = this.data.size / (Math.max(size.x, size.y, size.z) || 1);
        mesh.position.sub(center.multiplyScalar(scale));
        mesh.scale.setScalar(scale);
      }
    });
  }
<\/script>`;

/**
 * Iframe ↔ parent bridge: shader uniform readiness + camera persistence.
 *
 * - Shader uniforms: poll for the shaderloader's `_propertyUniforms` (it's
 *   populated asynchronously after fetch/import/extendSchema), announce
 *   readiness, listen for direct value updates. We mutate `.value` directly
 *   — going through setAttribute round-trips through A-Frame's component
 *   data layer for no benefit.
 *
 * - Camera persistence: if the parent passed a saved position, apply it
 *   AFTER orbit-controls initializes — and only after, so the controls'
 *   internal `position0` snapshot remains the original `0 0 8` and `reset()`
 *   snaps back to home, not to the saved view.
 *
 * `__SAVED_CAM__` is replaced with a JSON literal at emit time.
 */
const BRIDGE_SCRIPT_TEMPLATE = `<script>
  window.__savedCameraPos = __SAVED_CAM__;
  (function() {
    var entity = document.getElementById("preview-entity");
    var camEl = document.querySelector("[camera]");

    var shaderRetries = 0;
    function checkShaderReady() {
      var comp = entity && entity.components && entity.components.shader;
      if (comp && comp._propertyUniforms) {
        try {
          window.parent.postMessage({
            type: "fs:preview-ready",
            uniforms: Object.keys(comp._propertyUniforms)
          }, "*");
        } catch (e) {}
        return;
      }
      if (shaderRetries++ < 200) setTimeout(checkShaderReady, 50);
    }
    checkShaderReady();

    var camRetries = 0;
    function whenOrbitReady(cb) {
      var oc = camEl && camEl.components && camEl.components["orbit-controls"];
      if (oc && oc.controls) { cb(oc); return; }
      if (camRetries++ < 200) setTimeout(function() { whenOrbitReady(cb); }, 50);
    }
    whenOrbitReady(function(oc) {
      var saved = window.__savedCameraPos;
      if (saved && camEl && camEl.object3D) {
        camEl.object3D.position.set(saved.x, saved.y, saved.z);
        try { oc.controls.update(); } catch (e) {}
      }
      var lx = NaN, ly = NaN, lz = NaN;
      setInterval(function() {
        var p = camEl && camEl.object3D && camEl.object3D.position;
        if (!p) return;
        if (p.x === lx && p.y === ly && p.z === lz) return;
        lx = p.x; ly = p.y; lz = p.z;
        try {
          window.parent.postMessage({ type: "fs:camera", x: p.x, y: p.y, z: p.z }, "*");
        } catch (e) {}
      }, 200);
    });

    window.addEventListener("message", function(e) {
      var msg = e.data;
      if (!msg) return;
      if (msg.type === "fs:uniform") {
        var comp = entity && entity.components && entity.components.shader;
        if (!comp || !comp._propertyUniforms) return;
        var u = comp._propertyUniforms[msg.name];
        if (u) u.value = msg.value;
      } else if (msg.type === "fs:reset-camera") {
        var oc = camEl && camEl.components && camEl.components["orbit-controls"];
        if (oc && oc.controls && typeof oc.controls.reset === "function") {
          oc.controls.reset();
        }
      }
    });
  })();
<\/script>`;

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
  const isObj = isObjGeometry(geometry);
  const { iife, shaderloader, orbitControls } = getScriptUrls();

  // Plane spins on its Z axis (in-plane, like a record), since the flat face
  // is already pointed at the camera. Everything else spins on Y like a turntable.
  //
  // The spin lives on a *parent* entity wrapping the shaded entity (see scene
  // markup below). The parent has no tilt of its own, so its local Y/Z is the
  // world Y/Z, and the animation cleanly tweens 0→360 with no end-of-loop snap.
  // If we instead applied this animation to the same entity that holds the
  // static tilt (e.g. `45 45 0`), A-Frame would interpolate componentwise from
  // the current value (`45 45 0`) to `to: 0 360 0` — flattening the X tilt
  // over the loop and only spinning Y by 315° before snapping back. That snap
  // is what produced the visible jump on every full rotation.
  const animTo = geometry === 'plane' ? '0 0 360' : '0 360 0';
  const spinAttr = animate
    ? ` animation="property: rotation; from: 0 0 0; to: ${animTo}; loop: true; dur: 12000; easing: linear"`
    : '';

  // Plane is meant to be viewed flat-on, so leave it un-rotated (it already
  // faces +Z, which is where the camera sits). OBJ models are normalized and
  // recentered on load, so we tilt them like the other primitives. The bunny
  // is shown upright (no tilt) since its silhouette reads better head-on.
  let rotationAttr: string;
  if (geometry === 'plane') {
    rotationAttr = '0 0 0';
  } else if (geometry === 'bunny') {
    rotationAttr = '0 25 0';
  } else if (geometry === 'teapot') {
    rotationAttr = '15 35 0';
  } else {
    rotationAttr = '45 45 0';
  }

  // Build the per-geometry entity attribute(s).
  // - Primitives: A-Frame `geometry` component with subdivision baked in.
  // - OBJ models: A-Frame `obj-model` component pointing at public/models/*,
  //   plus a custom `fit-bounds` component (registered below) that recenters
  //   and rescales the loaded mesh into a unit-ish bounding box so the camera
  //   framing matches the primitives.
  let entityAttrs: string;
  if (isObj) {
    const url = getModelUrl(geometry as 'teapot' | 'bunny');
    entityAttrs = `obj-model="obj: url(${url})" fit-bounds="size: 1.6"`;
  } else {
    const geoAttr = buildGeoAttr(geometry as 'sphere' | 'cube' | 'plane', subdivision);
    entityAttrs = `geometry="${geoAttr}"`;
  }

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

  // Register the fit-bounds component used by OBJ-backed previews. Inert for
  // primitive geometries — the component is only attached to OBJ entities.
  lines.push(FIT_BOUNDS_SCRIPT);
  lines.push('');

  lines.push(`<a-scene vr-mode-ui="enabled: false" loading-screen="enabled: false" background="color: ${bgColor}">`);
  lines.push('  <a-entity camera="fov: 20; active: true" look-controls="enabled: false" orbit-controls="target: 0 0 0; minDistance: 2; maxDistance: 80; initialPosition: 0 0 8; rotateSpeed: 0.5"></a-entity>');
  // Parent holds the spin (so it tweens cleanly 0→360 on world Y/Z), child
  // holds the static tilt and the shader/geometry. The id stays on the child
  // because that's where the shader component lives (the bridge looks it up
  // by id), and `fit-bounds` needs the OBJ entity for `model-loaded`.
  lines.push(`  <a-entity${spinAttr}>`);
  lines.push(`    <a-entity id="preview-entity" ${entityAttrs} material="color: #808080" position="0 0 0" rotation="${rotationAttr}"></a-entity>`);
  lines.push('  </a-entity>');

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

  // Bridge: shader uniform overlay + camera persistence across iframe rebuilds.
  const savedCamLiteral = initialCameraPosition
    ? JSON.stringify({ x: initialCameraPosition.x, y: initialCameraPosition.y, z: initialCameraPosition.z })
    : 'null';
  lines.push(BRIDGE_SCRIPT_TEMPLATE.replace('__SAVED_CAM__', savedCamLiteral));
  lines.push('');

  lines.push('</body>');
  lines.push('</html>');
  lines.push('');

  return lines.join('\n');
}
