/**
 * Generates a self-contained HTML page that renders a TSL shader
 * using raw Three.js WebGPU (no A-Frame). Used for the in-app preview iframe.
 *
 * Uses three@0.183.0 from CDN to match the app's installed version,
 * so tsl-textures@3.0.0 (which needs three 0.182+) works correctly.
 */

export interface PreviewOptions {
  geometry?: 'sphere' | 'cube' | 'torus' | 'plane';
  animate?: boolean;
}

// CDN URLs — three@0.183.0 matches installed version
const THREE_WEBGPU_URL = 'https://cdn.jsdelivr.net/npm/three@0.183.0/build/three.webgpu.js';
const THREE_TSL_URL = 'https://cdn.jsdelivr.net/npm/three@0.183.0/build/three.tsl.js';
const TSL_TEXTURES_URL = 'https://cdn.jsdelivr.net/npm/tsl-textures@3.0.0/dist/tsl-textures.js';

const GEOMETRY_MAP: Record<string, string> = {
  sphere: 'new THREE.SphereGeometry(1, 64, 64)',
  box: 'new THREE.BoxGeometry(1.4, 1.4, 1.4)',
  torus: 'new THREE.TorusGeometry(0.7, 0.3, 64, 64)',
  plane: 'new THREE.PlaneGeometry(2, 2)',
};

export function tslToPreviewHTML(
  tslCode: string,
  options: PreviewOptions = {},
): string {
  const {
    geometry = 'sphere',
    animate = false,
  } = options;

  const geoKey = geometry === 'cube' ? 'box' : geometry;
  const threeGeometry = GEOMETRY_MAP[geoKey] ?? GEOMETRY_MAP.sphere;

  // 1. Collect imported names from 'three/tsl'
  const tslNames: string[] = [];
  const tslImportRe = /import\s*\{([^}]+)\}\s*from\s*['"]three\/tsl['"]/g;
  let m: RegExpExecArray | null;
  while ((m = tslImportRe.exec(tslCode)) !== null) {
    for (const name of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
      if (!tslNames.includes(name)) tslNames.push(name);
    }
  }

  // 2. Collect tsl-textures named imports
  const texNames: string[] = [];
  const texImportRe = /import\s*\{([^}]+)\}\s*from\s*['"]tsl-textures['"]/g;
  while ((m = texImportRe.exec(tslCode)) !== null) {
    texNames.push(...m[1].split(',').map(s => s.trim()).filter(Boolean));
  }

  // 3. Extract the Fn body
  const fnStart = tslCode.indexOf('Fn(() => {');
  const fnEnd = tslCode.lastIndexOf('});');
  let body = '';
  if (fnStart !== -1 && fnEnd !== -1) {
    body = tslCode.slice(fnStart + 'Fn(() => {'.length, fnEnd).trim();
  }
  if (!body) {
    body = 'return vec3(1, 0, 0);';
    if (!tslNames.includes('vec3')) tslNames.push('vec3');
  }

  const usesTslTextures = texNames.length > 0;

  // --- Fix TDZ (Temporal Dead Zone) issues in generated code ---
  // graphToCode generates `const X = X;` for input nodes and
  // `const color = color(...)` for type constructors, both of which
  // shadow the module-level import and cause TDZ errors.

  let processedBody = body;
  const importedNames = new Set(tslNames);

  // 1. Remove self-referencing bare declarations: `const X = X;`
  //    These are input nodes (positionGeometry, time, etc.) that are
  //    just aliasing the import — useless and cause TDZ.
  for (const name of importedNames) {
    const selfRefRe = new RegExp(
      `^[ \\t]*const\\s+${name}\\s*=\\s*${name}\\s*;[ \\t]*$`, 'gm'
    );
    processedBody = processedBody.replace(selfRefRe, '');
  }

  // 2. Rename local variables that shadow imported function names.
  //    e.g. `const color = color(0xff0000);` → `const _color = color(0xff0000);`
  //    We rename every word-boundary reference EXCEPT function-call sites (name followed by `(`).
  const declRe = /\bconst\s+(\w+)\s*=/g;
  const conflicting = new Set<string>();
  let dm: RegExpExecArray | null;
  while ((dm = declRe.exec(processedBody)) !== null) {
    if (importedNames.has(dm[1])) {
      conflicting.add(dm[1]);
    }
  }
  for (const name of conflicting) {
    // Replace variable references but NOT function calls (negative lookahead for `(`)
    processedBody = processedBody.replace(
      new RegExp(`\\b${name}\\b(?!\\s*\\()`, 'g'),
      `_${name}`,
    );
  }

  // 3. Fix bare numeric first-arg in MaterialX noise calls.
  //    graphToCode emits `mx_noise_float(0)` when no position is connected,
  //    but mx_noise_float expects a TSL node (defaults to uv() when omitted).
  //    Replace the bare `0` with nothing (let the default kick in) or with
  //    the remaining args preserved.
  processedBody = processedBody.replace(
    /\b(mx_\w+)\(\s*0\s*\)/g,
    '$1()',
  );
  processedBody = processedBody.replace(
    /\b(mx_\w+)\(\s*0\s*,/g,
    '$1(uv(),',
  );
  // Ensure uv is imported if we injected it
  if (processedBody.includes('uv(') && !tslNames.includes('uv')) {
    tslNames.push('uv');
  }

  // 4. Alias tsl-textures imports to avoid TDZ shadowing
  const texAliases = texNames.map(n => ({ original: n, alias: `_tex_${n}` }));
  for (const { original, alias } of texAliases) {
    processedBody = processedBody.replace(
      new RegExp(`\\b${original}\\s*\\(`, 'g'),
      `${alias}(`,
    );
  }

  // 4. Build HTML
  const lines: string[] = [];

  lines.push('<!DOCTYPE html>');
  lines.push('<html lang="en">');
  lines.push('<head>');
  lines.push('  <meta charset="UTF-8">');
  lines.push('  <style>');
  lines.push('    html, body { margin: 0; padding: 0; overflow: hidden; width: 100%; height: 100%; background: #1a1a2e; }');
  lines.push('    canvas { display: block; width: 100%; height: 100%; }');
  lines.push('    #error { position: absolute; top: 8px; left: 8px; right: 8px; color: #ff6b6b; font: 12px/1.4 monospace; white-space: pre-wrap; z-index: 10; }');
  lines.push('  </style>');

  // Import map for bare specifiers (used by tsl-textures internally)
  const importMap: Record<string, string> = {
    'three': THREE_WEBGPU_URL,
    'three/webgpu': THREE_WEBGPU_URL,
    'three/tsl': THREE_TSL_URL,
  };
  if (usesTslTextures) {
    importMap['tsl-textures'] = TSL_TEXTURES_URL;
  }
  lines.push('  <script type="importmap">');
  lines.push('  ' + JSON.stringify({ imports: importMap }, null, 4).split('\n').join('\n  '));
  lines.push('  </script>');

  lines.push('</head>');
  lines.push('<body>');
  lines.push('<div id="error"></div>');
  lines.push('');

  // Module script
  lines.push('<script type="module">');
  lines.push(`import * as THREE from '${THREE_WEBGPU_URL}';`);
  if (tslNames.length > 0) {
    lines.push(`import { ${tslNames.join(', ')} } from '${THREE_TSL_URL}';`);
  }
  if (usesTslTextures) {
    const importSpecifiers = texAliases.map(t => `${t.original} as ${t.alias}`).join(', ');
    lines.push(`import { ${importSpecifiers} } from '${TSL_TEXTURES_URL}';`);
  }
  lines.push('');

  lines.push('const errEl = document.getElementById("error");');
  lines.push('');
  lines.push('(async () => {');
  lines.push('try {');
  lines.push('');

  // Parse body: separate node definitions from the return statement.
  // Return can be simple (`return noise;`) or multi-channel (`return { color: noise, emissive: myColor };`).
  const CHANNEL_TO_PROP: Record<string, string> = {
    color: 'colorNode',
    emissive: 'emissiveNode',
    normal: 'normalNode',
    position: 'positionNode',
    opacity: 'opacityNode',
    roughness: 'roughnessNode',
  };

  const defLines: string[] = [];
  const channels: Record<string, string> = {};

  for (const rawLine of processedBody.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const objReturn = trimmed.match(/^return\s*\{(.+)\}\s*;?$/);
    const simpleReturn = trimmed.match(/^return\s+(.+);$/);

    if (objReturn) {
      // Multi-channel: return { color: noise, emissive: myColor };
      for (const prop of objReturn[1].split(',')) {
        const colonIdx = prop.indexOf(':');
        if (colonIdx !== -1) {
          const key = prop.slice(0, colonIdx).trim();
          const val = prop.slice(colonIdx + 1).trim();
          if (key && val) channels[key] = val;
        }
      }
    } else if (simpleReturn) {
      // Single channel: return noise;
      channels['color'] = simpleReturn[1].trim();
    } else {
      defLines.push(rawLine);
    }
  }

  // Fallback: default red
  if (Object.keys(channels).length === 0) {
    channels['color'] = 'vec3(1, 0, 0)';
    if (!tslNames.includes('vec3')) tslNames.push('vec3');
  }

  // Emit node definitions (no Fn wrapper — direct TSL nodes work for material assignment)
  for (const line of defLines) {
    lines.push('  ' + line.trimStart());
  }
  lines.push('');

  // Renderer setup — must await init() for WebGPU device
  lines.push('  const renderer = new THREE.WebGPURenderer({ antialias: true });');
  lines.push('  await renderer.init();');
  lines.push('  renderer.setPixelRatio(window.devicePixelRatio);');
  lines.push('  renderer.setSize(window.innerWidth, window.innerHeight);');
  lines.push('  document.body.appendChild(renderer.domElement);');
  lines.push('');

  // Scene
  lines.push('  const scene = new THREE.Scene();');
  lines.push('  scene.background = new THREE.Color(0x1a1a2e);');
  lines.push('');

  // Camera
  lines.push('  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);');
  lines.push('  camera.position.set(0, 0, 3.5);');
  lines.push('  camera.lookAt(0, 0, 0);');
  lines.push('');

  // Lights
  lines.push('  const dirLight = new THREE.DirectionalLight(0xffffff, 1);');
  lines.push('  dirLight.position.set(1, 2, 1);');
  lines.push('  scene.add(dirLight);');
  lines.push('  scene.add(new THREE.AmbientLight(0xffffff, 0.4));');
  lines.push('');

  // Mesh with node material — assign each channel
  lines.push('  const material = new THREE.MeshPhysicalNodeMaterial();');
  for (const [ch, ref] of Object.entries(channels)) {
    const prop = CHANNEL_TO_PROP[ch];
    if (prop) {
      lines.push(`  material.${prop} = ${ref};`);
    }
  }
  lines.push(`  const geometry = ${threeGeometry};`);
  lines.push('  const mesh = new THREE.Mesh(geometry, material);');
  lines.push('  scene.add(mesh);');
  lines.push('');

  // Animation loop
  if (animate) {
    lines.push('  renderer.setAnimationLoop(() => {');
    lines.push('    mesh.rotation.y += 0.005;');
    lines.push('    renderer.renderAsync(scene, camera);');
    lines.push('  });');
  } else {
    lines.push('  renderer.setAnimationLoop(() => {');
    lines.push('    renderer.renderAsync(scene, camera);');
    lines.push('  });');
  }
  lines.push('');

  // Resize handler
  lines.push('  window.addEventListener("resize", () => {');
  lines.push('    camera.aspect = window.innerWidth / window.innerHeight;');
  lines.push('    camera.updateProjectionMatrix();');
  lines.push('    renderer.setSize(window.innerWidth, window.innerHeight);');
  lines.push('  });');
  lines.push('');

  lines.push('} catch (e) {');
  lines.push('  console.error("[FastShaders Preview]", e);');
  lines.push('  if (errEl) errEl.textContent = String(e);');
  lines.push('}');
  lines.push('})();');

  lines.push('</script>');
  lines.push('');
  lines.push('</body>');
  lines.push('</html>');
  lines.push('');

  return lines.join('\n');
}
