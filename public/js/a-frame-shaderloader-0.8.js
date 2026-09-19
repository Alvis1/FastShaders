/*
 * a-frame-shaderloader 0.8
 *
 * 0.8: ONE classic script, two layers.
 *      - A framework-agnostic CORE on `globalThis.FastShaders`: use / load /
 *        prepareSource / makeParams / setUniform / apply (→ a Binding) /
 *        weld / transforms / internals. A plain three.js page calls it
 *        directly (three/webgpu namespace, r184):
 *          FastShaders.use(THREE);
 *          const shader = await FastShaders.load("./myshader.js");
 *          const binding = FastShaders.apply(mesh, shader, { values: { speed: 2 } });
 *          binding.set("speed", 3);   // …and binding.dispose() to undo it all
 *      - The A-Frame `shader` component, a thin caller of that core,
 *        registered only when A-Frame is on the page.
 *      THE COMPONENT IS THE CORE'S STATE OBJECT. Every core function that
 *      mutates takes a state whose fields keep 0.6's component names
 *      (originalMaterials, _shaderMaterial, _partMaterials, _appliedMaterials,
 *      _propertyUniforms, _weld*, _bary*, _tex*), and the component passes
 *      itself. The FastShaders editor preview and podest read those fields off
 *      `entity.components.shader`, so renaming one breaks them with no error.
 *      Behaviour is 0.6's, with exactly these deltas:
 *        1. Evaluating this file without A-Frame does not throw.
 *        2. A module returning `materialParts` (per glTF material) counts as
 *           the object API, so it can never take the Simple-API path, which
 *           would assign the whole return object to colorNode. Meshes no part
 *           claims take the default material, else go back to their authored
 *           one (on a re-apply too, never the previous shader's material).
 *        3. The uniforms map is null-prototype.
 *        4. autoInjectTSLImports validates against the BOUND three instance
 *           instead of window.THREE (the same object under A-Frame).
 *        5. Three-revision checks, warn-only: this file against the page, and
 *           a module's `export const threeRevision` against the page.
 *        6. The helpers are no longer globals (the file is an IIFE); they are
 *           exposed as FastShaders.transforms and FastShaders.internals.
 *        7. glTF material-index parts. FastShaders.gltfPlugin records each
 *           mesh's glTF material index while GLTFLoader parses, and a
 *           `materialParts` table applies by that index ONLY when the module's
 *           `modelSignature` equals the parse. Keys listed in
 *           `materialPartsMirror` are 0.6-only copies and are never name
 *           claims here. The file wraps A-Frame's gltf-model init once so the
 *           plugin is on every model loader before it loads anything.
 *        8. glTF decoders. FastShaders.decoders puts three's own Draco and
 *           meshopt decoders (js/decoders/ beside this file) on every
 *           gltf-model loader through that same init wrap, so a compressed
 *           model decodes instead of failing to load (section 13b) — and the
 *           Basis Universal transcoder behind a KTX2Loader, so a
 *           KHR_texture_basisu texture is transcoded for this GPU instead of
 *           falling back to its PNG/JPEG source or refusing the model
 *           (section 13b-KTX2).
 *        9. `shader="src: model"` runs the shader a FastShaders single-GLB
 *           export carries inside the model (root extras.fastshaders.module),
 *           and ONLY when a page asks: the component on an entity with its own
 *           gltf-model, or FastShaders.loadFromGltf / applyFromGltf on plain
 *           three (section 13c). Parsing never decodes, mints a URL or imports
 *           anything. The module's image placeholders resolve to blob: URLs of
 *           the GLB's own images, living as long as the binding that uses
 *           them. Every failure (no module, a damaged view, not UTF-8, no
 *           default export…) leaves the model on its authored materials and
 *           emits shader-error; the keyword never fetches a file named
 *           `./model`. FastShaders.disableModelModules() is a one-way latch
 *           for pages that must never run a model's code. WARNING: never use
 *           `src: model` on a page that loads models other people supply —
 *           the module runs with the page's privileges, like a script tag. A
 *           FastShaders GLB is recognised by `extras.fastshaders.v === 1`
 *           alone: `assets` is optional, since a module-only export carries
 *           no images.
 *      Written for three r184. 0.6, 0.5 and 0.4 are FROZEN: shaders exported
 *      against them fetch them from the CDN by URL, so they never change.
 *      Later 0.8.x edits are ADDITIVE only — no renamed state field, method,
 *      event or api key — because every edit ships to every exported 0.8
 *      shader the moment it is pushed.
 *
 * 0.6: per-sub-mesh materials. A module may return an additive `parts` key —
 *      { parts: { "<meshName>": { colorNode, ..., transparent, side } } } —
 *      and each entry becomes its own MeshPhysicalNodeMaterial, dispatched by
 *      `node.name` during the traverse. Semantics, all deliberate:
 *        - ALL matches: a name shared by several meshes (routine — three's
 *          de-duplication is bypassed when glTF nodes instance one mesh, and
 *          OBJ never de-dupes) takes the part material on every one of them.
 *        - Unmatched meshes take the TOP-LEVEL material, exactly as before.
 *        - A module with parts and NO top-level channels leaves unmatched
 *          meshes on their AUTHORED materials rather than blanking them —
 *          the KHR_materials_variants fallback shape.
 *        - EXCEPT on a SINGLE-mesh model, where that same parts-only module
 *          puts its FIRST part on the one mesh instead. A model with one mesh
 *          has no material to choose between, so "nothing matched" there is a
 *          naming mismatch, not an authored fallback — see applyMaterialToMesh.
 *      A module WITHOUT `parts` behaves identically to 0.5 in every respect,
 *      which is what lets the editor preview and every new export run 0.6
 *      unconditionally. 0.5 is frozen: shaders exported before this reference
 *      it from the CDN by URL, so it must never change.
 *
 * 0.6: vertex WELD for displaced primitives. The editor preview always did this
 *      with an inline `weld-verts` component, so a displaced <a-box> rendered
 *      as one skin in the editor and as six separated faces EVERYWHERE else —
 *      podest, the copy-ready A-Frame page, and any page embedding an exported
 *      module. Doing it here fixes all of them at once and leaves ONE
 *      implementation. Gated on three things, each load-bearing (see
 *      shouldWeld): an A-FRAME PRIMITIVE (welding a model would drop vertex
 *      colours, skin weights and morph targets — `fit-bounds` handles models);
 *      a built material actually carrying a `positionNode` (structural, since
 *      this is the only layer holding the built material); and the author not
 *      having unticked "Merge Vertices", which arrives as `mergeVertices:
 *      false` in the module's return object (ABSENT means weld, so every
 *      already-exported module is unaffected by the key's existence).
 *      weldByPosition itself merges only groups whose NORMALS DIFFER — see its
 *      header for the measurements, and for why welding a sphere is pure loss.
 *
 * 0.5: typed schema entries — number/color/map. Schema entries dispatch on
 *      `def.type`: 'number' (float uniform, the 0.4 behavior and the default),
 *      'color' (THREE.Color uniform; also auto-detected from
 *      `const NAME = uniform(color(0xRRGGBB))`), and 'map' (TSL texture node
 *      seeded with an SRGB-pinned 1×1 white placeholder, resolved via
 *      A-Frame's material.loadTexture — '#id' selector or URL).
 */
/* global AFRAME */
(function (root) {
"use strict";

// ---------------------------------------------------------------------------
// (2) Version, the double-include guard, and every message this file prints
// ---------------------------------------------------------------------------

var VERSION = "0.8.0";
// The three.js release this file is written and tested against. The FastShaders
// app keeps the same number in src/engine/threeRevision.ts. A mismatch only
// WARNS (checkThreeRevision) — a newer three usually still runs the shader.
var THREE_REVISION = "184";

// A second copy of 0.8 on one page is a no-op: the first copy's api object, and
// the component it registered, stay in charge. Nothing below has run yet.
if (root.FastShaders && /^0\.8\./.test(String(root.FastShaders.version))) {
  return;
}

// String literals stay ASCII (\u2014 is an em dash): a page served in a
// non-UTF-8 charset would otherwise garble them.
var ERR_NO_THREE =
  "FastShaders: no three.js bound \u2014 call FastShaders.use(THREE) with the three/webgpu namespace before load() or apply().";
var ERR_USE_TYPE =
  "FastShaders.use: expected the three/webgpu namespace (import * as THREE from 'three/webgpu'); this object has no MeshPhysicalNodeMaterial.";
var ERR_APPLY_TARGET =
  "FastShaders.apply: the target must be a three.js Object3D (a Mesh, a Group or a loaded model's scene).";
var ERR_APPLY_INPUT =
  "FastShaders.apply: expected a loaded shader (await FastShaders.load(url)), a module namespace, or its default export.";
var WARN_TWO_THREE =
  "FastShaders.use: globalThis.THREE is a different three.js instance; shaders that build textures read globalThis.THREE and will use that one.";
var WARN_DUP_COMPONENT =
  "FastShaders 0.8: an A-Frame `shader` component is already registered (another shaderloader on this page?). 0.8's component was not registered; FastShaders.apply still works.";
// `src: model` (header delta 9, section 13c). Each is the message of the Error
// that lands in the component's catch (shader-error) or rejects the plain-three
// call; {v} and {reason} are filled by fillMsg from the loader's OWN values,
// never from text out of the model file.
var M_DISABLED = "src: model is turned off on this page.";
var M_NO_GLTF = "src: model needs a gltf-model on the same entity.";
var M_NO_RECORD =
  "src: model could not read this model: it was loaded without FastShaders.gltfPlugin (register it on the GLTFLoader before loading).";
var M_NONE = "This model carries no FastShaders shader. Its own materials are shown.";
var M_FORMAT =
  "This model's FastShaders data is format {v}; this loader reads format 1. Its own materials are shown.";
var M_BAD = "This model's FastShaders shader is unreadable ({reason}). Its own materials are shown.";
var M_NO_DEFAULT = "This model's FastShaders shader has no default export.";
var M_BAD_TARGET = "loadFromGltf needs a glTF result or its scene.";
var W_UNRESOLVED =
  "[FastShaders] src: model: {n} image(s) the shader uses are not in this model; they render black.";
// One pass over the template; a {key} the values do not carry stays literal.
function fillMsg(t, v) {
  return String(t).replace(/\{(\w+)\}/g, function (m, k) {
    return Object.prototype.hasOwnProperty.call(v, k) ? String(v[k]) : m;
  });
}
// The glTF section's messages (13a). One console.warn per apply, and never for
// a primitive or an OBJ (status not-gltf).
var WARN_MP_NO_RECORD =
  "[FastShaders] materialParts skipped: this model was loaded without the FastShaders glTF plugin, so its materials cannot be matched. Register FastShaders.gltfPlugin on the GLTFLoader before loading.";
var WARN_MP_NO_SIGNATURE =
  "[FastShaders] materialParts skipped: the module has no modelSignature, so it cannot tell which model its material numbers belong to.";
var WARN_MP_INVALID = "[FastShaders] materialParts skipped: modelSignature is malformed.";
var WARN_MP_MIRROR =
  "[FastShaders] materialPartsMirror is not an array of part names; it was ignored.";
var WARN_GLTF_HOOK =
  "[FastShaders] could not hook A-Frame's gltf-model; a model that loads before its shader attaches will not be indexed.";
// A name out of someone's model file: quoted, cut at 40 characters.
function mpName(s) {
  if (typeof s !== "string") return "(too long)";
  return JSON.stringify(s.length > 40 ? s.slice(0, 40) + "\u2026" : s);
}
function mpNames(list) {
  var shown = list.slice(0, 8).map(mpName).join(", ");
  return list.length > 8 ? shown + ", \u2026" : shown;
}
function warnMpMismatch(expected, foundCount, foundNames) {
  return (
    "[FastShaders] materialParts skipped: the shader was made for a model with " +
    expected.length + " materials (" + mpNames(expected) + "), this model has " +
    foundCount + " (" + mpNames(foundNames) + "). Its material numbers are ignored; name parts and the default material still apply."
  );
}
function warnMpDropped(k) {
  return "[FastShaders] materialParts: " + k + " entries over the limit of " + MATERIAL_PARTS_MAX + " were ignored.";
}
function warnIndexFailed(e) {
  var msg;
  try {
    msg = e && typeof e.message === "string" ? e.message : String(e);
  } catch (err) {
    msg = "unknown error";
  }
  return "[FastShaders] could not index this glTF: " + msg;
}
function warnEmbedIgnored(key, reason) {
  return "[FastShaders] embedded image " + mpName(key) + " ignored: " + reason;
}
function warnLoaderRev(rev) {
  return "FastShaders 0.8 is written for three r" + THREE_REVISION + "; this page runs r" + rev + ". TSL names and node behaviour may differ.";
}
function warnModuleRev(declared, rev) {
  return "FastShaders: this shader was exported for three r" + declared + "; this page runs r" + rev + ". If it fails to compile, load three 0." + declared + ".0.";
}
// The mesh decoders' messages (13b). They become FastShaders.decoders.lastError,
// which a host page shows when a compressed model fails to load.
var ERR_DRACO_NO_CLASS = "Draco decoder unavailable: this three build has no DRACOLoader.";
var ERR_MESHOPT_MALFORMED =
  "meshopt data is malformed: a buffer view's count and byteStride must be positive integers, byteStride at most 256.";
function errMeshoptCap(total) {
  return (
    "meshopt data would unpack to " + mib(total) + " MB, over the " +
    mib(MAX_MESHOPT_DECODED_BYTES) + " MB limit for one model."
  );
}
function errMeshoptLoad(reason) {
  return "Could not load the meshopt decoder: " + reason;
}
function errDracoCreate(reason) {
  return "Draco decoder unavailable: " + reason;
}
// The KTX2 transcoder's messages (13b-KTX2). Same channel: they become
// FastShaders.decoders.lastError, and a transcode that falls back to the
// texture's PNG/JPEG source is reported there without failing the model.
var ERR_KTX2_NO_CLASS = "KTX2 transcoder unavailable: this three build has no KTX2Loader.";
var ERR_KTX2_NO_RENDERER =
  "KTX2 needs the renderer to choose a GPU format, and none is available; the fallback image is used.";
var ERR_KTX2_MAGIC = "This is not a KTX2 file (the 12-byte identifier does not match).";
var ERR_KTX2_NOT_2D =
  "Only 2D KTX2 textures are supported: this one is a cube map, an array or a 3D texture.";
// Not a message: the sentinel the plugin throws when GLTFLoader resolves a null
// texture, so its catch knows the shim has already reported the real reason.
var KTX2_EMPTY = "fastshaders:ktx2-empty";
function errKtx2Create(reason) {
  return "KTX2 transcoder unavailable: " + reason;
}
function errKtx2Levels(levels) {
  return "This KTX2 texture declares " + levels + " mip levels, over the limit of " + KTX2_MAX_LEVELS + ".";
}
function errKtx2Bytes(bytes) {
  return (
    "This KTX2 texture is " + mib(bytes) + " MB, over the " +
    mib(KTX2_MAX_FILE_BYTES) + " MB limit for one texture."
  );
}
function errKtx2Side(w, h, max) {
  return (
    "This KTX2 texture is " + w + "x" + h + ", over the " + max +
    " px limit for the format this GPU transcodes to."
  );
}
function errKtx2Texture(reason) {
  return "Could not transcode a KTX2 texture: " + reason;
}

// ---------------------------------------------------------------------------
// (3) The three.js binding
// ---------------------------------------------------------------------------
//
// Under A-Frame the bundle installs one global THREE and nothing has to call
// use(). A plain three.js page has no global, so it hands its three/webgpu
// namespace to use(). T() is the ONLY accessor in this file, and it is called
// lazily: dispatch and storing/restoring originals never touch THREE at all,
// so they work with none bound (the editor's per-mesh dispatch test relies on
// that).

var boundThree = null;

function threeOrNull() {
  return boundThree || root.THREE || (root.window && root.window.THREE) || null;
}

function T() {
  var t = threeOrNull();
  if (!t) {
    throw new Error(ERR_NO_THREE);
  }
  return t;
}

function use(THREE) {
  if (!THREE || typeof THREE.MeshPhysicalNodeMaterial !== "function" || !THREE.TSL) {
    throw new TypeError(ERR_USE_TYPE);
  }
  boundThree = THREE;
  // Module code that bakes a texture (Image, Data and Colormap nodes) builds it
  // from globalThis.THREE, so the global has to exist before a shader loads.
  if (!root.THREE) {
    root.THREE = THREE;
  } else if (root.THREE !== THREE) {
    console.warn(WARN_TWO_THREE);
  }
  checkThreeRevision(undefined);
  return api;
}

// ---------------------------------------------------------------------------
// (4) Source transforms — 0.6's, byte for byte, except that
//     autoInjectTSLImports reads TSL off the bound three instance.
// ---------------------------------------------------------------------------

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
  // 0.8: the BOUND three instance (use(), else the global) — the same object
  // as window.THREE under A-Frame, and the only one a plain three.js page has.
  const t = threeOrNull();
  const tslExports = t && t.TSL ? t.TSL : null;

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

// 0.6's four transforms, in 0.6's order (the README's "What the loader does to
// your source"). `moduleUrl` resolves the module's relative imports; 0.6 passed
// `new URL(modulePath, location.href).href`.
function prepareSource(text, moduleUrl) {
  var s = autoInjectTSLImports(text);
  s = fixTSLShadowing(s);
  s = globalizeBareImports(s);
  s = resolveTSLImports(s, moduleUrl);
  return s;
}

// ---------------------------------------------------------------------------
// (5) Loading a module
// ---------------------------------------------------------------------------

// Import prepared source through a Blob URL. The URL is revoked once the
// import has settled either way. `api.importSource` replaces this (tests, and
// pages that cannot mint blob: URLs).
function defaultImportSource(source) {
  var blobUrl = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
  return import(blobUrl).finally(function () {
    URL.revokeObjectURL(blobUrl);
  });
}

// → { url, source, module }. `api.fetch` / `api.importSource` (or the same keys
// on `opts`) override the two network legs; they are the documented hooks for
// embedding pages and tests.
async function load(src, opts) {
  opts = opts || {};
  var base = opts.base || (root.location && root.location.href) || undefined;
  var tslPath = String(src);
  // Treat `blob:` and `data:` URLs as absolute. When the preview iframe
  // is sandboxed without `allow-same-origin` its origin is opaque, so
  // blob URLs minted inside it look like `blob:null/<uuid>` — the
  // `://` heuristic below misses that form and the loader would
  // wrongly prefix `./`, producing an unparseable URL.
  var modulePath =
    tslPath.startsWith("./") ||
    tslPath.startsWith("/") ||
    tslPath.includes("://") ||
    tslPath.startsWith("blob:") ||
    tslPath.startsWith("data:")
      ? tslPath
      : "./" + tslPath;

  var fetchImpl = opts.fetch || api.fetch || root.fetch;
  var response = await fetchImpl.call(root, modulePath);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} loading ${modulePath}`);
  }
  var text = await response.text();
  // Without a usable base (no location, an unparseable href) relative imports
  // are simply left as they are, exactly as resolveTSLImports does for a null
  // base.
  var moduleUrl = null;
  try {
    moduleUrl = new URL(modulePath, base).href;
  } catch (e) {
    moduleUrl = null;
  }
  var source = prepareSource(text, moduleUrl);
  var mod = await (opts.importSource || api.importSource || defaultImportSource)(source);
  return { url: tslPath, source: source, module: mod };
}

// ---------------------------------------------------------------------------
// (6) Uniforms and maps
// ---------------------------------------------------------------------------

// Build the uniform nodes a schema declares. The map is NULL-PROTOTYPE, so a
// property called `constructor` or `toString` can never resolve to something
// off Object.prototype. `values` (optional) is applied through setUniformValue
// with no map loader, so a map there accepts only a THREE.Texture.
function makeParams(schema, values) {
  const uniforms = Object.create(null);
  const entries = schema && typeof schema === "object" ? Object.entries(schema) : [];
  const THREE = entries.length > 0 ? T() : null;
  // 0.5: dispatch on the entry's declared type — 'number' (default),
  // 'color', or 'map' — instead of making every entry a float uniform.
  for (const [name, def] of entries) {
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
  if (values && typeof values === "object") {
    for (const k of Object.keys(values)) {
      setUniformValue(uniforms, k, values[k], null);
    }
  }
  return uniforms;
}

// Route one raw property value (attribute string, A-Frame-parsed value, or
// DOM element for maps) to its uniform, dispatched on the uniform's runtime
// kind. All three application sites — the string-attr read, the object-attr
// read, and the update() diff loop — go through here so they can never
// drift apart. Returns true when the value was accepted (or a texture load
// was kicked off). OWN names only: a caller-supplied map with a prototype
// would otherwise answer for `constructor`.
function setUniformValue(uniforms, name, raw, loadMap) {
  if (!uniforms || !Object.prototype.hasOwnProperty.call(uniforms, name)) {
    return false;
  }
  const u = uniforms[name];
  if (!u) {
    return false;
  }
  // Map: TSL texture nodes carry the isTextureNode flag. Swapping .value is
  // a bind-group-only update (no shader recompile) — see loadMapInto.
  if (u.isTextureNode) {
    if (loadMap) {
      return loadMap(name, raw);
    }
    if (raw && raw.isTexture) {
      raw.colorSpace = T().SRGBColorSpace;
      raw.needsUpdate = true;
      u.value = raw;
      return true;
    }
    return false;
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
}

// Resolve a map value into a THREE.Texture and swap it into the named texture
// uniform. 0.6's `_loadMapValue`, generalised over an ADAPTER — the part that
// differs between A-Frame (the material system's loadTexture, '#id' via the
// document) and plain three.js (TextureLoader, or a Texture handed in):
//   resolve(src) → src    canLoad() → bool    load(src, cb)    alive() → bool
//
// Trust note: no remote-fetch logic beyond what the adapter's loader already
// does — the page supplying the value is trusted; the EDITOR side is
// responsible for policing what lands in exported schema defaults.
function loadMapInto(state, name, src, adapter) {
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
  src = adapter.resolve(src);
  // Per-STATE texture cache. WHY (verified): A-Frame's loadTexture
  // returns a FRESH THREE.Texture per request (it caches only at the
  // THREE.Source level), and three's TSL merges texture bindings only for
  // the SAME Texture instance (dedupe key is texture.uuid) — without this
  // cache, two map uniforms sharing one source would burn two of the ~16
  // per-stage texture binding slots.
  state._texCache = state._texCache || new Map();
  // A Texture handed in (plain three.js) is keyed by its uuid: its `id` can be
  // 0 and it has no `src`, which would collapse every such texture onto the
  // same "[object Object]" key.
  const key =
    src && typeof src === "object"
      ? src.isTexture
        ? "texture:" + src.uuid
        : src.id || src.src || String(src)
      : String(src);
  // Latest-request-wins guard: a slow earlier load (e.g. the schema
  // default) must not clobber a newer assignment when its callback lands.
  state._mapRequests = state._mapRequests || Object.create(null);
  state._mapRequests[name] = key;

  const cached = state._texCache.get(key);
  if (cached) {
    const uniforms = state._propertyUniforms;
    if (uniforms && uniforms[name] && uniforms[name].isTextureNode) {
      uniforms[name].value = cached;
      return true;
    }
    return false;
  }

  if (!adapter.canLoad()) {
    return false;
  }
  // Concurrent-load dedupe: the texture cache only holds RESOLVED textures,
  // so two map uniforms resolving the same src at startup would both miss it
  // and land two distinct textures (two binding slots). Track in-flight keys
  // and let the first load's callback assign every waiting uniform.
  state._texPending = state._texPending || new Map();
  const waiting = state._texPending.get(key);
  if (waiting) {
    if (waiting.indexOf(name) === -1) {
      waiting.push(name);
    }
    return true;
  }
  state._texPending.set(key, [name]);
  adapter.load(src, function (tex) {
    const names = (state._texPending && state._texPending.get(key)) || [name];
    if (state._texPending) {
      state._texPending.delete(key);
    }
    if (!tex) {
      return; // load failed — keep the current texture
    }
    // The owner may be gone (or torn down and re-applied) by the time the
    // async load lands — bail rather than resurrect a stale uniform.
    if (!adapter.alive()) {
      return;
    }
    const uniforms = state._propertyUniforms;
    if (!uniforms) {
      return;
    }
    // MUST match the placeholder's colorSpace — the conversion is baked
    // into the compiled shader at build time and a .value swap does not
    // recompile (verified in three r184 source).
    tex.colorSpace = T().SRGBColorSpace;
    tex.needsUpdate = true;
    if (state._texCache) {
      state._texCache.set(key, tex);
    }
    for (const n of names) {
      if (!uniforms[n] || !uniforms[n].isTextureNode) {
        continue;
      }
      if (!state._mapRequests || state._mapRequests[n] !== key) {
        continue; // superseded by a newer assignment for this property
      }
      uniforms[n].value = tex; // bind-group-only update, no recompile
    }
  });
  return true;
}

// Plain three.js: a Texture is used as is, an element becomes a Texture (a
// VideoTexture for <video>), and a string is loaded with THREE.TextureLoader.
// '#id' resolves through the document exactly as the A-Frame adapter does.
function plainTextureAdapter(state) {
  return {
    resolve: function (src) {
      if (typeof src === "string" && src[0] === "#" && root.document) {
        const selected = root.document.querySelector(src);
        if (selected) {
          const tag = selected.tagName;
          src =
            tag === "IMG" || tag === "CANVAS" || tag === "VIDEO"
              ? selected
              : selected.getAttribute("src") || src;
        }
      }
      return src;
    },
    canLoad: function () {
      return true;
    },
    load: function (src, cb) {
      if (src && src.isTexture) {
        cb(src);
        return;
      }
      if (src && typeof src === "object" && src.tagName === "VIDEO") {
        cb(new (T().VideoTexture)(src));
        return;
      }
      if (src && typeof src === "object") {
        const tex = new (T().Texture)(src);
        tex.needsUpdate = true;
        cb(tex);
        return;
      }
      new (T().TextureLoader)().load(String(src), cb, undefined, function () {
        cb(null);
      });
    },
    alive: function () {
      return !state._disposed;
    },
  };
}

// ---------------------------------------------------------------------------
// (7) Materials
// ---------------------------------------------------------------------------

var NODE_PROPS = [
  "colorNode",
  "positionNode",
  "normalNode",
  "opacityNode",
  "roughnessNode",
  "metalnessNode",
  "emissiveNode",
  // Environment map (IBL): a texture-valued envNode is auto-wrapped in
  // pmremTexture() by three's EnvironmentNode (radiance + irradiance).
  "envNode",
];

function hasChannels(o) {
  return (
    o &&
    typeof o === "object" &&
    NODE_PROPS.some(function (p) {
      return o[p] !== undefined;
    })
  );
}

// One channel-set (the top-level result, or one `parts` entry) becomes
// one material. Extracted from the inline block 0.5 had so the default
// and every part are built by the SAME code — a part built by a copy
// would drift the moment a channel is added to one and not the other.
const buildMaterial = function (spec) {
  const material = new (T().MeshPhysicalNodeMaterial)();
  for (const prop of NODE_PROPS) {
    if (spec[prop] !== undefined) {
      material[prop] = spec[prop];
    }
  }
  // Fallback: emissiveNode alone appears black in WebGPU renderer —
  // copy it to colorNode so the shader is always visible.
  if (spec.emissiveNode !== undefined && spec.colorNode === undefined) {
    material.colorNode = spec.emissiveNode;
  }
  if (spec.transparent !== undefined) {
    material.transparent = spec.transparent;
  }
  if (spec.side !== undefined) {
    material.side = spec.side;
  }
  if (spec.alphaTest !== undefined) {
    material.alphaTest = spec.alphaTest;
  }
  if (spec.depthWrite !== undefined) {
    material.depthWrite = spec.depthWrite;
  }
  // FLAT shading (Blender's "Shade Flat"): one normal per face. three's node
  // materials honour `material.flatShading` — NodeBuilder.isFlatShading() swaps
  // `normalViewGeometry` for `normalFlat`, a face normal from the DERIVATIVES
  // of the view position — so it needs no vertex normals and works on welded,
  // displaced primitives too. Read like every key above: the module omits it
  // entirely for the default (smooth), so this is inert for every shader that
  // does not ask. 0.6 has no such branch and ignores the key, which is why a
  // shader carrying it renders smooth there rather than failing.
  if (spec.flatShading !== undefined) {
    material.flatShading = spec.flatShading;
  }
  return material;
};

// Always pass uniforms to functions that accept parameters.
function callShader(shaderExport, uniforms) {
  return typeof shaderExport === "function"
    ? shaderExport.length > 0
      ? shaderExport(uniforms)
      : shaderExport()
    : shaderExport;
}

// → { material, partMaterials, hasMaterialParts }. 0.6's classification and
// build, with ONE widening: a `materialParts` return counts as the object API.
function buildMaterials(shaderResult) {
  // A `parts`-only module carries no top-level channel, so the 0.5 test
  // would call it the SIMPLE api and assign the whole result object to
  // colorNode — a plain JS object as a node, which fails deep inside the
  // renderer with no usable error. Widening the test is what makes
  // "parts without a default" expressible at all.
  const hasParts =
    shaderResult &&
    typeof shaderResult === "object" &&
    shaderResult.parts &&
    typeof shaderResult.parts === "object";
  // 0.8: the same trap for `materialParts` (per glTF material index), which
  // 0.6 sends down the Simple-API branch — a near-black mesh, no error.
  const hasMaterialParts = !!(
    shaderResult &&
    typeof shaderResult === "object" &&
    shaderResult.materialParts &&
    typeof shaderResult.materialParts === "object"
  );
  const isObjectAPI = hasChannels(shaderResult) || hasParts || hasMaterialParts;

  // The default material stays null when the module declares only parts:
  // unmatched meshes then keep the materials the MODEL was authored with,
  // rather than being blanked by a material the shader never described.
  let material = null;
  let partMaterials = null;

  if (isObjectAPI) {
    if (hasChannels(shaderResult)) {
      material = buildMaterial(shaderResult);
    }
    if (hasParts) {
      partMaterials = new Map();
      // Own keys only, and a Map rather than the object itself: these
      // names come out of a dropped model file, so a mesh called
      // `toString` or `constructor` would otherwise resolve a FUNCTION
      // off Object.prototype and get it assigned as its material.
      // 0.8: a key listed in `materialPartsMirror` is a 0.6-only copy of a
      // materialParts entry, and it is NEVER a name claim here, in any status:
      // on a model the signature does not match it would paint unrelated
      // meshes that happen to share the name.
      const mirror = mirrorKeysOf(shaderResult);
      const names = Object.keys(shaderResult.parts);
      for (let i = 0; i < names.length; i++) {
        if (mirror.has(names[i])) continue;
        const spec = shaderResult.parts[names[i]];
        if (!hasChannels(spec)) continue;
        partMaterials.set(names[i], buildMaterial(spec));
      }
      if (partMaterials.size === 0) {
        partMaterials = null;
      }
    }
  } else {
    // Simple API: return a single node (backward compatible)
    material = new (T().MeshPhysicalNodeMaterial)();
    material.colorNode = shaderResult;
  }
  return { material: material, partMaterials: partMaterials, hasMaterialParts: hasMaterialParts };
}

// ---------------------------------------------------------------------------
// (8) Dispatch, over a state object (the A-Frame component passes itself)
// ---------------------------------------------------------------------------

function storeOriginalMaterials(state, mesh) {
  mesh.traverse(function (node) {
    if (node.isMesh && !(node.uuid in state.originalMaterials)) {
      // Never record a transient editor highlight as a mesh's "original".
      // Defence rather than a fix for an observed path — this runs at
      // model-loaded, before any highlight can exist, and skips uuids it
      // already holds — but capturing one would be permanent and silent.
      const m = node.material;
      if (m && m.userData && m.userData.__fsHighlight) return;
      state.originalMaterials[node.uuid] = m;
    }
  });
}

// The seam for per-glTF-material parts: a resolver on the state maps a mesh to
// the material its glTF material index should wear. applyResult sets one only
// when a `materialParts` table applies (resolveMaterialParts, section 13a);
// otherwise it is null and dispatch is exactly 0.6's.
function resolveIndexPart(state, node) {
  var r = state._indexPartResolver;
  return typeof r === "function" ? r(node) || null : null;
}

function applyMaterialToMesh(state, mesh, material, partMaterials) {
  // Records what each mesh actually ended up with, keyed by uuid. The editor
  // preview's mesh HIGHLIGHT reads this to put a mesh back: it must restore
  // the PART material a targeted mesh is wearing, not the default, and it
  // must never hold a material reference of its own across an apply (the
  // outgoing material is disposed before the new one is assigned).
  const applied = {};
  // Single-mesh fallback for a parts-only module. All three conditions are
  // load-bearing:
  //   - parts, no default: with a default the unmatched mesh already has a
  //     material the shader described, and taking a part instead would
  //     silently ignore what the author wrote at the top level.
  //   - EXACTLY ONE mesh in the model: a multi-mesh model whose meshes match
  //     nothing must keep its AUTHORED materials (the KHR_materials_variants
  //     fallback above) — repainting those would silently restyle a model
  //     the shader never claimed. With one mesh there is no choice to make:
  //     "no name matched" can only be a naming mismatch (the shader was
  //     authored against a different model, or the glTF loader renamed the
  //     mesh), and leaving the one mesh unshaded reads as the shader having
  //     failed to load.
  //   - The FIRST part in ITERATION ORDER, which is the emitted source order
  //     (Object.keys → an insertion-ordered Map above), so the choice is
  //     deterministic and is the entry the editor lists first.
  // A module WITHOUT parts never reaches this: partMaterials is null.
  let soleMeshFallback = null;
  if (partMaterials && !material) {
    let meshCount = 0;
    mesh.traverse(function (node) {
      if (node.isMesh) meshCount++;
    });
    if (meshCount === 1) {
      const first = partMaterials.values().next();
      soleMeshFallback = first.done ? null : first.value;
    }
  }
  // The ladder, per mesh: a NAME claim in `parts` > the index part
  // (resolveIndexPart) > the default material > the single-mesh first-part
  // fallback > the authored material.
  mesh.traverse(function (node) {
    if (!node.isMesh) return;
    let m = material;
    const named = partMaterials ? partMaterials.get(node.name) : undefined;
    if (named) {
      m = named;
    } else {
      const indexed = resolveIndexPart(state, node);
      if (indexed) {
        m = indexed;
      } else if (!material && (partMaterials || state._materialPartsStatus)) {
        // No default was declared: put this mesh back on the material the
        // MODEL was authored with rather than blanking it — unless this is
        // the model's only mesh, which takes the first part instead. A
        // materialParts module (any status) takes this rung even when no NAME
        // part survives: on a re-apply the mesh still wears the previous
        // shader's material, which has just been disposed. A module with
        // neither keeps 0.6's path (_materialPartsStatus is null then).
        m = soleMeshFallback || state.originalMaterials[node.uuid] || node.material;
      }
    }
    if (!m) return;
    node.material = m;
    applied[node.uuid] = m;
  });
  state._appliedMaterials = applied;
}

function restoreOriginalMaterials(state, mesh) {
  mesh.traverse(function (node) {
    if (node.isMesh && state.originalMaterials[node.uuid]) {
      node.material = state.originalMaterials[node.uuid];
    }
  });
}

function disposeShaderMaterial(state) {
  // HYGIENE, not leak prevention — say so, because a future reader will
  // otherwise "verify" this against a counter that never moves. MEASURED in
  // r184's node path over 6 re-applies on both backends: dispose() reclaimed
  // nothing (WebGL programs deleted: 0; WebGPU pipelines grew monotonically),
  // and the growth is already present in 0.5 with a single material. Parts
  // multiply the rate, so the surface that matters is a long-lived document
  // re-applying many times (podest's playlist), not the editor, which mints
  // a fresh iframe per edit.
  if (state._shaderMaterial) {
    state._shaderMaterial.dispose();
    state._shaderMaterial = null;
  }
  if (state._partMaterials) {
    state._partMaterials.forEach(function (m) {
      try {
        m.dispose();
      } catch (e) {
        /* a material three already released — nothing to do */
      }
    });
    state._partMaterials = null;
  }
  if (state._indexPartMaterials) {
    state._indexPartMaterials.forEach(function (m) {
      try {
        m.dispose();
      } catch (e) {
        /* as above */
      }
    });
  }
  state._indexPartMaterials = null;
  state._indexPartResolver = null;
  state._materialPartsStatus = null;
  state._appliedMaterials = null;
  // A src: model generation's image URLs die with the materials they fed (13c).
  releaseModelAssets(state);
}

// ---------------------------------------------------------------------------
// (9) The vertex weld and the barycentric corners
// ---------------------------------------------------------------------------

/*
 * Weld coincident vertices of a PRIMITIVE geometry so per-vertex displacement
 * stays continuous across faces.
 *
 * A BoxGeometry splits every face into its own 4 vertices (24 total) carrying
 * that face's normal, so normal-based displacement drives the 3 copies at each
 * corner along 3 DIFFERENT normals and the faces visibly separate. Merging
 * those copies and recomputing normals makes the surface deform as one skin.
 *
 * A group is merged when its members would receive DIFFERENT displacement,
 * which is the whole correctness of this function rather than an optimisation.
 * We cannot evaluate the shader on the CPU, so we test the two attributes that
 * can drive it apart:
 *
 *   - NORMALS DIFFER. A box's 3 copies at each corner carry 3 face normals, so
 *     normal-driven displacement pulls them apart. Always weld.
 *   - UVs DIFFER **and the shader reads uv()** (`uvDriven`). A sphere's u=0/u=1
 *     seam column and its pole fans are coincident with IDENTICAL normals but
 *     DIFFERENT UVs, so a uv-driven height splits them too.
 *
 * The `uvDriven` qualifier is what stops this welding a sphere for nothing.
 * MEASURED against three r184: a-sphere(36,18) has 19 coincident groups, 0 with
 * differing normals and 19 with differing UVs, the largest being a 37-vertex
 * POLE FAN collapsing 37 distinct u values into one; the 64x64 preview sphere
 * gives 65/0/65. A welded vertex can only keep ONE representative uv, so
 * merging those for a POSITION-driven shader smears the whole polar cap and
 * repairs nothing — measured, such a shader moves every member of a group by
 * exactly the same amount. a-box gives 8 groups, ALL with differing normals.
 *
 * So: a box always welds; a sphere welds only when the shader actually reads
 * uv (where the old always-weld behaviour was right and its UV cost is the
 * lesser evil against a cracked surface); a plane never has anything to weld.
 *
 * Returns a NEW BufferGeometry, or null when there was nothing to weld — the
 * caller then leaves the original alone, which is what keeps a no-op truly
 * free of side effects.
 *
 * Rebuilds with position/uv/index ONLY. That is why the caller must never run
 * this on a MODEL: it would drop vertex colours, skinIndex/skinWeight and
 * morphAttributes. Models are normalized (and welded) by `fit-bounds` instead.
 */
function weldByPosition(geom, uvDriven) {
  const pos = geom.attributes.position;
  const nor = geom.attributes.normal;
  if (!pos || !nor) return null;
  const uv = geom.attributes.uv;
  const oldIndex = geom.index;
  const precision = 1e4; // 4 decimal places

  // Pass 1 — group vertex ids by quantized position.
  const groups = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key =
      Math.round(pos.getX(i) * precision) + "_" +
      Math.round(pos.getY(i) * precision) + "_" +
      Math.round(pos.getZ(i) * precision);
    const g = groups.get(key);
    if (g) g.push(i); else groups.set(key, [i]);
  }

  // Pass 2 — a group is weldable when its members could displace apart: their
  // normals differ, or (for a shader that reads uv) their UVs do.
  const remap = new Uint32Array(pos.count);
  let next = 0;
  let welds = 0;
  for (const ids of groups.values()) {
    let differs = false;
    for (let a = 1; a < ids.length && !differs; a++) {
      const i = ids[0], j = ids[a];
      if (
        Math.abs(nor.getX(i) - nor.getX(j)) > 1e-6 ||
        Math.abs(nor.getY(i) - nor.getY(j)) > 1e-6 ||
        Math.abs(nor.getZ(i) - nor.getZ(j)) > 1e-6
      ) differs = true;
      else if (
        uvDriven && uv &&
        (Math.abs(uv.getX(i) - uv.getX(j)) > 1e-6 ||
         Math.abs(uv.getY(i) - uv.getY(j)) > 1e-6)
      ) differs = true;
    }
    if (differs) {
      const slot = next++;
      for (const i of ids) remap[i] = slot;
      welds++;
    } else {
      for (const i of ids) remap[i] = next++;
    }
  }
  if (welds === 0) return null;

  // Pass 3 — build the compacted attributes. The kept uv is the FIRST
  // occurrence, matching what the editor's weld-verts always did.
  const positions = new Float32Array(next * 3);
  const uvs = uv ? new Float32Array(next * 2) : null;
  const seen = new Uint8Array(next);
  for (let i = 0; i < pos.count; i++) {
    const slot = remap[i];
    if (seen[slot]) continue;
    seen[slot] = 1;
    positions[slot * 3] = pos.getX(i);
    positions[slot * 3 + 1] = pos.getY(i);
    positions[slot * 3 + 2] = pos.getZ(i);
    if (uvs) {
      uvs[slot * 2] = uv.getX(i);
      uvs[slot * 2 + 1] = uv.getY(i);
    }
  }

  const count = oldIndex ? oldIndex.count : pos.count;
  const indices = next > 65535 ? new Uint32Array(count) : new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    indices[i] = remap[oldIndex ? oldIndex.getX(i) : i];
  }

  // 0.8: the bound three instance (see T()), resolved only once there is work.
  const THREE = T();
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  if (uvs) merged.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  merged.computeVertexNormals();
  return merged;
}

// three's own primitive geometry types. A plain three.js mesh wearing one of
// these is what an A-Frame primitive is (el.components.geometry), so the weld
// gate can be answered structurally without A-Frame.
var PRIMITIVE_GEOMETRY_TYPES = [
  "BoxGeometry",
  "SphereGeometry",
  "PlaneGeometry",
  "CircleGeometry",
  "ConeGeometry",
  "CylinderGeometry",
  "RingGeometry",
  "TorusGeometry",
  "TorusKnotGeometry",
  "CapsuleGeometry",
  "DodecahedronGeometry",
  "IcosahedronGeometry",
  "OctahedronGeometry",
  "TetrahedronGeometry",
  "PolyhedronGeometry",
];

function isPrimitiveMesh(o) {
  return !!(
    o &&
    o.isMesh &&
    o.geometry &&
    PRIMITIVE_GEOMETRY_TYPES.indexOf(o.geometry.type) !== -1
  );
}

/*
 * Should this geometry be welded for the shader just applied?
 *
 * Three gates, in cost order, each load-bearing:
 *
 *  1. PRIMITIVES ONLY (`isPrimitive`). In A-Frame, `el.components.geometry`
 *     exists exactly when A-Frame's geometry system built this mesh
 *     (<a-sphere>/<a-box>/<a-plane>, or an explicit geometry attribute); a
 *     MODEL entity carries gltf-model / obj-model instead. On a plain three.js
 *     page it is a mesh whose geometry.type is a three primitive, or an
 *     explicit `weld: true`. Welding a model would be DESTRUCTIVE, not merely
 *     redundant: weldByPosition rebuilds with position/uv/index only, so it
 *     would drop `color` (vertex colours), skinIndex/skinWeight and
 *     morphAttributes — breaking every skinned or morph-target clip.
 *
 *  2. THE AUTHOR'S CHOICE. `mergeVertices: false` in the module's return
 *     object means the author unticked "Merge Vertices". ABSENT means weld,
 *     matching the editor's own `undefined === true` contract, which is what
 *     keeps every already-exported module byte-identical.
 *
 *  3. IT MUST ACTUALLY DISPLACE. `material.positionNode != null` — `!= null`
 *     and NOT `!== undefined`, because three's NodeMaterial constructor sets
 *     `this.positionNode = null`, so an `undefined` test is true for every
 *     material ever built and would weld every primitive shader. This is the
 *     one layer that holds the BUILT material, so the question is answered
 *     structurally instead of by a regex over module text; a `parts` module
 *     is covered by testing the part materials too.
 */
function shouldWeld(shaderResult, material, partMaterials, isPrimitive, indexMaterials) {
  if (!isPrimitive) return false;
  if (shaderResult && shaderResult.mergeVertices === false) return false;
  if (material && material.positionNode != null) return true;
  if (partMaterials) {
    for (const m of partMaterials.values()) {
      if (m && m.positionNode != null) return true;
    }
  }
  // Inert in practice (a materialParts table applies only to a glTF, and a
  // glTF is never a primitive), but the gate must not be able to miss one.
  if (indexMaterials) {
    for (const m of indexMaterials.values()) {
      if (m && m.positionNode != null) return true;
    }
  }
  return false;
}

/* Bring the mesh's geometry into line with `_weldWanted`. Idempotent. */
function syncWeld(state, mesh) {
  if (!mesh || !mesh.geometry) return;
  // Put every geometry we expanded back first. The weld's identity guards
  // ("is the mesh still wearing OUR geometry?") are written against the
  // system's geometry and ours, and a bary geometry sitting on top makes
  // both false — unweld would silently no-op and leak.
  unbary(state);
  if (!state._weldWanted) {
    unweld(state, mesh);
    return;
  }
  const current = mesh.geometry;
  // Already ours, or already known to have nothing to weld.
  if (current === state._welded || current === state._weldScanned) return;

  const merged = weldByPosition(current, state._weldUvDriven);
  if (!merged) {
    // Nothing to weld: leave the geometry EXACTLY as the system built it.
    // Drop ours first — the mesh is wearing a geometry we did not build, so
    // keeping `_welded` would leave the invariant ("the geometry WE built,
    // and the mesh is wearing it") false, and `_weldSource` pointing at a
    // geometry A-Frame's system has already disposed. Reached whenever a
    // weldable primitive is swapped for an unweldable one (a box → sphere
    // change from podest's geometry picker or the preview's subdivision).
    if (state._welded) {
      state._welded.dispose();
      state._welded = null;
      state._weldSource = null;
    }
    // Remembering it stops a re-apply rescanning a sphere every time.
    state._weldScanned = current;
    return;
  }
  if (state._welded && state._welded !== current) state._welded.dispose();
  state._weldSource = current;
  state._welded = merged;
  mesh.geometry = merged;
}

/* Put the system's own geometry back and drop ours. */
function unweld(state, mesh) {
  // Identity guard: only restore if the mesh is still wearing OUR geometry.
  // A-Frame's geometry `remove()` swaps in a shared empty BufferGeometry, and
  // putting `_weldSource` back over that would resurrect a disposed geometry.
  if (mesh && state._welded && mesh.geometry === state._welded && state._weldSource) {
    mesh.geometry = state._weldSource;
  }
  if (state._welded) state._welded.dispose();
  state._welded = null;
  state._weldSource = null;
}

/**
 * Give every mesh in the subtree a per-corner `bary` attribute — (1,0,0),
 * (0,1,0), (0,0,1) around each triangle — so a shader can measure its
 * distance to the nearest EDGE. Neither backend exposes barycentrics
 * (WGSL has none; the GLSL extension is desktop-only), and an indexed mesh
 * shares corners between triangles, so the geometry has to carry them.
 *
 * Runs over the whole subtree, so it covers models as well as primitives —
 * unlike the weld, which is primitives-only because it REBUILDS with
 * position/uv/index and would drop skinning and morph targets.
 * `toNonIndexed` has no such problem: it expands every attribute, every
 * morph target and the groups, so a skinned or morphing model survives it.
 */
function syncBary(state, mesh) {
  if (!mesh) return;
  if (!state._baryWanted) {
    unbary(state);
    return;
  }
  const owned = state._baryOwned || (state._baryOwned = []);
  mesh.traverse(function (node) {
    if (!node.isMesh || !node.geometry) return;
    const g = node.geometry;
    if (g.getAttribute("bary")) return; // already ours, or authored
    // A geometry with no positions cannot describe a triangle, and asking it
    // for one throws INSIDE the apply — which surfaces as a "Shader
    // error" banner over a shader that is otherwise fine. Reachable while a
    // geometry is being swapped: A-Frame's geometry component puts a shared
    // EMPTY BufferGeometry on the mesh between remove() and update().
    const pos = g.getAttribute("position");
    if (!pos || pos.count < 3) return;
    const expanded = g.index ? g.toNonIndexed() : g.clone();
    const count = expanded.getAttribute("position").count;
    const bary = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) bary[i * 3 + (i % 3)] = 1;
    expanded.setAttribute("bary", new (T().BufferAttribute)(bary, 3));
    // The source is remembered on the NODE, not in one state-level slot:
    // a model is many meshes and each has its own geometry to restore.
    node.userData.__fsBarySource = g;
    node.geometry = expanded;
    owned.push({ node: node, geometry: expanded });
  });
}

/* Put each mesh's own geometry back and drop ours. */
function unbary(state) {
  const owned = state._baryOwned;
  if (!owned || owned.length === 0) return;
  for (const entry of owned) {
    const node = entry.node;
    // Identity guard, mirroring unweld's: only restore if the mesh is still
    // wearing the geometry WE built. A newer apply, a geometry swap or a
    // model reload may have replaced it, and putting a stale source back
    // would resurrect a geometry the system has already disposed.
    if (node.geometry === entry.geometry && node.userData.__fsBarySource) {
      node.geometry = node.userData.__fsBarySource;
    }
    delete node.userData.__fsBarySource;
    entry.geometry.dispose();
  }
  state._baryOwned = [];
}

// ---------------------------------------------------------------------------
// (10) The three revision
// ---------------------------------------------------------------------------

var warned = Object.create(null);

function warnOnce(key, msg) {
  if (warned[key]) return;
  warned[key] = 1;
  console.warn(msg);
}

var REVISION_RE = /^\d{1,4}$/;

// WARN-ONLY, never a refusal: a newer three usually still runs the shader, and
// a shader that does not compile says so on its own. Each (declared, actual)
// pair warns once. A value that is not 1–4 digits is ignored and never
// printed — a module's `threeRevision` is text out of someone's file.
function checkThreeRevision(declared) {
  var t = threeOrNull();
  var rev = t && t.REVISION != null ? String(t.REVISION) : "";
  if (!REVISION_RE.test(rev)) rev = "";
  if (rev && rev !== THREE_REVISION) warnOnce("loader>" + rev, warnLoaderRev(rev));
  if (!rev || (typeof declared !== "string" && typeof declared !== "number")) return;
  var d = String(declared);
  if (!REVISION_RE.test(d)) return;
  if (d !== rev) warnOnce("module:" + d + ">" + rev, warnModuleRev(d, rev));
}

// ---------------------------------------------------------------------------
// (11) The shared pipeline
// ---------------------------------------------------------------------------
//
// ONE apply for the A-Frame component and for plain three.js, in 0.6's order:
// schema → uniforms → map defaults → onUniforms → call the default export →
// build → dispose the previous materials → dispatch → weld → bary. `hooks`:
//   isPrimitive          may the geometry be welded (see shouldWeld)
//   isGltf               is the target a glTF model (A-Frame: the entity has a
//                        gltf-model component; plain: not a primitive), which
//                        decides whether a materialParts table is looked up
//   loadMap(name, raw)   the map loader bound to the caller's adapter
//   onUniforms(u, s)     A-Frame: extendSchema + attribute values; plain:
//                        opts.values
function applyResult(state, mesh, loaded, hooks) {
  hooks = hooks || {};
  const mod = loaded && loaded.module;
  checkThreeRevision(mod && mod.threeRevision);
  const source = (loaded && loaded.source) || "";
  const shaderExport = mod && mod.default;

  // Read schema for property uniforms and create TSL uniform nodes.
  // If no explicit schema is exported, auto-detect params.XXX usage
  // in the source code so hand-written modules work without boilerplate.
  let schema = mod && mod.schema;
  if (!schema || typeof schema !== "object" || Object.keys(schema).length === 0) {
    schema = autoDetectSchema(source);
  }
  const uniforms = makeParams(schema);
  state._propertyUniforms = uniforms;

  // Kick off loads for non-empty map defaults ('' means no default;
  // '#someId' or a URL loads). Done AFTER _propertyUniforms is assigned
  // so the async load callback can find its uniform node.
  if (hooks.loadMap) {
    for (const [name, def] of Object.entries(schema)) {
      if (
        def &&
        def.type === "map" &&
        typeof def.default === "string" &&
        def.default !== ""
      ) {
        hooks.loadMap(name, def.default);
      }
    }
  }

  if (hooks.onUniforms) {
    hooks.onUniforms(uniforms, schema);
  }

  const shaderResult = callShader(shaderExport, uniforms);
  const built = buildMaterials(shaderResult);
  // Per glTF material: ONE material per applied index, built by the same
  // buildMaterial as the default and every part, and shared by every mesh of
  // that glTF material (one program per geometry layout).
  const mp = resolveMaterialParts(shaderResult, mesh, !!hooks.isGltf);
  let indexMaterials = null;
  if (mp.status === "applied" && mp.entries.length > 0) {
    indexMaterials = new Map();
    for (const [index, spec] of mp.entries) {
      indexMaterials.set(index, buildMaterial(spec));
    }
  }

  disposeShaderMaterial(state);
  state._shaderMaterial = built.material;
  state._partMaterials = built.partMaterials;
  state._indexPartMaterials = indexMaterials;
  state._indexPartResolver = indexMaterials ? indexPartResolver(mp.record, indexMaterials) : null;
  // null when the module carries no materialParts; the component emits it as
  // `shader-material-parts`, a plain Binding exposes it as `materialParts`.
  state._materialPartsStatus = mp.detail;
  applyMaterialToMesh(state, mesh, built.material, built.partMaterials);
  // Weld coincident vertices when this shader DISPLACES a primitive. Kept
  // out of applyMaterialToMesh so that keeps 0.6's exact dispatch shape.
  state._weldWanted = shouldWeld(
    shaderResult,
    built.material,
    built.partMaterials,
    !!hooks.isPrimitive,
    indexMaterials,
  );
  // A shader that reads uv() can displace a sphere's seam and pole fans
  // apart despite their shared normals, so those groups must weld too.
  // Read off the SOURCE because the built material cannot be asked.
  state._weldUvDriven = /\buv\s*\(/.test(source);
  syncWeld(state, mesh);
  // Barycentric corners for a wireframe shader's EDGES mode. AFTER the
  // weld, and that order is the correctness of it: welding makes the
  // coincident corners share one vertex (so a displacement moves them
  // together), and toNonIndexed then copies that shared vertex's values
  // into each corner — identical position, normal and uv — so the surface
  // still deforms as one skin. Doing it the other way round would split
  // first and weld nothing.
  state._baryWanted = !!(shaderResult && shaderResult.barycentric === true);
  syncBary(state, mesh);
  return shaderResult;
}

// ---------------------------------------------------------------------------
// (12) Plain three.js: apply → Binding
// ---------------------------------------------------------------------------

function fnText(f) {
  return typeof f === "function" ? Function.prototype.toString.call(f) : "";
}

// What apply() accepts: what load() returned; a module namespace (or any object
// with a `default`); the default export itself. Without load() only the
// default export's own text is known, which is what the schema auto-detect and
// the uv weld test then read (opts.source overrides it).
function normalizeInput(input, opts) {
  if (
    input &&
    typeof input === "object" &&
    input.module &&
    typeof input.module === "object" &&
    typeof input.source === "string"
  ) {
    return {
      module: input.module,
      source: input.source,
      url: typeof input.url === "string" ? input.url : opts.url || null,
    };
  }
  if (typeof input === "function") {
    return { module: { default: input }, source: opts.source || fnText(input), url: opts.url || null };
  }
  if (input && typeof input === "object" && "default" in input) {
    return { module: input, source: opts.source || fnText(input.default), url: opts.url || null };
  }
  if (input === undefined || input === null) {
    throw new TypeError(ERR_APPLY_INPUT);
  }
  // A bare node (or anything else) is the Simple API's return value itself.
  return { module: { default: input }, source: opts.source || "", url: opts.url || null };
}

// apply(target, loaded | moduleNamespace | defaultExport, opts) → Binding.
// opts: { values, source, url, weld: 'auto' (default) | true | false,
//         textures: an adapter (see loadMapInto) }.
// Synchronous. It throws on failure, and puts the target back first.
function apply(target, input, opts) {
  opts = opts || {};
  if (!target || typeof target.traverse !== "function") {
    throw new TypeError(ERR_APPLY_TARGET);
  }
  const loaded = normalizeInput(input, opts);
  // A fresh state per apply, with the component's field names.
  const state = {
    originalMaterials: {},
    _shaderMaterial: null,
    _partMaterials: null,
    _appliedMaterials: null,
    _propertyUniforms: null,
    _weldWanted: false,
    _welded: null,
    _weldSource: null,
    _weldScanned: null,
    _weldUvDriven: false,
    _baryWanted: false,
    _baryOwned: [],
    _texCache: null,
    _mapRequests: null,
    _texPending: null,
    _indexPartMaterials: null,
    _indexPartResolver: null,
    _materialPartsStatus: null,
    // src: model image URLs this binding owns (13c); apply() itself never adopts.
    _modelAssetUrls: null,
    _disposed: false,
  };
  const adapter = opts.textures || plainTextureAdapter(state);
  const loadMap = function (n, v) {
    return loadMapInto(state, n, v, adapter);
  };
  storeOriginalMaterials(state, target);
  const isPrimitive =
    opts.weld === true ? true : opts.weld === false ? false : isPrimitiveMesh(target);
  try {
    applyResult(state, target, loaded, {
      isPrimitive: isPrimitive,
      // A three primitive is never a glTF (quiet not-gltf); anything else is
      // looked up in the glTF plugin's records (a miss warns no-record).
      isGltf: !isPrimitiveMesh(target),
      loadMap: loadMap,
      onUniforms: function (u) {
        if (opts.values && typeof opts.values === "object") {
          for (const k of Object.keys(opts.values)) {
            setUniformValue(u, k, opts.values[k], loadMap);
          }
        }
      },
    });
  } catch (error) {
    // The target goes back exactly as it was: its own materials, and no
    // geometry of ours (unbary FIRST, for the reason syncWeld does it).
    restoreOriginalMaterials(state, target);
    disposeShaderMaterial(state);
    state._weldWanted = false;
    state._baryWanted = false;
    unbary(state);
    unweld(state, target);
    throw error;
  }
  return Object.freeze({
    target: target,
    module: loaded.module,
    source: loaded.source,
    url: loaded.url,
    state: state,
    get uniforms() {
      return state._propertyUniforms;
    },
    get material() {
      return state._shaderMaterial;
    },
    get parts() {
      return state._partMaterials;
    },
    get applied() {
      return state._appliedMaterials;
    },
    // { status, applied, dropped, expected, found } for a module carrying
    // materialParts, else null (see resolveMaterialParts).
    get materialParts() {
      return state._materialPartsStatus;
    },
    // Set one property uniform: a number, a colour ('#33ccff', a THREE.Color)
    // or, for a map, a Texture, an element or a URL. false for a name the
    // shader does not declare.
    set: function (name, value) {
      if (state._disposed) return false;
      return setUniformValue(state._propertyUniforms, name, value, loadMap);
    },
    // Put the target back (its own materials and geometry) and release what
    // this apply built. A second call does nothing.
    dispose: function () {
      if (state._disposed) return;
      state._disposed = true;
      restoreOriginalMaterials(state, target);
      disposeShaderMaterial(state);
      state._weldWanted = false;
      state._weldScanned = null;
      state._baryWanted = false;
      unbary(state);
      unweld(state, target);
      state._texCache = null;
      state._mapRequests = null;
      state._texPending = null;
      state._propertyUniforms = null;
    },
  });
}

// ---------------------------------------------------------------------------
// (13a) glTF: the parse record, materialParts, the embedded-image stash
// ---------------------------------------------------------------------------
//
// A module may shade by glTF MATERIAL INDEX instead of mesh name:
//   { materialParts: { "<index>": spec }, modelSignature: { materials: [names] },
//     parts: { … }, materialPartsMirror: [names] }
// After a parse the only thing that knows which glTF material a mesh came from
// is GLTFLoader's `parser.associations`, and A-Frame's gltf-model throws the
// parser (and gltf.userData, root extras included) away. So a GLTFLoader
// plugin records it in `afterRoot`, which GLTFLoader awaits before onLoad: the
// record exists by `model-loaded`. It lives in the WeakMaps below and NEVER in
// userData — userData is JSON-copied on clone and GLTFExporter writes it back
// out as `extras`, so a re-export would carry a stale index.
//
// src/engine/materialPartsContract.ts restates the key names and the bounds
// below for the app, and a test pins the two to each other.

var GLTF_PLUGIN_NAME = "FASTSHADERS_parse_record";
// Resource bounds, not the editor's section cap (which must stay at or below).
var MATERIAL_PARTS_MAX = 256;
var SIGNATURE_MATERIALS_MAX = 1024;
var SIGNATURE_NAME_MAX = 1024;
var MIRROR_KEYS_MAX = 1024;
// Canonical decimal indices only: "01", "-1", "1.0" and " 1" never match.
var MATERIAL_PART_KEY_RE = /^(0|[1-9][0-9]{0,3})$/;
var EMBED_ASSETS_MAX = 64;
var EMBED_ASSET_BYTES_MAX = 16777216;
var EMBED_TOTAL_BYTES_MAX = 67108864;
// A superset of the editor's `fs-asset:` key (src/engine/imageAssets.ts).
var EMBED_KEY_RE = /^[A-Za-z0-9_-]{1,80}$/;
// The `shader` src value that means "the module inside this entity's own
// model" (header delta 9). === src/engine/glbShaderContract.ts MODEL_SRC.
var MODEL_SRC = "model";
// The single-GLB module (section 13c). Each literal below is text-pinned to
// src/engine/glbShaderContract.ts, so keep every one on its own line:
// the format version, the module view's mimeType, the view's byte cap, and
// the image placeholder regex (=== the editor's imageAssets placeholder).
var FS_FORMAT = 1;
var MODULE_MIME = "text/javascript";
var EMBED_MODULE_BYTES_MAX = 16777216;
var MODEL_PLACEHOLDER_RE = /"fs-asset:([^"]+)"/g;
// ONE flag on gltf-model's prototype, shared by every copy of this file on the
// page (Symbol.for is agent-wide), so the init is wrapped exactly once.
var GLTF_MODEL_HOOK = Symbol.for("fastshaders.gltfModelHook");

function hasBytes(u8, at, sig) {
  if (u8.length < at + sig.length) return false;
  for (var i = 0; i < sig.length; i++) {
    if (u8[at + i] !== sig[i]) return false;
  }
  return true;
}
// mimeType → the file signature its bytes must start with.
var EMBED_MIME = new Map([
  ["image/png", function (b) { return hasBytes(b, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); }],
  ["image/jpeg", function (b) { return hasBytes(b, 0, [0xff, 0xd8, 0xff]); }],
  ["image/webp", function (b) { return hasBytes(b, 0, [0x52, 0x49, 0x46, 0x46]) && hasBytes(b, 8, [0x57, 0x45, 0x42, 0x50]); }],
]);

// scene root → { materialCount, materialNames, embedded } (one record object
// shared by every scene of one parse); mesh/points/line → { record, index }.
var RECORDS = new WeakMap();
var MATERIAL_INDEX = new WeakMap();

function isPlainObject(x) {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

// The raw glTF name, as GLTFLoader keeps it (materials are NOT uniquified, so
// duplicates are legal). An over-long name is recorded as null, which no
// signature name can equal; an absent or non-string name is ''.
function materialNameOf(def) {
  var name = isPlainObject(def) ? def.name : undefined;
  if (typeof name !== "string") return "";
  return name.length <= SIGNATURE_NAME_MAX ? name : null;
}

// The glTF material index an object was built from, or undefined. The MESH
// association comes first ({meshes, primitives} → that primitive's
// `material`): GLTFLoader gives Points and Lines a fresh material with no
// association of its own. The material association is the fallback, for the
// reverse gap (an EXT_mesh_gpu_instancing InstancedMesh keeps its material's
// association but not the mesh's). A primitive with no material has none.
function gltfMaterialIndex(parser, json, o, count) {
  var assoc = parser.associations;
  var a = assoc && assoc.get(o);
  if (a && Number.isInteger(a.meshes) && Number.isInteger(a.primitives)) {
    var meshDef = Array.isArray(json.meshes) ? json.meshes[a.meshes] : undefined;
    var prim = meshDef && Array.isArray(meshDef.primitives) ? meshDef.primitives[a.primitives] : undefined;
    var fromMesh = isPlainObject(prim) ? prim.material : undefined;
    if (Number.isInteger(fromMesh) && fromMesh >= 0 && fromMesh < count) return fromMesh;
  }
  if (assoc && o.material && !Array.isArray(o.material)) {
    var b = assoc.get(o.material);
    if (b && Number.isInteger(b.materials) && b.materials >= 0 && b.materials < count) return b.materials;
  }
  return undefined;
}

// The root `extras.fastshaders` object of a FastShaders GLB (format v:1), or
// null. `v` must be the NUMBER 1; every other key is optional — a single-GLB
// export (header delta 9) may carry a module and no images, and it is still a
// FastShaders file. Plain property reads only, never `in`: the object came out
// of someone's model file.
function fsExtrasOf(json) {
  var x = isPlainObject(json) ? json.extras : undefined;
  if (!isPlainObject(x) || !isPlainObject(x.fastshaders)) return null;
  return x.fastshaders.v === 1 ? x.fastshaders : null;
}
function isFsExtras(x) {
  return fsExtrasOf({ extras: x }) !== null;
}
// The format version of a FastShaders object this loader cannot read: an
// integer 2..999 (for the message), else null. Junk is never printed.
function fsFormatOf(json) {
  var x = isPlainObject(json) ? json.extras : undefined;
  var fs = isPlainObject(x) ? x.fastshaders : undefined;
  var v = isPlainObject(fs) ? fs.v : undefined;
  return Number.isInteger(v) && v >= 2 && v <= 999 ? v : null;
}

// The module view of a FastShaders GLB (`extras.fastshaders.module`), read the
// way the image stash reads its images and checked BEFORE any read: a plain
// view (no byteStride, target or extensions — GLTFLoader would DECODE a
// meshopt view) on the GLB BIN or a `data:` buffer (any other `uri` would make
// GLTFLoader FETCH it), 1..EMBED_MODULE_BYTES_MAX bytes, read back at exactly
// that length (GLTFLoader's slice clamps silently). Sets record.module (an
// ArrayBuffer) or record.moduleIssue (one closed reason) and never throws.
// Nothing is decoded, turned into a URL or imported here.
async function stashModule(parser, json, m, record) {
  var views = Array.isArray(json.bufferViews) ? json.bufferViews : [];
  var buffers = Array.isArray(json.buffers) ? json.buffers : [];
  if (!isPlainObject(m) || !Number.isInteger(m.bufferView) || m.bufferView < 0 || m.bufferView >= views.length) {
    record.moduleIssue = "not-a-bufferview";
    return;
  }
  if (m.mimeType !== MODULE_MIME) {
    record.moduleIssue = "wrong-type";
    return;
  }
  var bv = views[m.bufferView];
  if (
    !isPlainObject(bv) ||
    bv.byteStride !== undefined ||
    bv.target !== undefined ||
    bv.extensions !== undefined
  ) {
    record.moduleIssue = "compressed-view";
    return;
  }
  var buf = Number.isInteger(bv.buffer) && bv.buffer >= 0 ? buffers[bv.buffer] : undefined;
  var inFile = false;
  if (isPlainObject(buf)) {
    if (buf.uri === undefined) {
      inFile = bv.buffer === 0 && !!(parser.extensions && parser.extensions.KHR_binary_glTF);
    } else {
      inFile = typeof buf.uri === "string" && /^data:/i.test(buf.uri);
    }
  }
  if (!inFile) {
    record.moduleIssue = "external-buffer";
    return;
  }
  var len = bv.byteLength;
  if (!Number.isInteger(len) || len < 1) {
    record.moduleIssue = "empty";
    return;
  }
  if (len > EMBED_MODULE_BYTES_MAX) {
    record.moduleIssue = "too-large";
    return;
  }
  var ab;
  try {
    ab = await parser.getDependency("bufferView", m.bufferView);
  } catch (e) {
    record.moduleIssue = "unreadable";
    return;
  }
  // No instanceof: the ArrayBuffer may come from another realm.
  if (!ab || typeof ab.byteLength !== "number" || ab.byteLength !== len) {
    record.moduleIssue = "cut-short";
    return;
  }
  record.module = ab;
}

// Embedded FastShaders images (provisional schema, extended only additively):
//   extras.fastshaders = { v: 1, assets: { "<key>": <images index> } }
// Only bufferView images: a `uri` image is refused and never fetched. The
// bytes are whitelisted by mimeType, checked against the file signature and
// capped, and nothing is decoded or executed. → Map(key → { mime, bytes }) | null
async function stashEmbedded(parser, json, assets) {
  var images = Array.isArray(json.images) ? json.images : [];
  var views = Array.isArray(json.bufferViews) ? json.bufferViews.length : 0;
  var out = new Map();
  var total = 0;
  var considered = 0;
  var keys = Object.keys(assets);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    if (!EMBED_KEY_RE.test(key)) {
      console.warn(warnEmbedIgnored(key, "not a valid key"));
      continue;
    }
    if (considered >= EMBED_ASSETS_MAX) {
      console.warn(warnEmbedIgnored(key, "over the " + EMBED_ASSETS_MAX + "-image limit"));
      break;
    }
    considered++;
    var idx = assets[key];
    var img = Number.isInteger(idx) && idx >= 0 && idx < images.length ? images[idx] : undefined;
    if (!isPlainObject(img)) {
      console.warn(warnEmbedIgnored(key, "no such image"));
      continue;
    }
    if (img.uri !== undefined || !Number.isInteger(img.bufferView) || img.bufferView < 0 || img.bufferView >= views) {
      console.warn(warnEmbedIgnored(key, "not a bufferView image"));
      continue;
    }
    var check = typeof img.mimeType === "string" ? EMBED_MIME.get(img.mimeType) : undefined;
    if (!check) {
      console.warn(warnEmbedIgnored(key, "unsupported type"));
      continue;
    }
    var buf;
    try {
      buf = await parser.getDependency("bufferView", img.bufferView);
    } catch (e) {
      buf = null;
    }
    var len = buf && typeof buf.byteLength === "number" ? buf.byteLength : -1;
    if (len < 0) {
      console.warn(warnEmbedIgnored(key, "not a bufferView image"));
      continue;
    }
    if (len > EMBED_ASSET_BYTES_MAX) {
      console.warn(warnEmbedIgnored(key, "over " + EMBED_ASSET_BYTES_MAX / 1048576 + " MB"));
      continue;
    }
    if (total + len > EMBED_TOTAL_BYTES_MAX) {
      console.warn(warnEmbedIgnored(key, "over " + EMBED_TOTAL_BYTES_MAX / 1048576 + " MB in total"));
      continue;
    }
    if (!check(new Uint8Array(buf, 0, Math.min(len, 16)))) {
      console.warn(warnEmbedIgnored(key, "wrong file signature"));
      continue;
    }
    total += len;
    out.set(key, { mime: img.mimeType, bytes: buf });
  }
  return out.size > 0 ? out : null;
}

// afterRoot. Never throws and never rejects — GLTFLoader turns a rejection
// into the MODEL's load error, and indexing must never be why a model fails.
// It never mutates the model either.
function recordParse(parser, result) {
  var json;
  var record;
  try {
    json = parser.json;
    var mats = Array.isArray(json.materials) ? json.materials : [];
    // module/moduleIssue/moduleBase/fsFormat: the single-GLB module (13c).
    // gltfRecord() copies out only the count and the names.
    record = {
      materialCount: mats.length,
      materialNames: [],
      embedded: null,
      module: null,
      moduleIssue: null,
      moduleBase: "",
      fsFormat: null,
    };
    var n = Math.min(mats.length, SIGNATURE_MATERIALS_MAX);
    for (var i = 0; i < n; i++) record.materialNames.push(materialNameOf(mats[i]));
    var scenes = Array.isArray(result.scenes) ? result.scenes : [];
    for (var s = 0; s < scenes.length; s++) {
      var scene = scenes[s];
      if (!scene || typeof scene.traverse !== "function") continue;
      scene.traverse(function (o) {
        if (!(o.isMesh || o.isPoints || o.isLine)) return;
        var index = gltfMaterialIndex(parser, json, o, record.materialCount);
        if (index !== undefined) MATERIAL_INDEX.set(o, { record: record, index: index });
      });
      RECORDS.set(scene, record);
    }
  } catch (e) {
    console.warn(warnIndexFailed(e));
    return Promise.resolve();
  }
  var assets = null;
  var moduleEntry;
  try {
    // The stash runs only for an `assets` map; a module-only FastShaders GLB
    // (no `assets` key) is still recognised and simply has nothing to stash.
    var fx = fsExtrasOf(json);
    if (fx && isPlainObject(fx.assets)) assets = fx.assets;
    if (fx) moduleEntry = fx.module;
    else record.fsFormat = fsFormatOf(json);
    var base = parser.options && parser.options.path;
    record.moduleBase = typeof base === "string" ? base.slice(0, 2048) : "";
  } catch (e) {
    console.warn(warnIndexFailed(e));
  }
  if (!assets && moduleEntry === undefined) return Promise.resolve();
  var stashed = assets
    ? stashEmbedded(parser, json, assets).then(
        function (map) {
          record.embedded = map;
        },
        function (e) {
          console.warn(warnIndexFailed(e));
        },
      )
    : Promise.resolve();
  if (moduleEntry === undefined) return stashed;
  return stashed.then(function () {
    return stashModule(parser, json, moduleEntry, record).then(undefined, function () {
      record.module = null;
      record.moduleIssue = "unreadable";
    });
  });
}

// The plugin: ONE function identity for the page, so GLTFLoader.register()
// (which dedupes by identity) can be called from every path that wants it.
function gltfPlugin(parser) {
  return {
    name: GLTF_PLUGIN_NAME,
    afterRoot: function (result) {
      return recordParse(parser, result);
    },
  };
}

function registerPlugin(loader) {
  if (loader && typeof loader.register === "function") loader.register(gltfPlugin);
}

// Everything this file puts on one gltf-model component's GLTFLoader. Called by
// the prototype hook, the evaluation-time sweep, and the shader component.
function attachGltfModel(comp) {
  if (!comp) return;
  registerPlugin(comp.loader);
  // …and the glTF decoders (13b). A decoder problem must never break a
  // model's init: the model's own parse reports it.
  try {
    var data = comp.system && comp.system.data;
    installDecoders(comp.loader, {
      dracoDecoderPath: data ? data.dracoDecoderPath : undefined,
      // KTX2 needs the RENDERER to pick a GPU format, and it is read LAZILY
      // (13b-KTX2): at init the scene may have none yet, and on the WebGPU
      // path the one it gets is not usable until its init() resolves.
      getRenderer: function () {
        var el = comp.el;
        return (el && el.sceneEl && el.sceneEl.renderer) || null;
      },
    });
  } catch (e) {
    /* see above */
  }
}

// Wrap A-Frame's gltf-model init ONCE, when this file is evaluated. gltf-model
// builds its GLTFLoader in init and loads only in update, behind
// `this.ready.then(…)`, so registering right after the original init is
// before anything is parsed. Registering from the shader component alone
// loses the race whenever the MODEL initialises first — the preview's model
// feed, a gltf-model in markup with the shader attached after boot, podest's
// drops in either order — and componentinitialized does not bubble, so no
// scene-level listener can catch it. Nothing re-parses a model.
function installGltfModelHook(AF) {
  try {
    var entry = AF.components && AF.components["gltf-model"];
    var proto = entry && entry.Component && entry.Component.prototype;
    if (!proto || typeof proto.init !== "function") {
      warnOnce("gltf-hook", WARN_GLTF_HOOK);
    } else if (!proto[GLTF_MODEL_HOOK]) {
      var init = proto.init;
      proto.init = function () {
        var r = init.apply(this, arguments);
        attachGltfModel(this);
        return r;
      };
      Object.defineProperty(proto, GLTF_MODEL_HOOK, { value: true });
    }
  } catch (e) {
    warnOnce("gltf-hook", WARN_GLTF_HOOK);
  }
  // …and the gltf-model components that initialised before this file ran.
  try {
    var doc = root.document;
    if (doc && typeof doc.querySelectorAll === "function") {
      var els = doc.querySelectorAll("[gltf-model]");
      for (var i = 0; i < els.length; i++) {
        attachGltfModel(els[i] && els[i].components && els[i].components["gltf-model"]);
      }
    }
  } catch (e) {
    /* no document to sweep */
  }
}

// The record of `o` or of its nearest recorded ancestor (a model's scene root).
function recordFor(o) {
  for (var i = 0; i < 64 && o && typeof o === "object"; i++, o = o.parent) {
    var r = RECORDS.get(o);
    if (r) return r;
  }
  return null;
}

function gltfRecord(root) {
  var r = recordFor(root);
  return r ? { materialCount: r.materialCount, materialNames: r.materialNames.slice() } : null;
}

function materialIndexOf(o) {
  var e = o && typeof o === "object" ? MATERIAL_INDEX.get(o) : undefined;
  return e ? e.index : undefined;
}

// What a module shading this model should carry as `modelSignature`. Accepts
// a GLTFLoader result or a scene root; null when there is no record or the
// model's materials cannot be written as a signature.
function modelSignature(x) {
  var target = x && typeof x === "object" && !x.isObject3D && x.scene ? x.scene : x;
  var r = recordFor(target);
  if (!r || r.materialCount > SIGNATURE_MATERIALS_MAX) return null;
  for (var i = 0; i < r.materialNames.length; i++) {
    if (r.materialNames[i] === null) return null;
  }
  return { materials: r.materialNames.slice() };
}

function embeddedAssets(root) {
  var r = recordFor(root);
  return r && r.embedded ? new Map(r.embedded) : null;
}

function releaseEmbedded(root) {
  var r = recordFor(root);
  if (r) r.embedded = null;
}

// The `parts` keys that are only 0.6 mirrors of materialParts entries. Always a
// Set; empty when the module lists none (or lists them malformed).
function mirrorKeysOf(shaderResult) {
  var set = new Set();
  var list = shaderResult && typeof shaderResult === "object" ? shaderResult.materialPartsMirror : undefined;
  if (!Array.isArray(list)) return set;
  var n = Math.min(list.length, MIRROR_KEYS_MAX);
  for (var i = 0; i < n; i++) {
    if (typeof list[i] === "string") set.add(list[i]);
  }
  return set;
}

// { materials: string[] } within the bounds, else null.
function validSignature(sig) {
  if (!sig || typeof sig !== "object") return null;
  var m = sig.materials;
  if (!Array.isArray(m) || m.length > SIGNATURE_MATERIALS_MAX) return null;
  var out = [];
  for (var i = 0; i < m.length; i++) {
    if (typeof m[i] !== "string" || m[i].length > SIGNATURE_NAME_MAX) return null;
    out.push(m[i]);
  }
  return { materials: out };
}

// Exact: the same count, and every name === in order. No trimming, no Unicode
// normalisation — another glTF also has materials 0, 1, 2.
function sameSignature(sig, record) {
  if (sig.materials.length !== record.materialCount) return false;
  for (var i = 0; i < sig.materials.length; i++) {
    if (sig.materials[i] !== record.materialNames[i]) return false;
  }
  return true;
}

// → { status, entries: [[index, spec]], mirror: Set, record, detail }.
// status 'none' (the module carries no materialParts: no event, no warning),
// 'not-gltf' (quiet), 'no-record', 'no-signature', 'invalid', 'mismatch' or
// 'applied'. Only 'applied' contributes entries; every other status leaves the
// name parts and the default to do what they do. The module is CODE, not data,
// so this is robustness against a hand-edited module, not a security gate.
function resolveMaterialParts(shaderResult, root, isGltf) {
  var mirror = mirrorKeysOf(shaderResult);
  var table = shaderResult && typeof shaderResult === "object" ? shaderResult.materialParts : undefined;
  if (!table || typeof table !== "object") {
    return { status: "none", entries: [], mirror: mirror, record: null, detail: null };
  }
  var listed = shaderResult.materialPartsMirror;
  if (listed !== undefined && listed !== null && !Array.isArray(listed)) console.warn(WARN_MP_MIRROR);
  var rawSig = shaderResult.modelSignature;
  var sig = validSignature(rawSig);
  var record = isGltf ? recordFor(root) : null;
  var entries = [];
  var dropped = 0;
  var status;
  if (!isGltf) {
    status = "not-gltf";
  } else if (!record) {
    status = "no-record";
    console.warn(WARN_MP_NO_RECORD);
  } else if (rawSig === undefined || rawSig === null) {
    status = "no-signature";
    console.warn(WARN_MP_NO_SIGNATURE);
  } else if (!sig) {
    status = "invalid";
    console.warn(WARN_MP_INVALID);
  } else if (!sameSignature(sig, record)) {
    status = "mismatch";
    console.warn(warnMpMismatch(sig.materials, record.materialCount, record.materialNames));
  } else {
    status = "applied";
    // Integer-like keys enumerate ascending, whatever the source order.
    var keys = Object.keys(table);
    for (var i = 0; i < keys.length; i++) {
      if (!MATERIAL_PART_KEY_RE.test(keys[i])) continue;
      var index = Number(keys[i]);
      if (index >= record.materialCount) continue;
      var spec = table[keys[i]];
      if (!hasChannels(spec)) continue;
      if (entries.length >= MATERIAL_PARTS_MAX) {
        dropped++;
        continue;
      }
      entries.push([index, spec]);
    }
    if (dropped > 0) console.warn(warnMpDropped(dropped));
  }
  return {
    status: status,
    entries: entries,
    mirror: mirror,
    record: record,
    detail: {
      status: status,
      applied: entries.length,
      dropped: dropped,
      expected: sig ? sig.materials.length : null,
      found: record ? record.materialCount : null,
    },
  };
}

// The resolver the dispatch seam calls (resolveIndexPart). An index counts only
// when it was recorded by the SAME parse whose signature matched, so meshes of
// another model parented under this one can never take this table's materials.
function indexPartResolver(record, indexMaterials) {
  return function (node) {
    var e = MATERIAL_INDEX.get(node);
    return e && e.record === record ? indexMaterials.get(e.index) || null : null;
  };
}

// ---------------------------------------------------------------------------
// (13b) Mesh decoders: Draco and meshopt for GLTFLoader
// ---------------------------------------------------------------------------
//
// (The KTX2 texture transcoder shares this section's configure/install and its
// file table; its own half is 13b-KTX2, below.)
//
// A Draco- or meshopt-compressed glTF loads only when its GLTFLoader carries a
// decoder. The decoder files are three r184's own (js/decoders/ beside this
// file: the glTF Draco build, meshopt 1.1, and the Basis Universal transcoder
// the KTX2 section below runs). install(loader) puts them on a loader, and
// attachGltfModel calls it for every A-Frame model before the model loads.
// Where the files come from is the page's call:
//   - by default, `decoders/<file>` beside THIS script's URL, when the script
//     was loaded over http(s): or tauri: (an export page on jsdelivr);
//   - configure({ resolve(fileName) -> url | null, importModule?, DRACOLoader?,
//     KTX2Loader?, LoadingManager?, renderer? }) lets the page answer per file
//     (the last two are the KTX2 section's). The sandboxed preview
//     answers with blob: URLs minted from bytes its trusted parent pushed.
//     Without resolve, the files are still found beside this script;
//   - configure(null) turns it off: install() does nothing, A-Frame keeps its
//     own Draco loader.
// Load-bearing rules:
//   1. Draco loads through a DEDICATED LoadingManager that maps only
//      `fs-decoder:/<one of FILES>` to the page's URL and anything else to
//      DECODER_MISSING. It never consults THREE.DefaultLoadingManager, so a
//      sandbox's blob:/data:-only allowlist there is never widened. The worker
//      never fetches: DRACOLoader hands it the wasm bytes in its init message.
//   2. A missing decoder FAILS, it never hangs. With no Draco source, install()
//      sets setDRACOLoader(null): GLTFLoader.parse then throws synchronously
//      and A-Frame's load() turns that into model-error. A-Frame's own loader
//      (gstatic) would hang in a sandbox, whose allowlist gives its fetch an
//      empty data: URL, so the worker is built from nothing and never answers.
//      For the same reason DECODER_MISSING is an unfetchable blob: URL, never
//      a data: URL.
//   3. Loader classes come from AFRAME.THREE first. On pages using the A-Frame
//      bundle, window.THREE is the BARE three namespace (the bundle's
//      build/entry.js assigns it after A-Frame built its enriched global), so
//      THREE.DRACOLoader is undefined there. A plain three.js page passes
//      DRACOLoader (three/addons/loaders/DRACOLoader.js) to configure();
//      LoadingManager comes from the three bound by use().
//   4. meshopt is a lazy shim, a fresh one per PARSE: the ES module (it ends
//      in `export`, so a classic <script> cannot load it) is imported on the
//      first decode, and one model's decoded bytes are capped BEFORE anything
//      is allocated. install() wraps the loader's parse() to swap in a new
//      shim, because the loader outlives the model: A-Frame's gltf-model keeps
//      one GLTFLoader across src changes, and a plain page reuses one. Draco has no such cap; its output is bounded by one worker's
//      2 GiB wasm heap (setWorkerLimit(1)).

var DECODER_FILES = Object.freeze({
  dracoWrapper: "draco_wasm_wrapper.js",
  dracoWasm: "draco_decoder.wasm",
  meshopt: "meshopt_decoder.module.js",
  basisJs: "basis_transcoder.js",
  basisWasm: "basis_transcoder.wasm",
});
var DECODER_NAMES = [
  DECODER_FILES.dracoWrapper,
  DECODER_FILES.dracoWasm,
  DECODER_FILES.meshopt,
  DECODER_FILES.basisJs,
  DECODER_FILES.basisWasm,
];
var DECODER_PREFIX = "fs-decoder:/";
var DECODER_MISSING = "blob:fs-decoder-missing";
var MAX_MESHOPT_DECODED_BYTES = 256 * 1024 * 1024;
// The largest byteStride EXT_meshopt_compression allows.
var MESHOPT_STRIDE_MAX = 256;
// What A-Frame 1.8's gltf-model system points its own DRACOLoader at.
var AFRAME_DRACO_DEFAULT = "https://www.gstatic.com/draco/versioned/decoders/1.5.7/";
// Marks a GLTFLoader install() has already equipped (agent-wide, like the hook).
var DECODERS_INSTALLED = Symbol.for("fastshaders.decoders");
// Marks a meshopt shim of ours, so a decoder the page set itself is never swapped.
var MESHOPT_SHIM = Symbol.for("fastshaders.meshoptShim");
// KTX2 (13b-KTX2). The plugin NAME is GLTFLoader's own key for the extension,
// which is what makes our plugin replace the builtin of the same name.
var KTX2_PLUGIN_NAME = "KHR_texture_basisu";
var KTX2_HEADER_BYTES = 80;
// Caps read off the header BEFORE a transcode. 8192 is the side a compressed
// target can hold; an uncompressed RGBA fallback allocates 4 bytes a texel, so
// it is held to 4096 (64 MB) instead. The uncompressed cap applies whenever the
// file CANNOT reach a compressed target — including a RAW texture (vkFormat is
// non-zero), which three sends straight to createRawTexture with no transcoder
// at all, so the GPU's formats are irrelevant to it.
var KTX2_MAX_SIDE_COMPRESSED = 8192;
var KTX2_MAX_SIDE_UNCOMPRESSED = 4096;
var KTX2_MAX_FILE_BYTES = 64 * 1024 * 1024;
var KTX2_MAX_LEVELS = 14;
// supercompressionScheme 1 = BasisLZ, which is ETC1S and nothing else.
var KTX2_SUPERCOMPRESSION_BASISLZ = 1;

// currentScript is only set while this file is being evaluated, so it is read
// now and never again.
var DECODER_SCRIPT_URL = (function () {
  try {
    var s = root.document && root.document.currentScript;
    var src = s && s.src;
    return typeof src === "string" ? src : "";
  } catch (e) {
    return "";
  }
})();

var decoderMode = "off";
// True while the resolver is the self-located default rather than the page's.
var decoderByDefault = false;
var decoderResolve = null;
var decoderImport = defaultDecoderImport;
var decoderCtors = null;
var sharedDracoLoader = null;
var meshoptModulePromise = null;
var decoderLastError = "";
// KTX2 state, all per document: one loader (one worker), one memoized ready,
// one formats snapshot, one stats counter, one console line.
var sharedKtx2Loader = null;
var ktx2ReadyPromise = null;
var ktx2FormatSnapshot = null;
var ktx2Stats = { transcoded: 0, fallbacks: 0, missing: 0 };
var ktx2Logged = false;
// A renderer a PLAIN-three page handed configure(), used when the install
// context has none (A-Frame's does: the scene's).
var configuredRenderer = null;

// `decoders/<file>` beside this script, when it was loaded over http(s): or
// tauri:, else null. It is also what configure() falls back to when the page
// passes no resolve of its own (a plain three.js page passing only DRACOLoader).
var selfResolve = /^(https?|tauri):/i.test(DECODER_SCRIPT_URL)
  ? function (f) {
      return new URL("decoders/" + f, DECODER_SCRIPT_URL).href;
    }
  : null;

if (selfResolve) {
  decoderMode = "manage";
  decoderByDefault = true;
  decoderResolve = selfResolve;
}

function defaultDecoderImport(url) {
  return import(url);
}

function mib(bytes) {
  return String(Math.round(bytes / 104857.6) / 10);
}

function reasonOf(e) {
  try {
    return e && typeof e.message === "string" && e.message ? e.message : String(e);
  } catch (err) {
    return "unknown error";
  }
}

// The page's URL for one of the three FILES, else null. Nothing else is ever
// resolved, and a resolver that throws or answers junk counts as no answer.
function decoderUrl(f) {
  if (DECODER_NAMES.indexOf(f) < 0 || typeof decoderResolve !== "function") return null;
  try {
    var u = decoderResolve(f);
    return typeof u === "string" && u !== "" ? u : null;
  } catch (e) {
    return null;
  }
}

function decoderCtor(name) {
  var c = decoderCtors && decoderCtors[name];
  if (typeof c === "function") return c;
  var af = root.AFRAME;
  c = af && af.THREE && af.THREE[name];
  if (typeof c === "function") return c;
  var t = threeOrNull();
  c = t && t[name];
  return typeof c === "function" ? c : null;
}

function configureDecoders(opts) {
  if (sharedDracoLoader) {
    try {
      sharedDracoLoader.dispose();
    } catch (e) {
      /* already torn down */
    }
    sharedDracoLoader = null;
  }
  // The KTX2 loader owns a worker and a blob: URL, so it is disposed too, and
  // everything derived from the renderer it detected support against is
  // forgotten: the memoized ready, the formats snapshot, the stats and the
  // one-time console line.
  if (sharedKtx2Loader) {
    try {
      sharedKtx2Loader.dispose();
    } catch (e) {
      /* already torn down */
    }
    sharedKtx2Loader = null;
  }
  ktx2ReadyPromise = null;
  ktx2FormatSnapshot = null;
  ktx2Stats = { transcoded: 0, fallbacks: 0, missing: 0 };
  ktx2Logged = false;
  configuredRenderer = null;
  meshoptModulePromise = null;
  decoderLastError = "";
  decoderByDefault = false;
  if (opts === null) {
    decoderMode = "off";
    decoderResolve = null;
    decoderCtors = null;
    return decoders;
  }
  var o = opts && typeof opts === "object" ? opts : {};
  decoderMode = "manage";
  decoderResolve = typeof o.resolve === "function" ? o.resolve : selfResolve;
  decoderImport = typeof o.importModule === "function" ? o.importModule : defaultDecoderImport;
  decoderCtors = {
    DRACOLoader: o.DRACOLoader,
    LoadingManager: o.LoadingManager,
    KTX2Loader: o.KTX2Loader,
  };
  configuredRenderer = o.renderer || null;
  return decoders;
}

// ONE DRACOLoader per document (one worker, one decoder fetch).
function sharedDraco() {
  if (sharedDracoLoader) return sharedDracoLoader;
  var Draco = decoderCtor("DRACOLoader");
  var Manager = decoderCtor("LoadingManager");
  if (!Draco || !Manager) {
    decoderLastError = ERR_DRACO_NO_CLASS;
    return null;
  }
  try {
    var manager = new Manager();
    manager.setURLModifier(function (url) {
      var s = String(url);
      var f = s.indexOf(DECODER_PREFIX) === 0 ? s.slice(DECODER_PREFIX.length) : "";
      return decoderUrl(f) || DECODER_MISSING;
    });
    sharedDracoLoader = new Draco(manager)
      .setDecoderPath(DECODER_PREFIX)
      .setDecoderConfig({ type: "wasm" })
      .setWorkerLimit(1);
  } catch (e) {
    sharedDracoLoader = null;
    decoderLastError = errDracoCreate(reasonOf(e));
  }
  return sharedDracoLoader;
}

// The meshopt decoder module, imported once per document; a failed import is
// forgotten so the next model can try again.
function meshoptModule() {
  if (meshoptModulePromise) return meshoptModulePromise;
  var p = new Promise(function (resolve) {
    var url = decoderUrl(DECODER_FILES.meshopt);
    if (!url) throw new Error("no meshopt decoder is configured");
    resolve(decoderImport(url));
  })
    .then(function (m) {
      var d = m && m.MeshoptDecoder;
      if (!d || d.supported !== true) throw new Error("the module has no supported MeshoptDecoder");
      return Promise.resolve(d.ready).then(function () {
        return d;
      });
    })
    .catch(function (e) {
      if (meshoptModulePromise === p) meshoptModulePromise = null;
      decoderLastError = errMeshoptLoad(reasonOf(e));
      throw new Error(decoderLastError);
    });
  meshoptModulePromise = p;
  return p;
}

// A NEW shim per parse (see perParseMeshopt), so the cap counts one model's bytes.
function meshoptShim() {
  var total = 0;
  var shim = {
    supported: true,
    ready: Promise.resolve(),
    decodeGltfBufferAsync: function (count, size, source, mode, filter) {
      if (
        !Number.isSafeInteger(count) || count <= 0 ||
        !Number.isSafeInteger(size) || size <= 0 || size > MESHOPT_STRIDE_MAX
      ) {
        decoderLastError = ERR_MESHOPT_MALFORMED;
        return Promise.reject(new Error(ERR_MESHOPT_MALFORMED));
      }
      total += count * size;
      if (total > MAX_MESHOPT_DECODED_BYTES) {
        decoderLastError = errMeshoptCap(total);
        return Promise.reject(new Error(decoderLastError));
      }
      return meshoptModule().then(function (d) {
        return d.decodeGltfBufferAsync(count, size, source, mode, filter);
      });
    },
  };
  Object.defineProperty(shim, MESHOPT_SHIM, { value: true });
  return shim;
}

// GLTFLoader.parse copies loader.meshoptDecoder into the parser's options at
// the start of every parse (load() and parseAsync() both go through it), so
// swapping a fresh shim in just before gives each parse, concurrent ones
// included, its own running total. Only OUR shim is swapped.
function perParseMeshopt(loader) {
  var parse = loader.parse;
  if (typeof parse !== "function") return;
  try {
    Object.defineProperty(loader, "parse", {
      configurable: true,
      writable: true,
      value: function () {
        var d = this.meshoptDecoder;
        if (d && d[MESHOPT_SHIM]) this.meshoptDecoder = meshoptShim();
        return parse.apply(this, arguments);
      },
    });
  } catch (e) {
    /* a frozen loader keeps one shim, and so one budget, for its life */
  }
}

// ---------------------------------------------------------------------------
// (13b-KTX2) KHR_texture_basisu: three's KTX2Loader behind a lazy shim
// ---------------------------------------------------------------------------
//
// A KTX2 texture is transcoded to whatever compressed format THIS GPU has, so
// the loader must know the renderer before it reads a byte — and three r184
// answers that only after `renderer.init()` has resolved (a WebGPURenderer's
// `hasFeature` THROWS before it). That is the trap this whole section is shaped
// around, and it is why the KTX2 loader cannot simply be built at install time:
//
//   - `detectSupport(renderer)` is called from a LAZY `ready()`, memoized per
//     document, that awaits `renderer.init()` first. init() is itself memoized
//     in r184, so this never re-initialises A-Frame's renderer. Do NOT hook
//     `renderstart` instead: A-Frame emits it before the renderer has finished
//     initialising on the WebGPU path.
//   - NEVER write A-Frame's gltf-model system `basisTranscoderPath`: its own
//     update() calls detectSupport BEFORE init and throws.
//   - The worker's config is FROZEN when the worker is created, so one document
//     gets one loader (setWorkerLimit(1)) and one snapshot. configure()
//     disposes it, because a new renderer may support different formats.
//
// Two more rules:
//
//   - The dedicated LoadingManager maps only the two basis file names and hands
//     EVERY other URL to THREE.DefaultLoadingManager.resolveURL. Unlike Draco's
//     manager (whose loader fetches decoder files and nothing else), this one
//     also fetches the texture IMAGE, so the page's own allowlist — in the
//     sandboxed preview, blob:/data: only — must keep governing it.
//   - The plugin is registered under the extension's own name, so it REPLACES
//     GLTFLoader's builtin in the plugin map while keeping its precedence slot
//     (`plugins[plugin.name] = plugin`, and re-assigning a key keeps its
//     position). Stock three has no fallback: its builtin lets a failed
//     transcode reject the whole texture even when the glTF gives a plain
//     PNG/JPEG `source` beside it. Ours falls back to that source and counts it.
//
// A page that resolves neither basis file gets NO ktx2Loader, which is stock
// fail-fast behaviour: a basisu-REQUIRED model reports GLTFLoader's own
// "setKTX2Loader must be called before loading KTX2 textures", and a
// basisu-USED one silently renders its fallback image.

// THREE.DefaultLoadingManager, or null. Read through AFRAME.THREE first, for
// the reason decoderCtor documents (window.THREE is the BARE namespace).
function defaultManager() {
  try {
    var af = root.AFRAME;
    var t = (af && af.THREE) || threeOrNull();
    return (t && t.DefaultLoadingManager) || null;
  } catch (e) {
    return null;
  }
}

// ONE KTX2Loader per document (one worker, one transcoder fetch).
function sharedKtx2() {
  if (sharedKtx2Loader) return sharedKtx2Loader;
  var Ktx2 = decoderCtor("KTX2Loader");
  var Manager = decoderCtor("LoadingManager");
  if (!Ktx2 || !Manager) {
    decoderLastError = ERR_KTX2_NO_CLASS;
    return null;
  }
  try {
    var manager = new Manager();
    manager.setURLModifier(function (url) {
      var s = String(url);
      var f = s.indexOf(DECODER_PREFIX) === 0 ? s.slice(DECODER_PREFIX.length) : "";
      if (f === DECODER_FILES.basisJs || f === DECODER_FILES.basisWasm) {
        return decoderUrl(f) || DECODER_MISSING;
      }
      // Anything else is the texture image: chain the page's own modifier.
      var dm = defaultManager();
      try {
        return dm && typeof dm.resolveURL === "function" ? dm.resolveURL(s) : s;
      } catch (e) {
        return s;
      }
    });
    sharedKtx2Loader = new Ktx2(manager).setTranscoderPath(DECODER_PREFIX).setWorkerLimit(1);
  } catch (e) {
    sharedKtx2Loader = null;
    decoderLastError = errKtx2Create(reasonOf(e));
  }
  return sharedKtx2Loader;
}

// The six booleans the worker config carries, under the names FORMAT_OPTIONS
// keys them by. Null until a renderer has been detected against.
function snapshotKtx2Formats(cfg) {
  var c = cfg || {};
  ktx2FormatSnapshot = {
    astc: !!c.astcSupported,
    bptc: !!c.bptcSupported,
    etc2: !!c.etc2Supported,
    s3tc: !!c.dxtSupported,
    etc1: !!c.etc1Supported,
    pvrtc: !!c.pvrtcSupported,
  };
}

// Can THIS file reach a compressed target at all? Decides which side cap
// applies. The supercompression scheme narrows the targets: MEASURED against
// r184's FORMAT_OPTIONS, the ASTC entry is `basisFormat: [UASTC]` with
// `priorityETC1S: Infinity`, so an ETC1S file can never become ASTC and on an
// astc-only GPU it falls to the if-less RGBA32 entry — 4 bytes a texel, the
// very allocation the uncompressed cap exists to refuse. UASTC keeps the full
// list. (UASTC_HDR narrows the same way — bptc or nothing — but its marker
// lives in the DFD, not in the 80-byte header, so it is deliberately out of
// reach here.)
function ktx2HasCompressedTarget(scheme) {
  var f = ktx2FormatSnapshot;
  if (!f) return false;
  var astc = scheme === KTX2_SUPERCOMPRESSION_BASISLZ ? false : f.astc;
  return !!(astc || f.bptc || f.etc2 || f.s3tc || f.etc1);
}

// FORMAT_OPTIONS' priorityUASTC order, MEASURED against r184: astc 1, bptc 2,
// etc2 3, etc1 4, s3tc(dxt) 5, pvrtc 6. Our exports are UASTC only (ETC1S can
// never become ASTC, the Quest format), so that is the order worth printing.
var KTX2_FORMAT_LABELS = [
  ["astc", "ASTC 4x4"],
  ["bptc", "BC7"],
  ["etc2", "ETC2"],
  ["etc1", "ETC1"],
  ["s3tc", "BC1/BC3"],
  ["pvrtc", "PVRTC"],
];

function ktx2FormatLabel() {
  var f = ktx2FormatSnapshot;
  if (!f) return "";
  var have = [];
  var primary = "";
  for (var i = 0; i < KTX2_FORMAT_LABELS.length; i++) {
    var key = KTX2_FORMAT_LABELS[i][0];
    if (!f[key]) continue;
    if (!primary) primary = KTX2_FORMAT_LABELS[i][1];
    have.push(key);
  }
  if (!primary) return "uncompressed RGBA (no GPU texture format supported)";
  return primary + " (" + have.join(", ") + ")";
}

// One line per document, so a model with twenty textures says it once. It is
// the line a Quest check reads ("transcoding for ASTC 4x4 (astc, …)").
function logKtx2FormatsOnce() {
  if (ktx2Logged) return;
  ktx2Logged = true;
  try {
    if (root.console && typeof root.console.info === "function") {
      root.console.info("FastShaders KTX2: transcoding for " + ktx2FormatLabel() + ".");
    }
  } catch (e) {
    /* no console */
  }
}

// The renderer, then the loader, then detectSupport — memoized per document.
// A failure forgets itself, so a later model can try again once a renderer
// exists.
function ktx2Ready(getRenderer) {
  if (ktx2ReadyPromise) return ktx2ReadyPromise;
  var p = new Promise(function (resolve) {
    var r = null;
    try {
      r = typeof getRenderer === "function" ? getRenderer() : null;
    } catch (e) {
      r = null;
    }
    if (!r) r = configuredRenderer;
    if (!r) throw new Error(ERR_KTX2_NO_RENDERER);
    var real = sharedKtx2();
    if (!real) throw new Error(decoderLastError || ERR_KTX2_NO_CLASS);
    resolve(
      Promise.resolve(typeof r.init === "function" ? r.init() : null).then(function () {
        real.detectSupport(r);
        snapshotKtx2Formats(real.workerConfig);
        logKtx2FormatsOnce();
        return real;
      })
    );
  }).catch(function (e) {
    if (ktx2ReadyPromise === p) ktx2ReadyPromise = null;
    decoderLastError = reasonOf(e);
    throw e;
  });
  ktx2ReadyPromise = p;
  return p;
}

// The 80-byte KTX2 header, read before anything is transcoded. Returns an
// English reason, or "" when the texture may be parsed.
function ktx2HeaderRefusal(buffer) {
  var bytes = buffer && buffer.byteLength ? buffer.byteLength : 0;
  if (bytes > KTX2_MAX_FILE_BYTES) return errKtx2Bytes(bytes);
  if (bytes < KTX2_HEADER_BYTES) return ERR_KTX2_MAGIC;
  var head = new Uint8Array(buffer, 0, KTX2_HEADER_BYTES);
  var MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
  for (var i = 0; i < MAGIC.length; i++) {
    if (head[i] !== MAGIC[i]) return ERR_KTX2_MAGIC;
  }
  var view = new DataView(buffer, 0, KTX2_HEADER_BYTES);
  var vkFormat = view.getUint32(12, true);
  var scheme = view.getUint32(44, true);
  var w = view.getUint32(20, true);
  var h = view.getUint32(24, true);
  var depth = view.getUint32(28, true);
  var layers = view.getUint32(32, true);
  var faces = view.getUint32(36, true);
  var levels = view.getUint32(40, true);
  // glTF textures are 2D: a cube map, an array or a 3D texture is not one.
  if (faces !== 1 || depth > 1 || layers > 1) return ERR_KTX2_NOT_2D;
  if (levels > KTX2_MAX_LEVELS) return errKtx2Levels(levels);
  // A non-zero vkFormat is a RAW texture: three's _createTexture skips the
  // transcoder entirely (needsTranscoder = vkFormat === 0) and createRawTexture
  // allocates 4+ bytes a texel whatever the GPU supports.
  var max =
    vkFormat === 0 && ktx2HasCompressedTarget(scheme)
      ? KTX2_MAX_SIDE_COMPRESSED
      : KTX2_MAX_SIDE_UNCOMPRESSED;
  if (w > max || h > max) return errKtx2Side(w, h, max);
  return "";
}

// What GLTFLoader is handed as `ktx2Loader`. It answers `load(url, onLoad,
// onProgress, onError)` — the only method loadImageSource calls — and fetches
// the bytes ITSELF so the header can be capped before `real.parse`, which is
// public API and does not re-fetch.
function ktx2Shim(getRenderer) {
  return {
    isFastShadersKtx2Shim: true,
    load: function (url, onLoad, onProgress, onError) {
      var fail = function (e) {
        var err = e instanceof Error ? e : new Error(reasonOf(e));
        decoderLastError = err.message;
        if (typeof onError === "function") onError(err);
      };
      ktx2Ready(getRenderer).then(function (real) {
        var FileLoaderCtor = decoderCtor("FileLoader");
        if (!FileLoaderCtor) throw new Error(ERR_KTX2_NO_CLASS);
        var file = new FileLoaderCtor(real.manager);
        file.setResponseType("arraybuffer");
        file.load(
          url,
          function (buffer) {
            try {
              var refusal = ktx2HeaderRefusal(buffer);
              if (refusal) {
                fail(new Error(refusal));
                return;
              }
              real.parse(buffer, onLoad, fail);
            } catch (e) {
              fail(e);
            }
          },
          onProgress,
          fail
        );
      }, fail);
    },
  };
}

// The plugin. It replaces GLTFLoader's builtin KHR_texture_basisu — same name,
// same slot — and adds the one thing the builtin lacks: a transcode that fails
// falls back to the texture's plain `source` instead of losing the texture.
function basisuPlugin(parser) {
  return {
    name: KTX2_PLUGIN_NAME,
    loadTexture: function (i) {
      var json = parser.json;
      var def = json && json.textures && json.textures[i];
      var ext = def && def.extensions && def.extensions[KTX2_PLUGIN_NAME];
      if (!ext || !parser.options.ktx2Loader) return null;
      return parser
        .loadTextureImage(i, ext.source, parser.options.ktx2Loader)
        .then(function (t) {
          // MEASURED against r184: loadTextureImage RESOLVES NULL on failure
          // (its own catch swallows the error), so this — not the catch below —
          // is the ordinary failure path.
          if (!t) throw new Error(KTX2_EMPTY);
          ktx2Stats.transcoded++;
          return t;
        })
        .catch(function (err) {
          var reason = reasonOf(err);
          // The shim has already put the PRECISE reason (a header cap, a failed
          // transcoder fetch, a transcode error) in lastError; overwriting it
          // with this sentinel would throw that away.
          if (reason !== KTX2_EMPTY) decoderLastError = errKtx2Texture(reason);
          if (def.source !== undefined) {
            // The glTF's own PNG/JPEG. NB this skips EXT_texture_webp/avif,
            // whose plugins are not consulted from here: the core source is
            // what the file guarantees exists.
            ktx2Stats.fallbacks++;
            return parser.loadTexture(i);
          }
          ktx2Stats.missing++;
          throw err;
        });
    },
  };
}

// Equip one GLTFLoader, once. In "manage" mode the Draco loader is ALWAYS
// replaced — by the shared one when both Draco files resolve, else by null so
// the parse fails fast (rule 2) — except that in the self-located default a
// page that pointed A-Frame's dracoDecoderPath somewhere of its own keeps it.
// meshopt is set only when its file resolves.
function installDecoders(loader, ctx) {
  if (
    !loader ||
    typeof loader.setDRACOLoader !== "function" ||
    loader[DECODERS_INSTALLED] ||
    decoderMode === "off"
  ) {
    return loader;
  }
  var pagePath = ctx && typeof ctx === "object" ? ctx.dracoDecoderPath : undefined;
  var pageOwnsDraco =
    decoderByDefault &&
    typeof pagePath === "string" &&
    pagePath !== "" &&
    pagePath !== AFRAME_DRACO_DEFAULT;
  if (!pageOwnsDraco) {
    var draco =
      decoderUrl(DECODER_FILES.dracoWrapper) && decoderUrl(DECODER_FILES.dracoWasm)
        ? sharedDraco()
        : null;
    loader.setDRACOLoader(draco);
  }
  if (
    decoderUrl(DECODER_FILES.meshopt) &&
    typeof loader.setMeshoptDecoder === "function" &&
    !(decoderByDefault && loader.meshoptDecoder)
  ) {
    loader.setMeshoptDecoder(meshoptShim());
    perParseMeshopt(loader);
  }
  // KTX2 (13b-KTX2). Only when BOTH basis files resolve, and never over a
  // loader the page equipped itself. With no ktx2Loader the stock behaviour
  // stands: a basisu-required model fails fast, a basisu-used one falls back.
  if (
    decoderUrl(DECODER_FILES.basisJs) &&
    decoderUrl(DECODER_FILES.basisWasm) &&
    typeof loader.setKTX2Loader === "function" &&
    !loader.ktx2Loader
  ) {
    loader.setKTX2Loader(ktx2Shim(ctx && typeof ctx === "object" ? ctx.getRenderer : null));
    // register() dedupes by identity, and basisuPlugin is one function.
    if (typeof loader.register === "function") loader.register(basisuPlugin);
  }
  try {
    Object.defineProperty(loader, DECODERS_INSTALLED, { value: true });
  } catch (e) {
    /* a frozen loader: the next call equips it again, which is harmless */
  }
  return loader;
}

var decoders = {
  FILES: DECODER_FILES,
  MAX_MESHOPT_DECODED_BYTES: MAX_MESHOPT_DECODED_BYTES,
  configure: configureDecoders,
  install: installDecoders,
  // What the KTX2 plugin did in this document: textures transcoded, textures
  // that fell back to their PNG/JPEG source, textures lost entirely. Copies,
  // so a reader cannot edit the counters.
  get ktx2Stats() {
    return { transcoded: ktx2Stats.transcoded, fallbacks: ktx2Stats.fallbacks, missing: ktx2Stats.missing };
  },
  // The GPU formats detectSupport found, or null before any KTX2 texture has
  // been reached (the detection is lazy — see 13b-KTX2).
  get ktx2Formats() {
    var f = ktx2FormatSnapshot;
    return f ? { astc: f.astc, bptc: f.bptc, etc2: f.etc2, s3tc: f.s3tc, etc1: f.etc1, pvrtc: f.pvrtc } : null;
  },
  get lastError() {
    return decoderLastError;
  },
  clearError: function () {
    decoderLastError = "";
  },
};

// Later 0.8.x sections go here: after the mesh decoders, before the api object
// that exports them.

// ---------------------------------------------------------------------------
// (13c) The shader a FastShaders .glb carries: `src: model`
// ---------------------------------------------------------------------------
//
// A FastShaders single-GLB export stores its shader MODULE as UTF-8 text in a
// BIN bufferView named by root `extras.fastshaders.module`, beside the image
// stash (`assets`: placeholder key → images[] index). The glTF plugin reads
// those bytes at parse (stashModule) and does nothing else with them. They run
// ONLY when a page asks:
//   A-Frame      <a-entity gltf-model="url(x.glb)" shader="src: model">
//   plain three  FastShaders.applyFromGltf(gltf, opts) → Binding
//                FastShaders.loadFromGltf(gltf, opts)  → loaded (apply() it,
//                then loaded.release() once every binding using it is disposed)
// It is a `.js` in a model's clothing: the module runs with the page's
// privileges, so a page that loads models other people supply must never ask.
// Pages that must never run a model's code (the FastShaders editor's preview
// and XR popup, podest's stage and VR popup) call disableModelModules(), a
// one-way latch.
//
// Every `"fs-asset:<key>"` literal in the module becomes a blob: URL of the
// GLB's OWN image bytes. The URLs belong to the material generation that used
// them (state._modelAssetUrls) and are revoked with it by disposeShaderMaterial
// — the next apply's commit, remove(), binding.dispose() — never when the
// import settles, since a hand-written module may start a texture load later.
// The stash moves into Blobs on first read, so the bytes live once.
//
// Every failure throws BEFORE a line of the module runs (except "no default
// export", which is only known once it was imported): one console.error,
// shader-error {src: 'model', message}, and the authored materials back.
// `catch (e)` only in this section: the `err`-named catch blocks are the
// ones the source pins slice.

// parse record → { text, issue, blobs: Map<key, Blob> } (one record serves
// every scene of one parse, so the payload is keyed by the record).
var MODEL_PAYLOADS = new WeakMap();
var modelModulesOff = false;
var MODEL_URLS = typeof Symbol === "function" ? Symbol("fastshaders.modelUrls") : "__fsModelUrls";

// A closed reason → the words M_BAD prints.
var MODEL_REASON_TEXT = new Map([
  ["not-a-bufferview", "not a bufferView"],
  ["wrong-type", "wrong type"],
  ["compressed-view", "compressed or strided view"],
  ["external-buffer", "stored outside the file"],
  ["empty", "empty"],
  ["too-large", "over 16 MB"],
  ["unreadable", "unreadable"],
  ["cut-short", "cut short"],
  ["not-utf8", "not UTF-8 text"],
]);

// One way only: there is deliberately no counterpart.
function disableModelModules() {
  modelModulesOff = true;
}

function modelPayloadOf(rec) {
  var cached = MODEL_PAYLOADS.get(rec);
  if (cached) return cached;
  var p = { text: null, issue: rec.moduleIssue || null, blobs: new Map() };
  if (typeof root.TextDecoder !== "function" || typeof root.Blob !== "function") {
    // Nothing to decode or wrap with: keep the stash for a later call.
    return { text: null, issue: "unreadable", blobs: p.blobs };
  }
  if (rec.module) {
    try {
      p.text = new root.TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(rec.module));
      if (!p.text && !p.issue) p.issue = "empty";
    } catch (e) {
      p.text = null;
      p.issue = "not-utf8";
    }
    rec.module = null;
  } else if (!p.issue) {
    p.issue = "none";
  }
  if (rec.embedded) {
    rec.embedded.forEach(function (a, key) {
      p.blobs.set(key, new root.Blob([a.bytes], { type: a.mime }));
    });
    // The stash is RELEASED: the bytes now live once, in the Blobs.
    rec.embedded = null;
  }
  MODEL_PAYLOADS.set(rec, p);
  return p;
}

function modelMessage(rec, p) {
  if (p.issue === "none") return rec.fsFormat ? fillMsg(M_FORMAT, { v: rec.fsFormat }) : M_NONE;
  return fillMsg(M_BAD, { reason: MODEL_REASON_TEXT.get(p.issue) || "unreadable" });
}

// → { text, urls, unresolved }. One URL per distinct key the module references
// (never for an image it does not name); an unknown or invalid key stays
// verbatim, so the module's own decode() falls back and nothing is fetched
// (`fs-asset:` is not a fetchable scheme).
function resolveModelPlaceholders(text, blobs) {
  var minted = new Map();
  var missing = new Set();
  var urls = [];
  var out = String(text).replace(MODEL_PLACEHOLDER_RE, function (whole, key) {
    var url = minted.get(key);
    if (url !== undefined) return JSON.stringify(url);
    var blob = EMBED_KEY_RE.test(key) ? blobs.get(key) : undefined;
    if (!blob) {
      missing.add(key);
      return whole;
    }
    url = root.URL.createObjectURL(blob);
    minted.set(key, url);
    urls.push(url);
    return JSON.stringify(url);
  });
  return { text: out, urls: urls, unresolved: missing.size };
}

// The base the module's RELATIVE imports resolve against: the model's own
// path when it is http(s) or file, else undefined (a blob:/data: model leaves
// them verbatim instead of throwing inside resolveTSLImports).
function modelModuleUrl(rec, base) {
  var href = base || (root.location && root.location.href) || "";
  try {
    var u = new root.URL(rec.moduleBase || "./", href);
    return /^(https?|file):$/.test(u.protocol) ? u.href : undefined;
  } catch (e) {
    return undefined;
  }
}

// load()'s precedence for the import leg.
function importModuleSource(source, opts) {
  return ((opts && opts.importSource) || api.importSource || defaultImportSource)(source);
}

// release() revokes; take() hands the list over (to a binding) and disarms
// release(). Either runs once.
function urlHolder(list) {
  var done = false;
  return {
    release: function () {
      if (done) return;
      done = true;
      list.forEach(function (u) {
        try {
          root.URL.revokeObjectURL(u);
        } catch (e) {
          /* already gone */
        }
      });
    },
    take: function () {
      if (done) return null;
      done = true;
      return list.slice();
    },
  };
}

async function loadModelModule(target, opts) {
  if (modelModulesOff) throw new Error(M_DISABLED);
  var rec = target ? RECORDS.get(target) : undefined;
  if (!rec) throw new Error(M_NO_RECORD);
  var p = modelPayloadOf(rec);
  if (p.issue) throw new Error(modelMessage(rec, p));
  var r = resolveModelPlaceholders(p.text, p.blobs);
  if (r.unresolved) console.warn(fillMsg(W_UNRESOLVED, { n: r.unresolved }));
  var h = urlHolder(r.urls);
  try {
    var source = prepareSource(r.text, modelModuleUrl(rec, opts && opts.base));
    var module = await importModuleSource(source, opts);
    var d = module && module.default;
    if (typeof d !== "function" && (d === null || typeof d !== "object")) throw new Error(M_NO_DEFAULT);
    var loaded = { url: MODEL_SRC, source: source, module: module, root: target };
    Object.defineProperty(loaded, "release", { value: h.release });
    Object.defineProperty(loaded, MODEL_URLS, { value: h.take });
    return loaded;
  } catch (e) {
    h.release();
    throw e;
  }
}

// The binding (a state) takes the loaded module's URLs; a URL module's loaded
// carries none, which clears the field (the previous generation's URLs were
// already revoked by applyResult's disposeShaderMaterial).
function adoptModelAssets(state, loaded) {
  var take = loaded && loaded[MODEL_URLS];
  state._modelAssetUrls = typeof take === "function" ? take() : null;
}

function releaseModelAssets(state) {
  var list = state._modelAssetUrls;
  state._modelAssetUrls = null;
  if (!list) return;
  list.forEach(function (u) {
    try {
      root.URL.revokeObjectURL(u);
    } catch (e) {
      /* already gone */
    }
  });
}

async function loadFromGltf(gltfOrRoot, opts) {
  if (modelModulesOff) throw new Error(M_DISABLED);
  var t =
    gltfOrRoot && gltfOrRoot.scene && typeof gltfOrRoot.scene.traverse === "function"
      ? gltfOrRoot.scene
      : gltfOrRoot;
  if (!t || typeof t.traverse !== "function") throw new TypeError(M_BAD_TARGET);
  return loadModelModule(t, opts || {});
}

async function applyFromGltf(gltfOrRoot, opts) {
  var loaded = await loadFromGltf(gltfOrRoot, opts);
  var b;
  try {
    b = apply(loaded.root, loaded, opts || {});
  } catch (e) {
    loaded.release();
    throw e;
  }
  adoptModelAssets(b.state, loaded);
  return b;
}

// ---------------------------------------------------------------------------
// (14) The public api
// ---------------------------------------------------------------------------
//
// `internals` is NOT a stable interface — it exists for tests and for the
// FastShaders editor's own surfaces. `fetch` and `importSource` are the two
// documented hooks (see load()).
const api = {
  version: VERSION,
  threeRevision: THREE_REVISION,
  use: use,
  load: load,
  prepareSource: prepareSource,
  makeParams: makeParams,
  setUniform: function (uniforms, name, value) {
    return setUniformValue(uniforms, name, value, null);
  },
  apply: apply,
  weld: weldByPosition,
  gltfPlugin: gltfPlugin,
  gltfRecord: gltfRecord,
  materialIndexOf: materialIndexOf,
  modelSignature: modelSignature,
  embeddedAssets: embeddedAssets,
  releaseEmbedded: releaseEmbedded,
  // `shader="src: model"` and its plain-three twins (header delta 9, 13c).
  MODEL_SRC: MODEL_SRC,
  loadFromGltf: loadFromGltf,
  applyFromGltf: applyFromGltf,
  disableModelModules: disableModelModules,
  decoders: decoders,
  transforms: Object.freeze({
    autoDetectSchema: autoDetectSchema,
    autoInjectTSLImports: autoInjectTSLImports,
    fixTSLShadowing: fixTSLShadowing,
    globalizeBareImports: globalizeBareImports,
    resolveTSLImports: resolveTSLImports,
  }),
  internals: Object.freeze({
    storeOriginalMaterials: storeOriginalMaterials,
    applyMaterialToMesh: applyMaterialToMesh,
    restoreOriginalMaterials: restoreOriginalMaterials,
    disposeShaderMaterial: disposeShaderMaterial,
    buildMaterials: buildMaterials,
    buildMaterial: buildMaterial,
    callShader: callShader,
    shouldWeld: shouldWeld,
    syncWeld: syncWeld,
    unweld: unweld,
    syncBary: syncBary,
    unbary: unbary,
    isPrimitiveMesh: isPrimitiveMesh,
    loadMapInto: loadMapInto,
    applyResult: applyResult,
    checkThreeRevision: checkThreeRevision,
    resolveMaterialParts: resolveMaterialParts,
    loadModelModule: loadModelModule,
    resolveModelPlaceholders: resolveModelPlaceholders,
    modelPayloadOf: modelPayloadOf,
    releaseModelAssets: releaseModelAssets,
  }),
  NODE_PROPS: Object.freeze(NODE_PROPS.slice()),
  fetch: null,
  importSource: null,
};

root.FastShaders = api;
if (typeof module === "object" && module !== null && module.exports) {
  module.exports = api;
}

// ---------------------------------------------------------------------------
// (15) A-Frame integration
// ---------------------------------------------------------------------------

// A-Frame's side of loadMapInto: '#id' through the document, the material
// system's loadTexture, and "the entity is still connected and still has
// uniforms" as the liveness test.
function aframeTextureAdapter(comp) {
  return {
    resolve: function (src) {
      if (typeof src === "string" && src[0] === "#" && root.document) {
        const selected = root.document.querySelector(src);
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
      return src;
    },
    canLoad: function () {
      return !!(
        comp.el.sceneEl &&
        comp.el.sceneEl.systems &&
        comp.el.sceneEl.systems.material
      );
    },
    load: function (src, cb) {
      comp.el.sceneEl.systems.material.loadTexture(src, {}, cb);
    },
    alive: function () {
      return !!(comp.el && comp.el.isConnected) && !!comp._propertyUniforms;
    },
  };
}

// 0.6's component, method for method and signature for signature. Every
// method that does real work is a one-line delegate to the core, passing the
// component itself as the state.
var componentDef = {
  schema: {
    src: { type: "string" },
  },
  init: function () {
    this.applyShader = this.applyShader.bind(this);
    this.originalMaterials = {};
    this._shaderMaterial = null;
    this._partMaterials = null;
    this._appliedMaterials = null;
    this._currentSrc = null;
    this._extending = false;
    // 0.8: the per-glTF-material seam (see resolveIndexPart), filled by
    // applyResult when a materialParts table applies, and its status.
    this._indexPartMaterials = null;
    this._indexPartResolver = null;
    this._materialPartsStatus = null;
    // 0.8, src: model (13c): the image URLs the current material generation
    // owns, and the per-apply staleness token (two model applies both carry
    // `_currentSrc === 'model'`, so the src string cannot tell them apart).
    this._modelAssetUrls = null;
    this._modelApplyToken = null;

    // --- vertex weld (0.6) ---------------------------------------------------
    // `_weldWanted` is decided per apply (see shouldWeld); `_welded` is the
    // geometry WE built and therefore own; `_weldSource` is the original we
    // displaced and must put back — never dispose it, A-Frame's geometry SYSTEM
    // refcounts and SHARES it with any other entity using the same primitive.
    // `_weldScanned` remembers a geometry we already found nothing to weld in,
    // so a re-apply does not rescan it.
    this._weldWanted = false;
    this._welded = null;
    this._weldSource = null;
    this._weldScanned = null;
    // Does the shader READ uv()? A uv-driven height splits a sphere's seam and
    // pole fans even though their normals agree — see weldByPosition.
    this._weldUvDriven = false;

    // A-Frame's geometry component replaces `mesh.geometry` IN PLACE on every
    // rebuild (a subdivision change, a sphere→box swap) while keeping the mesh
    // and its material, so a weld done once at apply time is silently undone.
    // Re-welding on the geometry component's own events is what survives that.
    this._onGeometryEvent = (e) => {
      // A gltf-model attached AFTER this component: the fallback for the
      // prototype hook (installGltfModelHook), which already covers it on
      // every A-Frame it recognises. register() dedupes.
      if (e.detail && e.detail.name === "gltf-model") {
        attachGltfModel(this.el.components && this.el.components["gltf-model"]);
      }
      if (e.detail && e.detail.name === "geometry") {
        // Both, in this order: syncWeld drops our bary geometries first (so it
        // can see the system's own), and the new geometry then needs its
        // corners rebuilt. Without the second call a subdivision change or a
        // primitive swap silently loses the attribute and the edges vanish.
        this.syncWeld();
        this.syncBary();
      }
    };
    this.el.addEventListener("componentinitialized", this._onGeometryEvent);
    this.el.addEventListener("componentchanged", this._onGeometryEvent);

    this.el.addEventListener("model-loaded", this.applyShader);
    // …and a gltf-model that is already there (the same fallback).
    attachGltfModel(this.el.components && this.el.components["gltf-model"]);
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
    // BEFORE the first await: a newer apply that starts while this one is
    // still loading must be able to see that this one is stale.
    this._currentSrc = tslPath;
    // `src: model` (header delta 9, section 13c) names the shader inside this
    // entity's OWN gltf-model, never a file.
    const fromModel = tslPath === MODEL_SRC;
    const token = fromModel ? (this._modelApplyToken = {}) : null;
    const gltfComp = this.el.components && this.el.components["gltf-model"];
    // The model has not replaced 'mesh' yet: wait quietly, model-loaded re-applies.
    if (fromModel && gltfComp && gltfComp.model !== mesh) return;

    try {
      // Every src: model refusal throws into the catch below BEFORE a line of
      // the module runs: the entity keeps its authored materials and emits
      // shader-error, and nothing is fetched.
      if (fromModel && !gltfComp) throw new Error(M_NO_GLTF);
      // Fetch, the four source transforms, and the blob import — see load().
      const loaded = fromModel
        ? await loadModelModule(mesh, { base: root.location && root.location.href })
        : await api.load(tslPath, {
            base: root.location && root.location.href,
          });

      if (this._currentSrc !== tslPath || (fromModel && this._modelApplyToken !== token)) {
        if (loaded.release) loaded.release();
        return;
      }

      try {
        applyResult(this, mesh, loaded, {
          isPrimitive: !!(this.el.components && this.el.components.geometry),
          isGltf: !!(this.el.components && this.el.components["gltf-model"]),
          loadMap: (name, raw) => this._loadMapValue(name, raw),
          onUniforms: (uniforms, schema) => {
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
          },
        });
      } catch (e) {
        // A failed build must not strand this apply's image URLs.
        if (loaded.release) loaded.release();
        throw e;
      }
      // The new material generation owns the model's image URLs (null for a
      // URL module); applyResult already revoked the previous generation's.
      adoptModelAssets(this, loaded);
      // A module carrying materialParts reports what became of it FIRST.
      // FORGEABLE: the sandboxed document runs the shader, so a parent never
      // derives anything that matters from this event.
      if (this._materialPartsStatus) {
        this.el.emit("shader-material-parts", Object.assign({}, this._materialPartsStatus));
      }
      // Announce success so embedding pages (editor preview, viewer) can
      // clear any error overlay. Bubbles like every A-Frame entity event.
      this.el.emit("shader-applied", { src: tslPath });
    } catch (err) {
      // Staleness guard, mirroring the success path: a superseded apply's
      // late failure must not revert the material a newer apply installed,
      // nor surface a stale error over a shader that is rendering fine.
      if (this._currentSrc !== tslPath || (fromModel && this._modelApplyToken !== token)) {
        return;
      }
      console.error(`Failed to load TSL shader from ${tslPath}`, err);
      this.restoreOriginalMaterials(mesh);
      // A shader that failed to load must not leave the geometry welded or
      // expanded on its behalf — the entity is back on its original materials.
      // unbary FIRST: unweld's identity guard is "is the mesh still wearing the
      // geometry WE welded", and our expanded one sitting on top makes it
      // false, which would strand the welded geometry with its source
      // reference already dropped.
      this._weldWanted = false;
      this._baryWanted = false;
      this.unbary();
      this.unweld();
      // Surface the failure as a DOM event — console.error alone leaves
      // embedding pages with a silently-fallback material and no signal.
      this.el.emit("shader-error", {
        src: tslPath,
        message: (err && err.message) || String(err),
      });
    }
  },
  // All three application sites — the string-attr read, the object-attr read,
  // and the update() diff loop — go through here (see setUniformValue).
  _applyUniformValue: function (name, raw) {
    return setUniformValue(this._propertyUniforms, name, raw, (n, v) =>
      this._loadMapValue(n, v),
    );
  },
  // A map value (URL string, '#id' selector string, or an IMG/CANVAS/VIDEO
  // element) through A-Frame's material system — see loadMapInto.
  _loadMapValue: function (name, src) {
    return loadMapInto(this, name, src, aframeTextureAdapter(this));
  },
  storeOriginalMaterials: function (mesh) {
    storeOriginalMaterials(this, mesh);
  },
  applyMaterialToMesh: function (mesh, material, partMaterials) {
    applyMaterialToMesh(this, mesh, material, partMaterials);
  },
  // The primitive gate stays exactly 0.6's: A-Frame's geometry component.
  shouldWeld: function (shaderResult, material, partMaterials) {
    return shouldWeld(
      shaderResult,
      material,
      partMaterials,
      !!(this.el.components && this.el.components.geometry),
      this._indexPartMaterials,
    );
  },
  syncWeld: function () {
    syncWeld(this, this.el.getObject3D("mesh"));
  },
  syncBary: function () {
    syncBary(this, this.el.getObject3D("mesh"));
  },
  unbary: function () {
    unbary(this);
  },
  unweld: function () {
    unweld(this, this.el.getObject3D("mesh"));
  },
  disposeShaderMaterial: function () {
    disposeShaderMaterial(this);
  },
  remove: function () {
    this._currentSrc = null;
    this._modelApplyToken = null;
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
    this.el.removeEventListener("componentinitialized", this._onGeometryEvent);
    this.el.removeEventListener("componentchanged", this._onGeometryEvent);
    this._onGeometryEvent = null;
    // The weld and the barycentric corners both belonged to the shader; the
    // shader is going away. unbary FIRST, for the reason syncWeld does it:
    // unweld's identity guard is false while our geometry is on the mesh.
    this._weldWanted = false;
    this._weldScanned = null;
    this._baryWanted = false;
    this.unbary();
    this.unweld();
  },
  restoreOriginalMaterials: function (mesh) {
    restoreOriginalMaterials(this, mesh);
  },
};

// Registered only when A-Frame is on the page, and never over another loader's
// `shader` component: A-Frame's registerComponent THROWS on a duplicate name,
// which would take the whole file down with it. The core above still works.
var AF = root.AFRAME;
if (AF && typeof AF.registerComponent === "function") {
  if (AF.components && AF.components.shader) {
    warnOnce("dup", WARN_DUP_COMPONENT);
  } else {
    AF.registerComponent("shader", componentDef);
  }
  // Whether or not our component registered: every gltf-model loader on the
  // page gets the glTF plugin, so FastShaders.apply can match its models too.
  installGltfModelHook(AF);
}
})(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : this);
