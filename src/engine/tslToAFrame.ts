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

export interface AFrameOptions {
  /** A-Frame geometry primitive (default: 'sphere') */
  geometry?: 'sphere' | 'cube' | 'torus' | 'plane';
  /** Embedded mode — hides VR button, minimal styling (for preview iframe) */
  embedded?: boolean;
  /** Add slow rotation animation to the entity */
  animate?: boolean;
}

// IIFE bundle from the a-frame-shaderloader project — includes A-Frame 1.7,
// Three.js WebGPU build, and tsl-textures with matching compatible versions.
const IIFE_BUNDLE_URL =
  'https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js/aframe-171-a-0.1.min.js';

// Three.js geometry constructors per primitive type
const GEOMETRY_MAP: Record<string, string> = {
  sphere: 'new THREE.SphereGeometry(1, 64, 64)',
  box: 'new THREE.BoxGeometry(1.4, 1.4, 1.4)',
  torus: 'new THREE.TorusGeometry(0.7, 0.3, 64, 64)',
  plane: 'new THREE.PlaneGeometry(2, 2)',
};

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

  // 1. Collect imported names from 'three/tsl'
  const tslNames: string[] = [];
  const tslImportRe = /import\s*\{([^}]+)\}\s*from\s*['"]three\/tsl['"]/g;
  let m: RegExpExecArray | null;
  while ((m = tslImportRe.exec(tslCode)) !== null) {
    for (const name of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
      if (name !== 'Fn' && !tslNames.includes(name)) tslNames.push(name);
    }
  }

  // 2. Collect tsl-textures named imports
  const texNames: string[] = [];
  const texImportRe = /import\s*\{([^}]+)\}\s*from\s*['"]tsl-textures['"]/g;
  while ((m = texImportRe.exec(tslCode)) !== null) {
    texNames.push(...m[1].split(',').map(s => s.trim()).filter(Boolean));
  }

  // 3. Extract the Fn body (everything between `Fn(() => {` and `});`)
  const fnStart = tslCode.indexOf('Fn(() => {');
  const fnEnd = tslCode.lastIndexOf('});');
  let body = '';
  if (fnStart !== -1 && fnEnd !== -1) {
    body = tslCode.slice(fnStart + 'Fn(() => {'.length, fnEnd).trim();
  }
  // Fallback: if no Fn body found, return a default red color
  if (!body) {
    body = 'return vec3(1, 0, 0);';
    if (!tslNames.includes('vec3')) tslNames.push('vec3');
  }

  // --- Fix TDZ (Temporal Dead Zone) issues in generated code ---
  let processedBody = body;
  const importedNames = new Set(tslNames);

  // 1. Remove self-referencing bare declarations: `const X = X;`
  for (const name of importedNames) {
    const selfRefRe = new RegExp(
      `^[ \\t]*const\\s+${name}\\s*=\\s*${name}\\s*;[ \\t]*$`, 'gm'
    );
    processedBody = processedBody.replace(selfRefRe, '');
  }

  // 2. Rename local variables that shadow imported function names
  const declRe = /\bconst\s+(\w+)\s*=/g;
  const conflicting = new Set<string>();
  let dm: RegExpExecArray | null;
  while ((dm = declRe.exec(processedBody)) !== null) {
    if (importedNames.has(dm[1])) {
      conflicting.add(dm[1]);
    }
  }
  for (const name of conflicting) {
    processedBody = processedBody.replace(
      new RegExp(`\\b${name}\\b(?!\\s*\\()`, 'g'),
      `_${name}`,
    );
  }

  // 3. Fix bare numeric first-arg in MaterialX noise calls.
  processedBody = processedBody.replace(
    /\b(mx_\w+)\(\s*0\s*\)/g,
    '$1()',
  );
  processedBody = processedBody.replace(
    /\b(mx_\w+)\(\s*0\s*,/g,
    '$1(uv(),',
  );
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

  // 5. Parse body: separate definitions from the return statement
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
      for (const prop of objReturn[1].split(',')) {
        const colonIdx = prop.indexOf(':');
        if (colonIdx !== -1) {
          const key = prop.slice(0, colonIdx).trim();
          const val = prop.slice(colonIdx + 1).trim();
          if (key && val) channels[key] = val;
        }
      }
    } else if (simpleReturn) {
      channels['color'] = simpleReturn[1].trim();
    } else {
      defLines.push(rawLine);
    }
  }

  if (Object.keys(channels).length === 0) {
    channels['color'] = 'vec3(1, 0, 0)';
    if (!tslNames.includes('vec3')) tslNames.push('vec3');
  }

  // 6. Build the full HTML document
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
      lines.push(`      material.${prop} = ${ref};`);
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
