/* global AFRAME, THREE */

AFRAME.registerComponent('shader', {
  schema: {
    src: { type: "string" }
  },
  init: function() {
    this.applyShader = this.applyShader.bind(this);
    this.originalMaterials = {};
    this._shaderMaterial = null;
    this._currentSrc = null;

    this.el.addEventListener('model-loaded', this.applyShader);
  },
  update: function(oldData) {
    if (oldData.src === this.data.src) { return; }
    const mesh = this.el.getObject3D('mesh');
    if (mesh) {
      this.applyShader();
    }
  },
  applyShader: function() {
    const mesh = this.el.getObject3D('mesh');
    if (!mesh) { return; }

    this.storeOriginalMaterials(mesh);

    if (this.data.src) {
      this.applyTSLShader(mesh);
    }
  },
  applyTSLShader: async function(mesh) {
    const tslPath = this.data.src;
    this._currentSrc = tslPath;

    try {
      const modulePath = tslPath.startsWith('./') || tslPath.startsWith('/') || tslPath.includes('://')
        ? tslPath
        : './' + tslPath;

      // Fetch source, fix variable shadowing, resolve imports, import via blob
      const response = await fetch(modulePath);
      if (!response.ok) { throw new Error(`HTTP ${response.status} loading ${modulePath}`); }
      let source = await response.text();

      source = autoInjectTSLImports(source);
      source = fixTSLShadowing(source);
      source = resolveTSLImports(source, new URL(modulePath, location.href).href);

      const blob = new Blob([source], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      let module;
      try {
        module = await import(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }

      if (this._currentSrc !== tslPath) { return; }

      const shaderExport = module.default;
      const shaderResult = typeof shaderExport === 'function' ? shaderExport() : shaderExport;

      const material = new THREE.MeshPhysicalNodeMaterial();

      if (shaderResult && shaderResult.colorNode !== undefined) {
        // Object API: { colorNode, positionNode, opacityNode, normalNode, ... }
        const nodeProps = [
          'colorNode', 'positionNode', 'normalNode', 'opacityNode',
          'roughnessNode', 'metalnessNode', 'emissiveNode'
        ];
        for (const prop of nodeProps) {
          if (shaderResult[prop] !== undefined) {
            material[prop] = shaderResult[prop];
          }
        }
        if (shaderResult.transparent !== undefined) {
          material.transparent = shaderResult.transparent;
        }
        if (shaderResult.side !== undefined) {
          material.side = shaderResult.side;
        }
      } else {
        // Simple API: return a single node (backward compatible)
        material.colorNode = shaderResult;
      }

      this.disposeShaderMaterial();
      this._shaderMaterial = material;
      this.applyMaterialToMesh(mesh, material);
    } catch (err) {
      console.error(`Failed to load TSL shader from ${tslPath}`, err);
      this.restoreOriginalMaterials(mesh);
    }
  },
  storeOriginalMaterials: function(mesh) {
    mesh.traverse((node) => {
      if (node.isMesh && !(node.uuid in this.originalMaterials)) {
        this.originalMaterials[node.uuid] = node.material;
      }
    });
  },
  applyMaterialToMesh: function(mesh, material) {
    mesh.traverse((node) => {
      if (node.isMesh) {
        node.material = material;
      }
    });
  },
  disposeShaderMaterial: function() {
    if (this._shaderMaterial) {
      this._shaderMaterial.dispose();
      this._shaderMaterial = null;
    }
  },
  remove: function() {
    this._currentSrc = null;
    const mesh = this.el.getObject3D('mesh');
    if (mesh) {
      this.restoreOriginalMaterials(mesh);
    }
    this.disposeShaderMaterial();
    this.el.removeEventListener('model-loaded', this.applyShader);
  },
  restoreOriginalMaterials: function(mesh) {
    mesh.traverse((node) => {
      if (node.isMesh && this.originalMaterials[node.uuid]) {
        node.material = this.originalMaterials[node.uuid];
      }
    });
  }
});


// Auto-detect and inject missing TSL imports. Generated TSL code may use
// functions like uv() without importing them. This scans the source for
// function calls that aren't imported or locally declared, and adds them
// to the existing three/tsl import statement. Only injects names that
// actually exist in THREE.TSL to avoid injecting non-existent symbols.
function autoInjectTSLImports(source) {
  const tslImportRegex = /(import\s*\{)([^}]+)(\}\s*from\s*['"]three\/tsl['"])/;
  const match = source.match(tslImportRegex);
  if (!match) { return source; }

  const importedNames = new Set(
    match[2].split(',').map(n => n.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean)
  );

  const localDecls = new Set();
  const declRegex = /\b(?:const|let|var)\s+(\w+)\s*=/g;
  let dm;
  while ((dm = declRegex.exec(source)) !== null) { localDecls.add(dm[1]); }
  const fnDeclRegex = /\bfunction\s+(\w+)\s*\(/g;
  while ((dm = fnDeclRegex.exec(source)) !== null) { localDecls.add(dm[1]); }

  const bodyLines = source.split('\n').filter(l => !/^\s*(import|export)\s/.test(l));
  // Strip comments so patterns like "// glow (effect)" don't trigger false matches
  const body = bodyLines.map(l => l.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')).join('\n');

  // Detect function calls: name(
  const callRegex = /(?<![.\w])([a-zA-Z_$]\w*)\s*\(/g;
  const usedCalls = new Set();
  let cm;
  while ((cm = callRegex.exec(body)) !== null) { usedCalls.add(cm[1]); }

  // Also detect bare identifiers (e.g. positionGeometry, normalLocal, time)
  // that are used as values, not function calls
  const identRegex = /(?<![.\w])([a-zA-Z_$]\w*)(?!\s*\()/g;
  while ((cm = identRegex.exec(body)) !== null) { usedCalls.add(cm[1]); }

  const exclude = new Set([
    ...importedNames,
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
    'do', 'switch', 'case', 'break', 'continue', 'new', 'typeof', 'instanceof',
    'void', 'delete', 'throw', 'try', 'catch', 'finally', 'class', 'extends',
    'super', 'import', 'export', 'default', 'from', 'async', 'await', 'yield',
    'of', 'in', 'true', 'false', 'null', 'undefined', 'this', 'arguments',
    'console', 'window', 'document', 'Math', 'JSON', 'Array', 'Object', 'String',
    'Number', 'Boolean', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError',
    'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Proxy', 'Reflect',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'setTimeout', 'setInterval',
    'clearTimeout', 'clearInterval', 'fetch', 'URL', 'requestAnimationFrame',
    'THREE', 'AFRAME'
  ]);

  // Validate against actual TSL exports to avoid injecting non-existent symbols
  const tslExports = (window.THREE && window.THREE.TSL) ? window.THREE.TSL : null;

  const missing = [];
  for (const name of usedCalls) {
    if (!exclude.has(name) && !localDecls.has(name)) {
      if (!tslExports || (name in tslExports)) {
        missing.push(name);
      }
    }
  }

  if (missing.length === 0) { return source; }

  console.log('shaderloader: auto-injecting missing TSL imports:', missing.join(', '));
  const currentImports = match[2].trimEnd();
  const newImportList = currentImports + ', ' + missing.join(', ');
  return source.replace(tslImportRegex, '$1' + newImportList + '$3');
}

// TSL shader preprocessing: fixes variable shadowing in generated code.
// Generated TSL code often has patterns like `const color = color(0x14f55b)`
// where the local `const` declaration shadows the imported function, causing
// a ReferenceError due to the temporal dead zone. This function renames
// shadowed locals (e.g. `const __color = color(0x14f55b)`) so the import
// remains accessible on the RHS while subsequent value references use the local.
function fixTSLShadowing(source) {
  const importedNames = new Set();
  const importRegex = /import\s*\{([^}]+)\}\s*from/g;
  let m;
  while ((m = importRegex.exec(source)) !== null) {
    m[1].split(',').forEach(n => {
      const name = n.trim().split(/\s+as\s+/)[0].trim();
      if (name) { importedNames.add(name); }
    });
  }

  if (importedNames.size === 0) { return source; }

  const lines = source.split('\n');
  const renames = new Map();

  const fixedLines = lines.map(line => {
    // Don't touch import/export declaration lines
    if (/^\s*import\s/.test(line) || /^\s*export\s/.test(line)) { return line; }

    let out = line;

    // Apply accumulated renames: replace value references (not function calls)
    for (const [orig, renamed] of renames) {
      out = out.replace(new RegExp('\\b' + orig + '\\b(?!\\s*\\()', 'g'), renamed);
    }

    // Detect new shadowing declaration: const NAME = ... where NAME is an import
    const declMatch = out.match(/^\s*const\s+(\w+)\s*=/);
    if (declMatch && importedNames.has(declMatch[1])) {
      const name = declMatch[1];
      const safe = '__' + name;
      out = out.replace(new RegExp('^(\\s*const\\s+)' + name + '(\\s*=)'), '$1' + safe + '$2');
      renames.set(name, safe);
    }

    return out;
  });

  return fixedLines.join('\n');
}

// Built-in specifier map so TSL shaders resolve without a page-level import map.
// Local shims re-export from window.THREE (set by the IIFE bundle), so all code
// shares a single Three.js instance. Absolute URLs are computed at load time so
// blob-loaded modules can resolve them.
var _scriptDir = (document.currentScript && document.currentScript.src) || '';
var _baseDir = _scriptDir ? _scriptDir.substring(0, _scriptDir.lastIndexOf('/') + 1) : '';
const specifierMap = {
  'three':         _baseDir + 'three-shim.js',
  'three/webgpu':  _baseDir + 'three-shim.js',
  'three/tsl':     _baseDir + 'three-tsl-shim.js',
  'tsl-textures':  _baseDir + 'tsl-textures-shim.js'
};

// Resolve a bare specifier using the built-in map.
// Handles exact matches and prefix matches (keys ending with '/').
function resolveSpecifier(specifier) {
  if (specifier in specifierMap) { return specifierMap[specifier]; }
  for (const key in specifierMap) {
    if (key.endsWith('/') && specifier.startsWith(key)) {
      return specifierMap[key] + specifier.slice(key.length);
    }
  }
  return null;
}

// Resolve bare import specifiers (e.g. 'three/tsl', 'tsl-textures') to full
// URLs so the module can be loaded from a Blob URL where import maps don't apply.
function resolveTSLImports(source, baseUrl) {
  return source.replace(
    /from\s+(['"])([^'"]+)\1/g,
    function(match, quote, specifier) {
      // Bare specifiers (no ./ or / or :// prefix) — resolve via built-in map
      if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes('://')) {
        var resolved = resolveSpecifier(specifier);
        if (resolved) { return 'from ' + quote + resolved + quote; }
        return match;
      }
      // Relative specifiers — resolve against the original file's URL
      if (baseUrl && (specifier.startsWith('./') || specifier.startsWith('../'))) {
        var abs = new URL(specifier, baseUrl).href;
        return 'from ' + quote + abs + quote;
      }
      return match;
    }
  );
}
