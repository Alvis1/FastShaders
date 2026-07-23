/*
 * a-frame-shaderloader 0.5
 *
 * 0.5: typed schema entries — number/color/map. Schema entries dispatch on
 *      `def.type`: 'number' (float uniform, the 0.4 behavior and the default),
 *      'color' (THREE.Color uniform; also auto-detected from
 *      `const NAME = uniform(color(0xRRGGBB))`), and 'map' (TSL texture node
 *      seeded with an SRGB-pinned 1×1 white placeholder, resolved via
 *      A-Frame's material.loadTexture — '#id' selector or URL).
 */
/* global AFRAME, THREE */

AFRAME.registerComponent("shader", {
  schema: {
    src: { type: "string" },
  },
  init: function () {
    this.applyShader = this.applyShader.bind(this);
    this.originalMaterials = {};
    this._shaderMaterial = null;
    this._currentSrc = null;
    this._extending = false;

    this.el.addEventListener("model-loaded", this.applyShader);
  },
  update: function (oldData) {
    if (oldData.src !== this.data.src) {
      if (!this._extending) {
        const mesh = this.el.getObject3D("mesh");
        if (mesh) {
          this.applyShader();
        }
      }
      return;
    }
    // Handle property uniform changes (after schema has been extended).
    // For maps this.data[name] may be a DOM element — the identity compare
    // (!==) handles that; _applyUniformValue dispatches on the uniform kind.
    if (this._propertyUniforms) {
      for (const name in this._propertyUniforms) {
        if (
          this.data[name] !== undefined &&
          this.data[name] !== oldData[name]
        ) {
          this._applyUniformValue(name, this.data[name]);
        }
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
      // Treat `blob:` and `data:` URLs as absolute. When the preview iframe
      // is sandboxed without `allow-same-origin` its origin is opaque, so
      // blob URLs minted inside it look like `blob:null/<uuid>` — the
      // `://` heuristic below misses that form and the loader would
      // wrongly prefix `./`, producing an unparseable URL.
      const modulePath =
        tslPath.startsWith("./") ||
        tslPath.startsWith("/") ||
        tslPath.includes("://") ||
        tslPath.startsWith("blob:") ||
        tslPath.startsWith("data:")
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
      // Rewrite bare three/three-tsl imports into reads of the single global
      // THREE the A-Frame IIFE installed (no shim file / import map needed).
      source = globalizeBareImports(source);
      // Resolve any remaining relative imports against the module's own URL.
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

      const shaderExport = module.default;

      // Read schema for property uniforms and create TSL uniform nodes.
      // If no explicit schema is exported, auto-detect params.XXX usage
      // in the source code so hand-written modules work without boilerplate.
      let schema = module.schema;
      if (!schema || Object.keys(schema).length === 0) {
        schema = autoDetectSchema(source);
      }
      // 0.5: dispatch on the entry's declared type — 'number' (default),
      // 'color', or 'map' — instead of making every entry a float uniform.
      const uniforms = {};
      for (const [name, def] of Object.entries(schema)) {
        const type = def && def.type;
        if (type === "color") {
          // Hex-string default (e.g. '#ff0000'); a bad string falls back
          // to white.
          let colorVal;
          try {
            colorVal = new THREE.Color(
              def && def.default !== undefined ? def.default : "#ffffff",
            );
          } catch (e) {
            colorVal = new THREE.Color("#ffffff");
          }
          uniforms[name] = THREE.TSL.uniform(colorVal);
        } else if (type === "map") {
          // Texture uniform: seed with a 1×1 white placeholder so the shader
          // compiles (and renders) before the real image arrives.
          //
          // IMPORTANT (verified in three r184 source): the colorSpace
          // conversion is BAKED into the compiled shader from the texture's
          // colorSpace at build time, and swapping `.value` later does NOT
          // recompile. The placeholder AND every texture assigned later must
          // therefore be pinned to THREE.SRGBColorSpace, or a later swap
          // would sample through the wrong (baked) conversion.
          const placeholder = new THREE.DataTexture(
            new Uint8Array([255, 255, 255, 255]),
            1,
            1,
            THREE.RGBAFormat,
            THREE.UnsignedByteType,
          );
          placeholder.colorSpace = THREE.SRGBColorSpace;
          placeholder.needsUpdate = true;
          uniforms[name] = THREE.TSL.texture(placeholder);
        } else {
          // 'number' (default) — the 0.4 behavior.
          const val = def && def.default !== undefined ? def.default : 0;
          uniforms[name] = THREE.TSL.uniform(val);
        }
      }
      this._propertyUniforms = uniforms;

      // Kick off loads for non-empty map defaults ('' means no default;
      // '#someId' or a URL loads). Done AFTER _propertyUniforms is assigned
      // so the async load callback can find its uniform node.
      for (const [name, def] of Object.entries(schema)) {
        if (
          def &&
          def.type === "map" &&
          typeof def.default === "string" &&
          def.default !== ""
        ) {
          this._loadMapValue(name, def.default);
        }
      }

      // Dynamically extend A-Frame schema with detected properties so
      // future setAttribute() calls can update them and trigger update().
      if (Object.keys(schema).length > 0) {
        const propSchema = {};
        for (const name in schema) {
          const def = schema[name] || {};
          // Use the entry's real A-Frame property type: 'color' keeps the
          // string, 'map' resolves '#id' to the IMG/CANVAS/VIDEO element (or
          // passes a URL string through), everything else parses as a number.
          const aframeType =
            def.type === "color"
              ? "color"
              : def.type === "map"
                ? "map"
                : "number";
          propSchema[name] = {
            type: aframeType,
            default:
              def.default !== undefined
                ? def.default
                : aframeType === "color"
                  ? "#ffffff"
                  : aframeType === "map"
                    ? ""
                    : 0,
          };
        }
        // NB: keep this as ONE extendSchema call with the full propSchema —
        // A-Frame's extendSchema rebuilds from the originally registered
        // schema each time (it does NOT accumulate across calls), so a
        // second call would drop the first call's properties.
        this._extending = true;
        this.extendSchema(propSchema);
        this._extending = false;

        // Read initial uniform values from the DOM attribute.
        // getDOMAttribute may return a string (raw HTML) or an object
        // (after extendSchema converts to multi-property component).
        // Both branches route through _applyUniformValue so number/color/map
        // all behave exactly like later setAttribute() updates.
        const rawAttr = this.el.getDOMAttribute("shader");
        if (typeof rawAttr === "string") {
          for (const pair of rawAttr.split(";")) {
            const colonIdx = pair.indexOf(":");
            if (colonIdx === -1) continue;
            const key = pair.slice(0, colonIdx).trim();
            const val = pair.slice(colonIdx + 1).trim();
            if (key === "src") continue;
            if (this._applyUniformValue(key, val)) {
              console.log(`shaderloader: ${key} = ${val} (from attribute)`);
            }
          }
        } else if (rawAttr && typeof rawAttr === "object") {
          for (const key in rawAttr) {
            if (key === "src") continue;
            if (this._applyUniformValue(key, rawAttr[key])) {
              console.log(
                `shaderloader: ${key} = ${rawAttr[key]} (from attribute)`,
              );
            }
          }
        }
      }

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
        // Fallback: emissiveNode alone appears black in WebGPU renderer —
        // copy it to colorNode so the shader is always visible.
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
        if (shaderResult.depthWrite !== undefined) {
          material.depthWrite = shaderResult.depthWrite;
        }
      } else {
        // Simple API: return a single node (backward compatible)
        material.colorNode = shaderResult;
      }

      this.disposeShaderMaterial();
      this._shaderMaterial = material;
      this.applyMaterialToMesh(mesh, material);
      // Announce success so embedding pages (editor preview, viewer) can
      // clear any error overlay. Bubbles like every A-Frame entity event.
      this.el.emit("shader-applied", { src: tslPath });
    } catch (err) {
      // Staleness guard, mirroring the success path: a superseded apply's
      // late failure must not revert the material a newer apply installed,
      // nor surface a stale error over a shader that is rendering fine.
      if (this._currentSrc !== tslPath) {
        return;
      }
      console.error(`Failed to load TSL shader from ${tslPath}`, err);
      this.restoreOriginalMaterials(mesh);
      // Surface the failure as a DOM event — console.error alone leaves
      // embedding pages with a silently-fallback material and no signal.
      this.el.emit("shader-error", {
        src: tslPath,
        message: (err && err.message) || String(err),
      });
    }
  },
  // Route one raw property value (attribute string, A-Frame-parsed value, or
  // DOM element for maps) to its uniform, dispatched on the uniform's runtime
  // kind. All three application sites — the string-attr read, the object-attr
  // read, and the update() diff loop — go through here so they can never
  // drift apart. Returns true when the value was accepted (or a texture load
  // was kicked off).
  _applyUniformValue: function (name, raw) {
    const uniforms = this._propertyUniforms;
    const u = uniforms && uniforms[name];
    if (!u) {
      return false;
    }
    // Map: TSL texture nodes carry the isTextureNode flag. Swapping .value is
    // a bind-group-only update (no shader recompile) — see _loadMapValue.
    if (u.isTextureNode) {
      return this._loadMapValue(name, raw);
    }
    // Color: accepts '#fff', '#ff0000', 'red', or an existing THREE.Color.
    if (u.value && u.value.isColor) {
      try {
        u.value.set(raw);
        return true;
      } catch (e) {
        return false;
      }
    }
    // Float uniform — the 0.4 behavior.
    if (typeof u.value === "number") {
      const num = parseFloat(raw);
      if (!isNaN(num)) {
        u.value = num;
        return true;
      }
    }
    return false;
  },
  // Resolve a map value (URL string, '#id' selector string, or an
  // IMG/CANVAS/VIDEO element) into a THREE.Texture via A-Frame's material
  // system and swap it into the named texture uniform.
  //
  // Trust note: no remote-fetch logic beyond what A-Frame's loadTexture
  // already does — the scene author supplying the attribute is trusted; the
  // EDITOR side is responsible for policing what lands in exported schema
  // defaults.
  _loadMapValue: function (name, src) {
    if (src === undefined || src === null || src === "") {
      return false;
    }
    // Mimic A-Frame's 'map' property type for the raw string-attribute path:
    // unwrap url(...) first — mandatory for data: URIs, whose ';' would
    // otherwise have split the attribute — then resolve '#id' selectors.
    if (typeof src === "string") {
      const um = src.match(/^url\((.+)\)$/);
      if (um) {
        src = um[1];
      }
    }
    if (typeof src === "string" && src[0] === "#") {
      const selected = document.querySelector(src);
      if (selected) {
        // Media elements load directly; any other tag (e.g. <a-asset-item>)
        // contributes its src attribute — same fallback as A-Frame's parser.
        const tag = selected.tagName;
        src =
          tag === "IMG" || tag === "CANVAS" || tag === "VIDEO"
            ? selected
            : selected.getAttribute("src") || src;
      }
    }
    // Per-COMPONENT texture cache. WHY (verified): A-Frame's loadTexture
    // returns a FRESH THREE.Texture per request (it caches only at the
    // THREE.Source level), and three's TSL merges texture bindings only for
    // the SAME Texture instance (dedupe key is texture.uuid) — without this
    // cache, two map uniforms sharing one source would burn two of the ~16
    // per-stage texture binding slots.
    this._texCache = this._texCache || new Map();
    const key =
      src && typeof src === "object"
        ? src.id || src.src || String(src)
        : String(src);
    // Latest-request-wins guard: a slow earlier load (e.g. the schema
    // default) must not clobber a newer assignment when its callback lands.
    this._mapRequests = this._mapRequests || {};
    this._mapRequests[name] = key;

    const cached = this._texCache.get(key);
    if (cached) {
      const uniforms = this._propertyUniforms;
      if (uniforms && uniforms[name] && uniforms[name].isTextureNode) {
        uniforms[name].value = cached;
        return true;
      }
      return false;
    }

    const sceneEl = this.el.sceneEl;
    if (!sceneEl || !sceneEl.systems || !sceneEl.systems.material) {
      return false;
    }
    // Concurrent-load dedupe: the texture cache only holds RESOLVED textures,
    // so two map uniforms resolving the same src at startup would both miss it
    // and land two distinct textures (two binding slots). Track in-flight keys
    // and let the first load's callback assign every waiting uniform.
    this._texPending = this._texPending || new Map();
    const waiting = this._texPending.get(key);
    if (waiting) {
      if (waiting.indexOf(name) === -1) {
        waiting.push(name);
      }
      return true;
    }
    this._texPending.set(key, [name]);
    sceneEl.systems.material.loadTexture(src, {}, (tex) => {
      const names =
        (this._texPending && this._texPending.get(key)) || [name];
      if (this._texPending) {
        this._texPending.delete(key);
      }
      if (!tex) {
        return; // load failed — keep the current texture
      }
      // The component may be gone (or torn down and re-applied) by the time
      // the async load lands — bail rather than resurrect a stale uniform.
      if (!this.el || !this.el.isConnected) {
        return;
      }
      const uniforms = this._propertyUniforms;
      if (!uniforms) {
        return;
      }
      // MUST match the placeholder's colorSpace — the conversion is baked
      // into the compiled shader at build time and a .value swap does not
      // recompile (verified in three r184 source).
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      this._texCache.set(key, tex);
      for (const n of names) {
        if (!uniforms[n] || !uniforms[n].isTextureNode) {
          continue;
        }
        if (!this._mapRequests || this._mapRequests[n] !== key) {
          continue; // superseded by a newer assignment for this property
        }
        uniforms[n].value = tex; // bind-group-only update, no recompile
      }
    });
    return true;
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
    this._propertyUniforms = null;
    this._texCache = null;
    this._mapRequests = null;
    this._texPending = null;
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

// Auto-detect property schema from source code by scanning for `params.XXX`
// patterns. This lets hand-written modules work without an explicit
// `export const schema = {...}` — the shaderloader creates TSL uniforms
// for each detected property with a default value of 0.
// Also detects `const NAME = uniform(VALUE)` patterns to extract defaults,
// and (0.5) `const NAME = uniform(color(0xRRGGBB))` as color entries.
function autoDetectSchema(source) {
  const schema = {};

  // Detect params.XXX usage
  const paramRegex = /\bparams\.(\w+)\b/g;
  let m;
  while ((m = paramRegex.exec(source)) !== null) {
    const name = m[1];
    if (!(name in schema)) {
      schema[name] = { type: "number", default: 0 };
    }
  }

  // Detect `const NAME = uniform(color(0xRRGGBB))` as a color property.
  // ORDER MATTERS: this must run BEFORE the numeric pass below — the numeric
  // regex's `[^)]+` capture stops at the FIRST ')' so it also matches the
  // color form (capturing garbage like "color(0xff0000"); the color pass
  // claims those names first, and the numeric pass skips names already in
  // the schema.
  const colorUniformRegex =
    /\bconst\s+(\w+)\s*=\s*uniform\(\s*color\(\s*0x([0-9a-fA-F]{6})\s*\)\s*\)/g;
  while ((m = colorUniformRegex.exec(source)) !== null) {
    const name = m[1];
    if (!(name in schema)) {
      schema[name] = { type: "color", default: "#" + m[2].toLowerCase() };
    }
  }

  // Detect `const NAME = uniform(VALUE)` and use VALUE as default
  const uniformRegex = /\bconst\s+(\w+)\s*=\s*uniform\(\s*([^)]+)\s*\)/g;
  while ((m = uniformRegex.exec(source)) !== null) {
    const name = m[1];
    const val = parseFloat(m[2]);
    if (!(name in schema)) {
      schema[name] = { type: "number", default: isNaN(val) ? 0 : val };
    }
  }

  if (Object.keys(schema).length > 0) {
    console.log(
      "shaderloader: auto-detected properties:",
      Object.keys(schema).join(", "),
    );
  }
  return schema;
}

// Auto-detect and inject missing TSL imports. Generated TSL code may use
// functions like uv() without importing them. This scans the source for
// function calls that aren't imported or locally declared, and adds them
// to the existing three/tsl import statement. Only injects names that
// actually exist in THREE.TSL to avoid injecting non-existent symbols.
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

  // Strip block comments across the whole source FIRST — a multi-line `/* … */`
  // (e.g. FastShaders' trailing FASTSHADERS_PROJECT_V1 JSON block) would
  // otherwise leak its JSON keys into the identifier scan below and get
  // auto-injected as bogus imports. The per-line `/* … */` strip that used to
  // live here only caught single-line block comments.
  const bodyLines = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(import|export)\s/.test(l));
  // Strip line comments so patterns like "// glow (effect)" don't false-match
  const body = bodyLines.map((l) => l.replace(/\/\/.*$/, "")).join("\n");

  // Detect function calls: name(
  const callRegex = /(?<![.\w])([a-zA-Z_$]\w*)\s*\(/g;
  const usedCalls = new Set();
  let cm;
  while ((cm = callRegex.exec(body)) !== null) {
    usedCalls.add(cm[1]);
  }

  // Also detect bare identifiers (e.g. positionGeometry, normalLocal, time)
  // that are used as values, not function calls
  const identRegex = /(?<![.\w])([a-zA-Z_$]\w*)(?!\s*\()/g;
  while ((cm = identRegex.exec(body)) !== null) {
    usedCalls.add(cm[1]);
  }

  const exclude = new Set([
    ...importedNames,
    "const",
    "let",
    "var",
    "function",
    "return",
    "if",
    "else",
    "for",
    "while",
    "do",
    "switch",
    "case",
    "break",
    "continue",
    "new",
    "typeof",
    "instanceof",
    "void",
    "delete",
    "throw",
    "try",
    "catch",
    "finally",
    "class",
    "extends",
    "super",
    "import",
    "export",
    "default",
    "from",
    "async",
    "await",
    "yield",
    "of",
    "in",
    "true",
    "false",
    "null",
    "undefined",
    "this",
    "arguments",
    "console",
    "window",
    "document",
    "Math",
    "JSON",
    "Array",
    "Object",
    "String",
    "Number",
    "Boolean",
    "Date",
    "RegExp",
    "Error",
    "TypeError",
    "RangeError",
    "Promise",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Symbol",
    "Proxy",
    "Reflect",
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    "setTimeout",
    "setInterval",
    "clearTimeout",
    "clearInterval",
    "fetch",
    "URL",
    "requestAnimationFrame",
    "THREE",
    "AFRAME",
    "params",
  ]);

  // Validate against actual TSL exports to avoid injecting non-existent symbols
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

  console.log(
    "shaderloader: auto-injecting missing TSL imports:",
    missing.join(", "),
  );
  const currentImports = match[2].trimEnd();
  const newImportList = currentImports + ", " + missing.join(", ");
  return source.replace(tslImportRegex, "$1" + newImportList + "$3");
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
    // Don't touch import/export declaration lines
    if (/^\s*import\s/.test(line) || /^\s*export\s/.test(line)) {
      return line;
    }

    let out = line;

    // Apply accumulated renames: replace value references (not function calls)
    for (const [orig, renamed] of renames) {
      out = out.replace(
        new RegExp("(?<!\\.)\\b" + orig + "\\b(?!\\s*[\\(:])", "g"),
        renamed,
      );
    }

    // Detect new shadowing declaration: const NAME = ... where NAME is an import
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

// TSL shaders import from bare specifiers ('three', 'three/webgpu',
// 'three/tsl', 'tsl-textures'). The A-Frame IIFE bundle installs a SINGLE
// Three.js instance on the global (window.THREE / window.tslTextures), so
// instead of resolving those specifiers to an ESM shim file we rewrite each
// import into a destructure that READS that one global instance. This keeps
// every shader on the same Three.js as the A-Frame scene (no second instance,
// no shim file, and no page-level import map — which blob: modules ignore
// anyway).
const GLOBAL_SOURCE = {
  three: "globalThis.THREE",
  "three/webgpu": "globalThis.THREE",
  "three/tsl": "globalThis.THREE.TSL",
  "tsl-textures": "globalThis.tslTextures",
};

// Rewrite `import ... from '<bare>'` → `const { ... } = <global>;`.
// Handles named (incl. `x as y` aliases), default, and `* as ns` imports.
// Relative imports ('./', '../') are left untouched for resolveTSLImports().
// The `import` keyword is anchored to the start of a line (only leading
// horizontal whitespace) so the word "import" or a `{` inside a preceding
// comment — e.g. FastShaders' own "(no import map, no shim)" usage header and
// its `el.setAttribute('shader', { name: value })` example — can't start a
// spurious multi-line match that swallows the real `import ... from 'three/tsl'`
// and mangles it into a broken destructure ("Missing initializer in
// destructuring declaration"). ES `import` statements are always line-leading.
function globalizeBareImports(source) {
  return source.replace(
    /^[ \t]*import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2[ \t]*;?/gm,
    function (full, clause, quote, spec) {
      const target = GLOBAL_SOURCE[spec];
      if (!target) return full; // relative / unknown — leave for later resolver
      clause = clause.trim();
      // Namespace import: `* as NS`
      const ns = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (ns) return "const " + ns[1] + " = " + target + ";";
      // Named import (optionally with a leading default): `Def, { a, b as c }`
      const brace = clause.indexOf("{");
      if (brace !== -1) {
        const lead = clause.slice(0, brace).replace(/,\s*$/, "").trim();
        const inner = clause.slice(brace + 1, clause.lastIndexOf("}"));
        const fields = inner
          .split(",")
          .map(function (n) { return n.trim(); })
          .filter(Boolean)
          .map(function (n) {
            const a = n.split(/\s+as\s+/);
            return a.length === 2 ? a[0].trim() + ": " + a[1].trim() : a[0].trim();
          })
          .join(", ");
        let out = "const { " + fields + " } = " + target + ";";
        if (lead) out = "const " + lead + " = " + target + ";\n" + out;
        return out;
      }
      // Default-only import: `import Def from 'x'`
      const def = clause.match(/^([A-Za-z_$][\w$]*)$/);
      if (def) return "const " + def[1] + " = " + target + ";";
      return full;
    },
  );
}

// Resolve RELATIVE import specifiers to absolute URLs so a module loaded from a
// Blob URL can still reach sibling files. Bare specifiers were already turned
// into global reads by globalizeBareImports.
function resolveTSLImports(source, baseUrl) {
  return source.replace(
    /from\s+(['"])([^'"]+)\1/g,
    function (match, quote, specifier) {
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
