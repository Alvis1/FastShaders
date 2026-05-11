/* ShaderCarousel Shader Loader
 *
 * Based on FastShaders a-frame-shaderloader — same preprocessing pipeline:
 * - TDZ fix (fixTSLShadowing)
 * - Auto-import injection (autoInjectTSLImports)
 * - Bare specifier resolution (resolveTSLImports)
 * - Object API support (colorNode, positionNode, normalNode, etc.)
 *
 * Extended for tsl-textures compatibility:
 * - Named export fallback (export { marble } pattern)
 * - Automatic kebab-to-camel name resolution
 */

/* global AFRAME, THREE */

AFRAME.registerComponent("tsl-shader", {
  schema: {
    src: { type: "string" },
    // 'front' (default), 'back' (inverted normals — viewer is inside), 'double'
    side: { type: "string", default: "front" },
  },
  init: function () {
    this.applyShader = this.applyShader.bind(this);
    this.originalMaterials = {};
    this._shaderMaterial = null;
    this._currentSrc = null;

    this.el.addEventListener("model-loaded", this.applyShader);
  },
  update: function (oldData) {
    if (oldData.src !== this.data.src || oldData.side !== this.data.side) {
      const mesh = this.el.getObject3D("mesh");
      if (mesh) {
        this.applyShader();
      }
    }
  },
  applyShader: function () {
    const mesh = this.el.getObject3D("mesh");
    if (!mesh) {
      return;
    }

    this.storeOriginalMaterials(mesh);

    if (this.data.src) {
      this.applyTSLShader(mesh);
    }
  },
  applyTSLShader: async function (mesh) {
    const tslPath = this.data.src;
    this._currentSrc = tslPath;

    try {
      const modulePath =
        tslPath.startsWith("./") ||
        tslPath.startsWith("/") ||
        tslPath.includes("://")
          ? tslPath
          : "./" + tslPath;

      // Fetch source, fix variable shadowing, resolve imports, import via blob
      const response = await fetch(modulePath);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} loading ${modulePath}`);
      }
      let source = await response.text();

      source = autoInjectTSLImports(source);
      source = fixTSLShadowing(source);
      source = resolveTSLImports(
        source,
        new URL(modulePath, location.href).href,
      );

      const blob = new Blob([source], { type: "application/javascript" });
      const blobUrl = URL.createObjectURL(blob);
      let module;
      try {
        module = await import(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }

      if (this._currentSrc !== tslPath) {
        return;
      }

      // Resolve shader export: default export (FastShaders) or named export (tsl-textures)
      let shaderExport = module.default;
      if (!shaderExport) {
        // Try kebab-to-camel of filename (e.g., "tiger-fur.js" → "tigerFur")
        const filename = tslPath.split("/").pop().replace(".js", "");
        const camelName = filename.replace(/-([a-z])/g, function (_, c) {
          return c.toUpperCase();
        });
        if (module[camelName]) {
          shaderExport = module[camelName];
        } else {
          // Fall back to first callable export
          for (const key of Object.keys(module)) {
            if (key !== "schema" && key !== "default" && typeof module[key] === "function") {
              shaderExport = module[key];
              break;
            }
          }
        }
      }

      // tsl-textures shaders handle their own defaults via prepare(params, defaults),
      // so we just pass an empty object. No schema extension needed.
      const uniforms = {};

      // Always pass uniforms to functions that accept parameters
      const shaderResult =
        typeof shaderExport === "function"
          ? shaderExport.length > 0
            ? shaderExport(uniforms)
            : shaderExport()
          : shaderExport;

      const material = new THREE.MeshPhysicalNodeMaterial();

      const nodeProps = [
        "colorNode",
        "positionNode",
        "normalNode",
        "opacityNode",
        "roughnessNode",
        "metalnessNode",
        "emissiveNode",
      ];
      const isObjectAPI =
        shaderResult &&
        typeof shaderResult === "object" &&
        nodeProps.some(function (p) {
          return shaderResult[p] !== undefined;
        });

      if (isObjectAPI) {
        // Object API: { colorNode, positionNode, opacityNode, normalNode, ... }
        for (const prop of nodeProps) {
          if (shaderResult[prop] !== undefined) {
            material[prop] = shaderResult[prop];
          }
        }
        if (shaderResult.emissiveNode !== undefined && shaderResult.colorNode === undefined) {
          material.colorNode = shaderResult.emissiveNode;
        }
        if (shaderResult.transparent !== undefined) {
          material.transparent = shaderResult.transparent;
        }
        if (shaderResult.side !== undefined) {
          material.side = shaderResult.side;
        }
        if (shaderResult.alphaTest !== undefined) {
          material.alphaTest = shaderResult.alphaTest;
        }
      } else {
        // Simple API: return a single node (backward compatible)
        material.colorNode = shaderResult;
      }

      // Component-level side override (only applied when shader didn't set one)
      if (!isObjectAPI || shaderResult.side === undefined) {
        if (this.data.side === "back") {
          material.side = THREE.BackSide;
        } else if (this.data.side === "double") {
          material.side = THREE.DoubleSide;
        }
      }

      this.disposeShaderMaterial();
      this._shaderMaterial = material;
      this.applyMaterialToMesh(mesh, material);
    } catch (err) {
      console.error(`Failed to load TSL shader from ${tslPath}`, err);
      this.restoreOriginalMaterials(mesh);
    }
  },
  storeOriginalMaterials: function (mesh) {
    mesh.traverse((node) => {
      if (node.isMesh && !(node.uuid in this.originalMaterials)) {
        this.originalMaterials[node.uuid] = node.material;
      }
    });
  },
  applyMaterialToMesh: function (mesh, material) {
    mesh.traverse((node) => {
      if (node.isMesh) {
        node.material = material;
      }
    });
  },
  disposeShaderMaterial: function () {
    if (this._shaderMaterial) {
      this._shaderMaterial.dispose();
      this._shaderMaterial = null;
    }
  },
  remove: function () {
    this._currentSrc = null;
    const mesh = this.el.getObject3D("mesh");
    if (mesh) {
      this.restoreOriginalMaterials(mesh);
    }
    this.disposeShaderMaterial();
    this.el.removeEventListener("model-loaded", this.applyShader);
  },
  restoreOriginalMaterials: function (mesh) {
    mesh.traverse((node) => {
      if (node.isMesh && this.originalMaterials[node.uuid]) {
        node.material = this.originalMaterials[node.uuid];
      }
    });
  },
});

// Auto-detect and inject missing TSL imports.
function autoInjectTSLImports(source) {
  const tslImportRegex = /(import\s*\{)([^}]+)(\}\s*from\s*['"]three\/tsl['"])/;
  const match = source.match(tslImportRegex);
  if (!match) {
    return source;
  }

  const importedNames = new Set(
    match[2]
      .split(",")
      .map((n) =>
        n
          .trim()
          .split(/\s+as\s+/)
          .pop()
          .trim(),
      )
      .filter(Boolean),
  );

  const localDecls = new Set();
  const declRegex = /\b(?:const|let|var)\s+(\w+)\s*=/g;
  let dm;
  while ((dm = declRegex.exec(source)) !== null) {
    localDecls.add(dm[1]);
  }
  const fnDeclRegex = /\bfunction\s+(\w+)\s*\(/g;
  while ((dm = fnDeclRegex.exec(source)) !== null) {
    localDecls.add(dm[1]);
  }

  const bodyLines = source
    .split("\n")
    .filter((l) => !/^\s*(import|export)\s/.test(l));
  // Strip comments: first remove multi-line block comments (which may span
  // multiple lines), then handle single-line comments per line.
  const bodyJoined = bodyLines.join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
  const body = bodyJoined
    .split("\n")
    .map((l) => {
      const masked = l.replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, (m) => " ".repeat(m.length));
      const lineComment = masked.indexOf("//");
      if (lineComment >= 0) {
        return l.slice(0, lineComment);
      }
      return l;
    })
    .join("\n");

  const callRegex = /(?<![.\w])([a-zA-Z_$]\w*)\s*\(/g;
  const usedCalls = new Set();
  let cm;
  while ((cm = callRegex.exec(body)) !== null) {
    usedCalls.add(cm[1]);
  }

  const identRegex = /(?<![.\w])([a-zA-Z_$]\w*)(?!\s*\()/g;
  while ((cm = identRegex.exec(body)) !== null) {
    usedCalls.add(cm[1]);
  }

  const exclude = new Set([
    ...importedNames,
    "const", "let", "var", "function", "return", "if", "else", "for", "while",
    "do", "switch", "case", "break", "continue", "new", "typeof", "instanceof",
    "void", "delete", "throw", "try", "catch", "finally", "class", "extends",
    "super", "import", "export", "default", "from", "async", "await", "yield",
    "of", "in", "true", "false", "null", "undefined", "this", "arguments",
    "console", "window", "document", "Math", "JSON", "Array", "Object",
    "String", "Number", "Boolean", "Date", "RegExp", "Error", "TypeError",
    "RangeError", "Promise", "Map", "Set", "WeakMap", "WeakSet", "Symbol",
    "Proxy", "Reflect", "parseInt", "parseFloat", "isNaN", "isFinite",
    "setTimeout", "setInterval", "clearTimeout", "clearInterval", "fetch",
    "URL", "requestAnimationFrame", "THREE", "AFRAME", "params",
  ]);

  const tslExports = window.THREE && window.THREE.TSL ? window.THREE.TSL : null;

  const missing = [];
  for (const name of usedCalls) {
    if (!exclude.has(name) && !localDecls.has(name)) {
      if (!tslExports || name in tslExports) {
        missing.push(name);
      }
    }
  }

  if (missing.length === 0) {
    return source;
  }

  const currentImports = match[2].trimEnd();
  const newImportList = currentImports + ", " + missing.join(", ");
  return source.replace(tslImportRegex, "$1" + newImportList + "$3");
}

// TSL shader preprocessing: fixes variable shadowing (TDZ issues) in generated code.
function fixTSLShadowing(source) {
  const importedNames = new Set();
  const importRegex = /import\s*\{([^}]+)\}\s*from/g;
  let m;
  while ((m = importRegex.exec(source)) !== null) {
    m[1].split(",").forEach((n) => {
      const name = n
        .trim()
        .split(/\s+as\s+/)[0]
        .trim();
      if (name) {
        importedNames.add(name);
      }
    });
  }

  if (importedNames.size === 0) {
    return source;
  }

  const lines = source.split("\n");
  const renames = new Map();

  const fixedLines = lines.map((line) => {
    if (/^\s*import\s/.test(line) || /^\s*export\s/.test(line)) {
      return line;
    }

    let out = line;

    for (const [orig, renamed] of renames) {
      out = out.replace(
        new RegExp("(?<!\\.)\\b" + orig + "\\b(?!\\s*[\\(:])", "g"),
        renamed,
      );
    }

    const declMatch = out.match(/^\s*const\s+(\w+)\s*=/);
    if (declMatch && importedNames.has(declMatch[1])) {
      const name = declMatch[1];
      const safe = "__" + name;
      out = out.replace(
        new RegExp("^(\\s*const\\s+)" + name + "(\\s*=)"),
        "$1" + safe + "$2",
      );
      renames.set(name, safe);
    }

    return out;
  });

  return fixedLines.join("\n");
}

// Built-in specifier map — resolves bare imports in blob-loaded modules.
// Points to the tsl-shim.js which re-exports from window.THREE / THREE.TSL.
const _scriptDir = (document.currentScript && document.currentScript.src) || "";
const _baseDir = _scriptDir
  ? _scriptDir.substring(0, _scriptDir.lastIndexOf("/") + 1)
  : new URL("./", location.href).href;
const _shimUrl = _baseDir + "tsl-shim.js";
const specifierMap = {
  "three": _shimUrl,
  "three/webgpu": _shimUrl,
  "three/tsl": _shimUrl,
  "tsl-textures": _shimUrl,
};

function resolveSpecifier(specifier) {
  if (specifier in specifierMap) {
    return specifierMap[specifier];
  }
  for (const key in specifierMap) {
    if (key.endsWith("/") && specifier.startsWith(key)) {
      return specifierMap[key] + specifier.slice(key.length);
    }
  }
  return null;
}

// Resolve bare import specifiers to full URLs for blob-loaded modules.
function resolveTSLImports(source, baseUrl) {
  return source.replace(
    /from\s+(['"])([^'"]+)\1/g,
    function (match, quote, specifier) {
      if (
        !specifier.startsWith(".") &&
        !specifier.startsWith("/") &&
        !specifier.includes("://")
      ) {
        const resolved = resolveSpecifier(specifier);
        if (resolved) {
          return "from " + quote + resolved + quote;
        }
        return match;
      }
      if (
        baseUrl &&
        (specifier.startsWith("./") || specifier.startsWith("../"))
      ) {
        const abs = new URL(specifier, baseUrl).href;
        return "from " + quote + abs + quote;
      }
      return match;
    },
  );
}
