import type { AppNode, AppEdge, NodeDefinition, GeneratedCode, ShaderNodeData, OutputMaterial } from '@/types';
import { valueNum, valueStr } from '@/utils/valueCoerce';
import { HEX6, storedHex6 } from '@/utils/colorUtils';
import { getNodeValues } from '@/types';
import {
  defaultOutput,
  contributingOutputs,
  outputMaterials,
  materialExposedPorts,
  channelHandle,
  planNamedPartsAcross,
  planIndexPartsAcross,
  moduleSignatureOf,
} from '@/utils/outputMaterials';
import { moduleStringLiteral } from './partKeyLiteral';
import { NODE_REGISTRY, effectiveInputs } from '@/registry/nodeRegistry';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { MODULE_HELPERS, MODULE_HELPER_NAMES, HELPER_OWNER_TYPES, helperNameFor, helperCallPorts } from './moduleHelpers';
import {
  marchPartition,
  drivingCustomSink,
  isMarchOutput,
  isSplatOutput,
  isCustomSink,
  bindingOfRoot,
  noisePosIdentifier,
  MARCH_OUTPUT_TYPE,
  MARCH_SCOPES,
  SPLAT_OUTPUT_TYPE,
  splatScopes,
  SPLAT_FN_PARAMS,
  type ScopeSpec,
} from '@/utils/sdfPartition';
import { effectiveExposedPorts, OUTPUT_DEFAULT_EXPOSED } from '@/utils/exposedPorts';
import { isSplatLit, SPLAT_LIGHT_COLOR_DEFAULTS, SPLAT_LIGHT_DIRECTION_DEFAULTS, SPLAT_LIGHT_DIRECTION_EPSILON } from '@/utils/splatLight';
import { isSplatReplaceColor, splatStoredColor } from '@/utils/splatColor';
import { hasTrueFlag } from '@/utils/trueFlag';
import { sanitizeIdentifier } from '@/utils/nameUtils';
import { isUnsignedNoise } from '@/utils/noiseRange';
import { isWireframeEdges } from '@/utils/wireframeMode';
import { decodeDataNode, columnForHandle } from '@/utils/dataNode';
import { readSoundSettings } from '@/utils/soundSettings';
import {
  SOUND_CHANNELS,
  soundUniformName,
  soundChannelForHandle,
  isSoundNodeType,
  soundVarBase,
} from '@/utils/soundAnalysis';
import type { SoundChannel } from '@/utils/soundAnalysis';
import { createImageTexturePlanner, imageElementSetupLines, imageTextureSetupLines } from './imageTexturePlan';
import { materialSettingProps } from './materialSettingsCode';
// The `unknown`-node expression validator. Its own module because it is the
// only thing in codegen that needs @babel/parser, which is loaded on demand
// there rather than pinned into the boot payload — see that file.
import { isSafeUnknownExpression } from './unknownExpression';
// Shape inference (1-4 channels) — the same authority the edge/preview layer
// uses, so codegen and the UI agree on what counts as a scalar.
import { getNodeOutputShape, portShapeForHandle } from './cpuEvaluator';
import { IMAGE_CHANNEL_COMPONENTS, isImageChannelHandle } from '@/utils/imageChannels';
import { readImageUvMapping, gltfUvMatrix } from '@/utils/imageUvMapping';
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
  parseFormula,
  emitFormula,
  formulaEnv,
  hasCustomFormula,
  formulaErrorSummary,
  type FormulaErrorCode,
} from '@/utils/dataRangeFormula';
import {
  getColormap,
  buildColormapLut,
  LUT_SIZE,
  LUT_COORD_SCALE,
  LUT_COORD_OFFSET,
} from '@/utils/colormaps';
import { float32ToBase64, float16ToBase64 } from '@/utils/binaryCodec';
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
  gidx: GraphIndex,
): { capped: Float32Array; cnorm: Float32Array } | null {
  if (!signalEdge) return null;
  const src = gidx.nodeById.get(signalEdge.source);
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
  dataRange: 'dataRange',
  isolines: 'isolines',
  wireframe: 'wireframe',
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
  varNames: Map<string, string>,
  gidx: GraphIndex,
): string {
  const edge = inEdge(gidx, node.id, key);
  if (edge) {
    const ref = resolveEdgeRef(edge, varNames, gidx);
    if (ref) return ref;
  }
  const raw = Number(getNodeValues(node)[key]);
  return num(Number.isFinite(raw) ? raw : fallback);
}

/**
 * Sampling coordinate in [0, 1]: uv.x, or the normalized radius from a chosen
 * centre. The ONE reader Stripes and Data Viz share; the radius floor keeps the
 * divide finite. `radial` tells the caller to import `vec2`; `uvBase` is `uv()`
 * except inside a Splat Output Fn (the loop's `unwiredUv`).
 */
function rampCoord(nv: Record<string, string | number>, uvBase = 'uv()'): { radial: boolean; expr: string } {
  const radial = valueNum(nv.radial ?? 0) >= 0.5;
  const cx = valueNum(nv.center_x ?? 0.5);
  const cy = valueNum(nv.center_y ?? 0.5);
  const radius = Math.max(valueNum(nv.radius ?? 0.5), 1e-4);
  return {
    radial,
    expr: radial
      ? `${uvBase}.sub(vec2(${num(cx)}, ${num(cy)})).length().div(${num(radius)}).clamp(0.0, 1.0)`
      : `${uvBase}.x`,
  };
}

/** Valid swizzle component handles for split node output. */
export const VALID_SWIZZLE = new Set(['x', 'y', 'z', 'w']);

/**
 * RGB-to-HSL output handles ⇄ the components of its ONE emitted call; a drift
 * pair that must change together (see docs/dev/codegen.md, `toHsl`). `out` is
 * absent on purpose: it is the whole vec3. Maps, not Records: the keys are
 * adversarial strings and a Record resolves 'constructor' to a Function.
 */
export const TOHSL_HANDLE_TO_COMPONENT = new Map<string, string>([['h', 'x'], ['s', 'y'], ['l', 'z']]);
export const TOHSL_COMPONENT_TO_HANDLE = new Map<string, string>([['x', 'h'], ['y', 's'], ['z', 'l']]);

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
  return HEX6.test(s) ? `0x${s.slice(1)}` : '0x000000';
}

interface GraphIndex {
  nodeById: Map<string, AppNode>;
  incoming: Map<string, AppEdge[]>;
  outgoing: Map<string, AppEdge[]>;
}

/**
 * Lookup indexes for ONE codegen pass.
 *
 * Every list preserves ARRAY ORDER and every key is first-wins, so each
 * `.find()` these replace returns the identical element it returned before —
 * that is the whole byte-safety argument. `nodeById` indexes `sorted`, NOT
 * `nodes`: a cycle-excluded node is absent from `sorted` and today's
 * `sorted.find` reports it as missing; indexing `nodes` would resurrect it.
 *
 * Unlike cpuEvaluator's EvalCtx this needs no WeakMap keying or
 * sameGraphSemantics revalidation — graphToCode is a single pass, `sorted` is
 * const and `edges` is reassigned only once at the top, before this is built,
 * so there is nothing that can invalidate it.
 */
function buildGraphIndex(sorted: AppNode[], edges: AppEdge[]): GraphIndex {
  const nodeById = new Map<string, AppNode>();
  for (const n of sorted) if (!nodeById.has(n.id)) nodeById.set(n.id, n);
  const incoming = new Map<string, AppEdge[]>();
  const outgoing = new Map<string, AppEdge[]>();
  for (const e of edges) {
    const i = incoming.get(e.target);
    if (i) i.push(e); else incoming.set(e.target, [e]);
    const o = outgoing.get(e.source);
    if (o) o.push(e); else outgoing.set(e.source, [e]);
  }
  return { nodeById, incoming, outgoing };
}

/** Edges arriving at `id`, in array order. The returned array is the index's
 *  own list — read it, never mutate it. */
function inEdges(gidx: GraphIndex, id: string): AppEdge[] {
  return gidx.incoming.get(id) ?? [];
}
/** Edges leaving `id`, in array order. Read-only, as above. */
function outEdges(gidx: GraphIndex, id: string): AppEdge[] {
  return gidx.outgoing.get(id) ?? [];
}
/** Indexed twin of `edges.find(e => e.target === id && e.targetHandle === handle)`. */
function inEdge(gidx: GraphIndex, id: string, handle: string): AppEdge | undefined {
  return inEdges(gidx, id).find((e) => e.targetHandle === handle);
}

/**
 * Does any edge leave this Image node from a CHANNEL socket (Alpha/R/G/B)?
 * Then the sample is emitted WIDE (`.rgba`) and consumers read swizzles. The
 * ONE predicate the image branch and resolveEdgeRef share, over the unwrapped
 * edges; see docs/dev/images-and-textures.md.
 */
function imageSampleIsWide(gidx: GraphIndex, id: string): boolean {
  for (const e of outEdges(gidx, id)) if (isImageChannelHandle(e.sourceHandle)) return true;
  return false;
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

  const gidx = buildGraphIndex(sorted, edges);

  /**
   * A property feeding NOTHING is not emitted: no uniform line, no import, no
   * schema entry. "Has an outgoing edge", not "reaches an Output": presets,
   * textures and saved groups are emitted with no Output at all. Judged on the
   * UNWRAPPED edges, and read by BOTH the import collector and the body loop.
   * Pinned by orphanedUniforms.test.ts.
   */
  const isOrphanedProperty = (node: AppNode): boolean =>
    (node.data.registryType === 'property_float' ||
      node.data.registryType === 'property_color') &&
    outEdges(gidx, node.id).length === 0;

  // Assign unique variable names
  const varNames = new Map<string, string>();
  // Seeded with every module-scope helper NAME: a node variable is `<base><n>`
  // and `sdBox2` / `sdBox3` are helpers, so a second Box node would otherwise
  // be named after a helper — `const sdBox2 = sdBox2(...)` shadows the Fn it
  // calls and throws a temporal-dead-zone ReferenceError at runtime (measured).
  const usedNames = new Set<string>(MODULE_HELPER_NAMES);

  // Smallest index whose `<base><i>` is not already in usedNames, memoized per
  // base. usedNames only ever GROWS, so the cursor is monotone: every index
  // below it is permanently taken and can never become claimable again, which
  // makes skipping it exactly equivalent to re-probing it. That turns the O(k)
  // rescan per claim — O(N^2) over N same-base nodes — into amortized O(1).
  //
  // TWO cursors, not one, and the split is LOAD-BEARING. The bareFirst sequence
  // is `base, base2, base3, ...`; index 1 is never a candidate there, so that
  // cursor floors at 2. Sharing one cursor and passing the floor in would let a
  // bareFirst probe park it at 2, and the next PLAIN claim for the same base
  // would then skip a free `base1`: two properties named `mul` plus a `mul`
  // node emits `mul3` where today it emits `mul1` — a byte-breaking rename.
  //
  // A cursor advances ONLY over names actually in usedNames — never past one
  // that was merely REJECTED by `aliases`/`extraFree`. A `data1` candidate
  // rejected because a property already took `data1_col0` is still claimable by
  // the NEXT data node, whose columns differ; a plain monotone counter would
  // skip it and rename the node.
  const nameCursor = new Map<string, number>();
  const bareCursor = new Map<string, number>();
  const firstFreeIdx = (
    cursors: Map<string, number>,
    base: string,
    from: number,
  ): number => {
    let i = Math.max(from, cursors.get(base) ?? from);
    while (usedNames.has(`${base}${i}`)) i++;
    cursors.set(base, i);
    return i;
  };

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
    let name: string;
    if (opts.bareFirst) {
      name = base;
      if (!claimable(name)) {
        let i = firstFreeIdx(bareCursor, base, 2);
        name = `${base}${i}`;
        while (!claimable(name)) name = `${base}${++i}`;
      }
    } else {
      let i = firstFreeIdx(nameCursor, base, 1);
      name = `${base}${i}`;
      while (!claimable(name)) name = `${base}${++i}`;
    }
    usedNames.add(name);
    for (const alias of opts.aliases?.(name) ?? []) usedNames.add(alias);
    return name;
  };

  // The custom sink that DRIVES — resolved here, before any name is claimed,
  // because it decides which names are free (below), and used again when the
  // body is planned. It depends only on the nodes and the unwrapped edges.
  const customNode = drivingCustomSink(sorted, edges);

  // A Splat Output's Fns are `Fn(([p, pw, n, c]) => …)`: a PROPERTY named `c`
  // (the only way a node gets a bare, unnumbered name) would be shadowed by the
  // parameter inside them, and a chain reading it there would silently read
  // the splat's colour instead. So the parameter names are reserved — but ONLY
  // while a Splat Output DRIVES, since only then do those Fns exist. A
  // property's name is its public API (schema key, A-Frame attribute,
  // persisted-uniform key), so a parked or unwired Splat Output renames
  // nothing; a property named `p`/`pw`/`n`/`c` is renamed (`n2`) exactly while
  // the splat program is the module.
  if (customNode && isSplatOutput(customNode)) for (const name of SPLAT_FN_PARAMS) usedNames.add(name);

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
      let baseName = valueStr(nv.functionName ?? 'unknown').replace(/[^a-zA-Z0-9_$]/g, '_');
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
      for (const e of outEdges(gidx, node.id)) {
        if (/^col\d+$/.test(e.sourceHandle ?? '')) refCols.add(e.sourceHandle as string);
      }
      varNames.set(node.id, claimName('data', {
        aliases: (name) => [...refCols].map((h) => `${name}_${h}`),
      }));
      continue;
    }

    // The Sound node has the data node's aliasing problem: it emits
    // `<var>_<channel>` (`sound1_bass`), so claiming only the base would let a
    // property take that name: a duplicate declaration, and the module is dead.
    if (isSoundNodeType(def.type)) {
      const refChannels = new Set<SoundChannel>();
      for (const e of outEdges(gidx, node.id)) {
        refChannels.add(soundChannelForHandle(e.sourceHandle));
      }
      varNames.set(node.id, claimName(soundVarBase(def.type), {
        // The uniform AND its gained twin (`_sound1_bass`) are both reserved.
        aliases: (name) =>
          [...refChannels].flatMap((ch) => {
            const u = soundUniformName(name, ch);
            return [u, `_${u}`];
          }),
      }));
      continue;
    }

    // Nodes with no tslFunction (custom emission) need an explicit base name
    // instead of the empty-string fallback below.
    if (def.type === MARCH_OUTPUT_TYPE) {
      // The march IIFE plus its per-channel functions and unpacked outputs
      // share one base (`rm1`, `rm1Field`, `rm1Density`, `rm1Color`,
      // `rm1Emissive`, `rm1Glow`, `rm1Background`, `rm1Col`, …) — reserved
      // together, so a user property cannot land on one. codeToGraph
      // recognises them by name AND declarator shape.
      varNames.set(node.id, claimName('rm', {
        aliases: (n) => [`${n}Field`, `${n}Density`, `${n}Color`, `${n}Emissive`, `${n}Glow`, `${n}Background`, `${n}Col`, `${n}N`],
      }));
      continue;
    }
    if (def.type === SPLAT_OUTPUT_TYPE) {
      // The splat's four Fns share one base (`sp1Shade`, `sp1Shape`,
      // `sp1Size`, `sp1Feather`), reserved together like the march's, and so
      // is the lit shade Fn's light line (`sp1Light`); codeToGraph recognises
      // them by name AND by declarator shape.
      varNames.set(node.id, claimName('sp', {
        aliases: (n) => [`${n}Shade`, `${n}Shape`, `${n}Size`, `${n}Feather`, `${n}Light`],
      }));
      continue;
    }
    if (CUSTOM_EMISSION_BASENAMES[def.type]) {
      varNames.set(node.id, claimName(CUSTOM_EMISSION_BASENAMES[def.type]));
      continue;
    }

    // A def emitting through helper VARIANTS (modes, width dispatch) names its
    // variable after the DEF, not after whichever helper this node calls —
    // `sdCombine1` whatever the mode, `sdBox1` whatever the width.
    let baseName = HELPER_OWNER_TYPES.has(def.type) ? def.type : def.tslFunction;
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
    // An orphaned property emits no statement, so importing `uniform` for it
    // leaves the module with an unused import.
    if (isOrphanedProperty(node)) continue;
    // UV import is handled in body generation (with channel parameter)
    if (def.type === 'uv') continue;
    // Module-scope helpers (hsl/toHsl, the distance-field family) are not TSL
    // exports — never try to import them. A def with modes or a width
    // dispatch names its variants through the same table.
    if (MODULE_HELPERS.has(def.tslFunction) || HELPER_OWNER_TYPES.has(def.type)) continue;
    addImport(def.tslImportModule, def.tslFunction);
  }

  // Module-scope helper Fns (`engine/moduleHelpers.ts`): every CALLEE the
  // body emits is recorded here (the generic branch and the width-dispatched
  // Box branch), and after the body is built the table is walked in TABLE
  // order — so the helper block is deterministic whatever the graph order,
  // hsl before toHsl before the distance-field family — to emit the used
  // helpers and force-import the three/tsl names only their BODIES use. By
  // NAME rather than by def type, because a def with modes calls a different
  // helper per mode and Box calls one per position width.
  const usedHelperNames = new Set<string>();
  const usedHelpers: string[] = [];

  /**
   * Channel count of the OUTPUT PORT an edge leaves from: the declared port
   * type wins, node-level inference is the fallback for `any` ports. See
   * docs/dev/codegen.md "Edge VALUES are read per SOURCE SOCKET".
   */
  const shapeOfEdgeSource = (edge: AppEdge): number => {
    const srcNode = gidx.nodeById.get(edge.source);
    // The ONE per-handle lookup, shared with cpuEvaluator.getEdgeOutputShape.
    const declared = srcNode ? portShapeForHandle(srcNode, edge.sourceHandle ?? 'out', registry) : 0;
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
    const ref = resolveEdgeRef(edge, varNames, gidx);
    if (!ref) return null;
    return shapeOfEdgeSource(edge) === 1 ? ref : `${ref}.x`;
  };

  /**
   * The COLOUR an edge carries (a ramp endpoint), or `color(0x…)` of the stored
   * hex when nothing is wired. The inverse of `scalarRefOf`: a 1-channel source
   * is WIDENED with `vec3()`, never narrowed. See docs/dev/node-types.md, ramp ends.
   */
  const colorRefOf = (edge: AppEdge | undefined, storedHex: unknown, fallbackHex: unknown): string => {
    if (edge) {
      const ref = resolveEdgeRef(edge, varNames, gidx);
      if (ref) {
        addImport('three/tsl', 'vec3');
        return shapeOfEdgeSource(edge) === 1 ? `vec3(${ref})` : ref;
      }
    }
    return `color(${hexLiteral(storedHex ?? fallbackHex)})`;
  };

  /**
   * The value an edge into a CUSTOM SINK's colour-like socket carries, WIDENED
   * with `vec3()` where `widen(shape)` says so — or null when nothing
   * resolvable is wired. The march widens a SCALAR only (`=== 1`, its rule
   * since the node shipped); the Splat Output widens anything that is not
   * already three channels, because its value lands in a `vec4(rgb, a)` join,
   * where a vec4 source would make five components and a vec2 two too few.
   * Shared by both sinks' emitters so the widening is one piece of code.
   */
  const widenedRefOf = (
    edge: AppEdge | undefined,
    widen: (shape: number) => boolean = (shape) => shape === 1,
  ): string | null => {
    if (!edge) return null;
    const ref = resolveEdgeRef(edge, varNames, gidx);
    if (!ref) return null;
    if (!widen(shapeOfEdgeSource(edge))) return ref;
    addImport('three/tsl', 'vec3');
    return `vec3(${ref})`;
  };

  /**
   * One custom-sink scope Fn: `const <name> = Fn(([<params>]) => {`, the
   * scope's chain one level deeper, `return <ret>;`, `});`. The chain CAPTURES
   * everything outside its scope from the flat body by closure (measured to
   * type-check and render on r184). Shared by the march's per-step Fns and the
   * splat's shade/shape/size.
   */
  const pushScopeFn = (out: string[], name: string, params: string, chainLines: readonly string[], ret: string): void => {
    out.push(`  const ${name} = Fn(([${params}]) => {`);
    for (const l of chainLines) out.push(`  ${l}`);
    out.push(`    return ${ret};`);
    out.push('  });');
  };

  // Build body lines. `bodyLines` is the CURRENT target: the flat shader body
  // for every node of an ordinary graph, and — when a custom sink (Raymarch
  // or Splat Output) DRIVES — one of its scope Fn bodies for the nodes its
  // partition puts there (utils/sdfPartition.ts, MARCH_SCOPES / splatScopes).
  // A node can appear in the plan twice (feeding two scopes), which is why
  // this is a plan rather than a plain loop; with no driving custom sink the
  // plan IS `sorted`, so emission is byte-identical to what it was before
  // either node existed.
  const mainLines: string[] = [];
  let bodyLines: string[] = mainLines;
  // Module-scope setup emitted BEFORE the shader Fn — the Data/Stripes nodes
  // build their `THREE.DataTexture` lookups here (closed over by the Fn body).
  const setupLines: string[] = [];
  // Image nodes share their module-scope Image element and Texture per
  // payload x texture spec (engine/imageTexturePlan.ts). Owners are placed on
  // their first EMITTED visit, so an owner is declared before any sharer reads
  // it. The Set is also what stops a node planned into two march scopes from
  // declaring its setup twice (a duplicate module-scope const).
  const imagePlanner = createImageTexturePlanner();
  const imageSetupEmitted = new Set<string>();
  /** Nodes whose module-scope setup lines are already out (`firstSetup`). */
  const setupEmittedFor = new Set<string>();

  // The custom sink and its scopes: one line array per scope, each the body
  // of a Fn whose PARAMETERS stand in for that scope's root nodes. For the
  // march that is one per-step socket and one parameter (`p`, the ray
  // position, or `dir`, the ray direction); for the Splat Output it is one Fn
  // per role (shade, shape, size) of `(p, pw, n, c)`. See
  // utils/sdfPartition.ts. ONLY THE ACTIVE SINK is partitioned: an inactive
  // custom sink emits nothing, and its feeders then land in the flat body as
  // ordinary consts (which is what lets the resync carry the node and its
  // wiring across an Apply — see useSyncEngine). `customNode` was resolved
  // before the naming pass.
  const marchNode = customNode && isMarchOutput(customNode) ? customNode : null;
  const splatNode = customNode && isSplatOutput(customNode) ? customNode : null;
  const specs: readonly ScopeSpec[] = marchNode ? MARCH_SCOPES : splatNode ? splatScopes(splatNode) : [];
  const part = customNode ? marchPartition(sorted, edges, customNode.id, specs) : null;
  const scopeLines = new Map<string, string[]>(specs.map((sp) => [sp.handle, []]));
  const specOfLines = new Map<string[], ScopeSpec>(specs.map((sp) => [scopeLines.get(sp.handle)!, sp]));
  const plan: [AppNode, string[]][] = [];
  for (const node of sorted) {
    if (!part) { plan.push([node, mainLines]); continue; }
    const inScopes = specs.filter((sp) => part.scopes.get(sp.handle)?.has(node.id));
    if (inScopes.length === 0) { plan.push([node, mainLines]); continue; }
    if (part.mainAlso.has(node.id)) plan.push([node, mainLines]);
    for (const sp of inScopes) plan.push([node, scopeLines.get(sp.handle)!]);
  }

  for (const [node, target] of plan) {
    bodyLines = target;
    const def = registry.get(node.data.registryType);
    if (!def || node.data.registryType === 'output' || node.data.registryType === 'split') continue;
    if (isCustomSink(node)) continue;
    // Inside a scope Fn a root IS its parameter (or, for a splat's per-corner
    // sources, a per-splat constant — see SPLAT_CONSTANTS).
    const scopeSpec = bodyLines === mainLines ? undefined : specOfLines.get(bodyLines);
    const rootBinding = scopeSpec ? bindingOfRoot(scopeSpec, def.type) : null;
    if (rootBinding) {
      for (const name of rootBinding.imports) addImport('three/tsl', name);
      bodyLines.push(`  const ${varNames.get(node.id)!} = ${rootBinding.expr};`);
      continue;
    }
    /**
     * An IMPLICIT geometry read — an unwired input whose default is
     * `positionGeometry`, `uv()` and the like (utils/sdfPartition.ts,
     * implicitRootOf) — emitted HERE: inside a scope with `implicitRoots` (a
     * Splat Output Fn, which runs in the splat's vertex stage, where the
     * geometry is the quad CORNER) it is bound to the same parameter or
     * per-splat constant a wired root would be, and its imports are added;
     * everywhere else — the flat body, a march Fn, a root type the scope does
     * not bind — it is null, and the branch emits its ordinary text. So the
     * flat copy of a node that is ALSO in a splat scope keeps today's text.
     */
    const implicitBinding = (root: string): string | null => {
      if (!scopeSpec?.implicitRoots) return null;
      const b = bindingOfRoot(scopeSpec, root);
      if (!b) return null;
      for (const name of b.imports) addImport('three/tsl', name);
      return b.expr;
    };
    /** The uv an unwired read samples: the scope's binding, else `uv()`. */
    const unwiredUv = (): string => {
      const scoped = implicitBinding('uv');
      if (!scoped) addImport('three/tsl', 'uv');
      return scoped ?? 'uv()';
    };
    /** Emit a node's module-scope setup (a baked texture) ONCE, however many
     *  scope Fns — or a scope Fn and the flat body — emit the node itself: a
     *  second copy would redeclare the same module-scope `const`, a
     *  SyntaxError that fails the whole module. */
    const firstSetup = !setupEmittedFor.has(node.id);
    setupEmittedFor.add(node.id);

    // See isOrphanedProperty. The name is still CLAIMED in the pre-pass above,
    // deliberately: an unemitted property keeps its reservation, so wiring it up
    // later cannot find its name taken by an ordinary node and silently rename
    // the public schema key from `speed` to `speed2`.
    if (isOrphanedProperty(node)) continue;

    const varName = varNames.get(node.id)!;

    // Unknown nodes: emit the preserved raw expression verbatim, but only
    // after verifying it still looks like the simple `funcName(args)` shape
    // codeToGraph produces. See engine/unknownExpression.ts for the threat
    // model — adversarial graph payloads otherwise get to inject arbitrary
    // statements into the generated module.
    //
    // The validator's parser is loaded on demand, so a pass that runs before it
    // lands answers `false` (fail closed) and this emits the inert fallback;
    // subscribers of onUnknownExpressionValidated re-run the pass once the real
    // verdict is available (useSyncEngine does).
    if (def.type === 'unknown') {
      const nv = getNodeValues(node);
      const rawExpr = valueStr(nv.rawExpression ?? 'float(0)');
      const safeExpr = isSafeUnknownExpression(rawExpr) ? rawExpr : 'float(0)';
      bodyLines.push(`  const ${varName} = ${safeExpr};`);
      continue;
    }

    const args = resolveArguments(node, varNames, def, gidx);

    if (def.type === 'uv') {
      // UV node: channel selector + tiling + rotation
      const nv = getNodeValues(node);
      addImport('three/tsl', 'uv');

      // Resolve channel (UV map index)
      const channelExpr = resolveExposedParam(node, 'channel', varNames, nv, gidx);
      const baseExpr = channelExpr === '0' ? 'uv()' : `uv(${channelExpr})`;

      // Resolve tiling and rotation (may be connected via input ports)
      const tilingU = resolveExposedParam(node, 'tilingU', varNames, nv, gidx);
      const tilingV = resolveExposedParam(node, 'tilingV', varNames, nv, gidx);
      const rotationExpr = resolveExposedParam(node, 'rotation', varNames, nv, gidx);
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
      for (const e of outEdges(gidx, node.id)) {
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
        // Inside a splat Fn the sample row is the splat's own (implicitBinding).
        let uvBase = 'uv()';
        for (const ci of [...usedCols].sort((a, b) => a - b)) {
          const col = decoded?.columns[ci];
          if (col && col.length > 0) {
            if (!bakedAny) {
              addImport('three/tsl', 'texture');
              uvBase = unwiredUv();
              addImport('three/tsl', 'vec2');
              bakedAny = true;
            }
            const capped = capToWidth(col, MAX_TEXTURE_WIDTH);
            const texVar = `_${varName}_tex${ci}`;
            if (firstSetup) {
              setupLines.push(
                `const ${texVar} = new globalThis.THREE.DataTexture(${f32Decode(float32ToBase64(capped))}, ${capped.length}, 1, globalThis.THREE.RedFormat, globalThis.THREE.FloatType);`,
              );
              setupLines.push(`${texVar}.needsUpdate = true;`);
            }
            bodyLines.push(`  const ${varName}_col${ci} = texture(${texVar}, vec2(${uvBase}.x, 0.5)).x;`);
          } else {
            bodyLines.push(`  const ${varName}_col${ci} = float(0.0);`);
          }
        }
      }
    } else if (def.type === 'imageNode') {
      // Image node: FLAT module-scope statements with top-level await, never an
      // async IIFE. The payload rides as an `fs-asset:` placeholder re-encoded
      // from the decoded bytes; ONE sample, swizzled per consumer and kept in
      // MEMBER form; uv math is per node. See docs/dev/images-and-textures.md.
      const nv = getNodeValues(node);
      const wide = imageSampleIsWide(gidx, node.id);
      const placed = imagePlanner.place(node.id, nv);
      if (!placed) {
        // Inert fallback — consumers still reference this var, so it must
        // exist (a missing declaration would be a runtime ReferenceError).
        // WIDE, it has to carry `.a` too, and a vec3 cannot: GLSL rejects
        // `vec3.w`. Alpha 1 matches the 1×1 fallback texture's opaque black.
        if (wide) {
          addImport('three/tsl', 'vec4');
          bodyLines.push(`  const ${varName} = vec4(0, 0, 0, 1);`);
        } else {
          addImport('three/tsl', 'vec3');
          bodyLines.push(`  const ${varName} = vec3(0, 0, 0);`);
        }
      } else {
        addImport('three/tsl', 'texture');
        const uvEdge = inEdge(gidx, node.id, 'uv');
        const uvRef = uvEdge ? resolveEdgeRef(uvEdge, varNames, gidx) : null;
        // A wired Direction replaces the whole uv path (below).
        const dirEdge = inEdge(gidx, node.id, 'dir');
        const dirRef = dirEdge ? resolveEdgeRef(dirEdge, varNames, gidx) : null;
        // Unwired inside a splat Fn: the splat's own sample point, never the
        // quad's (absent) uv attribute — see implicitBinding.
        const scopedUv = !uvRef && !dirRef ? implicitBinding('uv') : null;
        if (!uvRef && !scopedUv) addImport('three/tsl', 'uv');
        // The `1-u` correction is the baked-in DEFAULT, so Flip X mirrors relative
        // to the corrected look. Numbers only, never a stored string.
        const numVal = (key: string, dflt: number) => {
          const v = valueNum(nv[key]);
          return Number.isFinite(v) ? v : dflt;
        };
        const mapping = readImageUvMapping(nv);
        const gltf = mapping.orientation === 'gltf';
        // App orientation: the 1-u correction is baked in while Flip X is
        // UNCHECKED. glTF orientation: the model's own UVs already match the
        // (unflipped) file, so each ticked box mirrors — the >= 0.5 threshold
        // the card's thumbnail uses on both axes.
        const mirrorX = gltf ? numVal('flipX', 0) >= 0.5 : numVal('flipX', 0) < 0.5;
        const mirrorY = numVal('flipY', 0) >= 0.5;
        // Tile/offset can be sockets: a wired edge overrides the stored number.
        const tileX = numericParam(node, 'tileX', 1, varNames, gidx);
        const tileY = numericParam(node, 'tileY', 1, varNames, gidx);
        const offsetX = numericParam(node, 'offsetX', 0, varNames, gidx);
        const offsetY = numericParam(node, 'offsetY', 0, varNames, gidx);
        // A wired UV input wins over the UV set; the literal digit comes from
        // the reader's closed 1..3 table, never from the stored value.
        let uvExpr = uvRef ?? scopedUv ?? (mapping.uvSet > 0 ? `uv(${mapping.uvSet})` : 'uv()');
        // Every step below that writes a `vec2(` sets this, so vec2 is
        // imported exactly when used (a rotation-only transform needs only
        // mat2). On the legacy path it is the old `uvExpr !== base` test.
        let usesVec2 = false;
        // glTF texture transform, applied FIRST, as constants only. ROW-major:
        // all-number arguments build a THREE.Matrix2; never pass a NODE here
        // (pinned by imageUvTransformTsl.test.ts).
        if (mapping.transform) {
          const m = gltfUvMatrix(mapping.transform);
          if (m.m01 !== 0 || m.m10 !== 0) {
            addImport('three/tsl', 'mat2');
            uvExpr = `mat2(${num(m.m00)}, ${num(m.m01)}, ${num(m.m10)}, ${num(m.m11)}).mul(${uvExpr})`;
          } else if (m.m00 !== 1 || m.m11 !== 1) {
            uvExpr = `${uvExpr}.mul(vec2(${num(m.m00)}, ${num(m.m11)}))`;
            usesVec2 = true;
          }
          if (m.tx !== 0 || m.ty !== 0) {
            uvExpr = `${uvExpr}.add(vec2(${num(m.tx)}, ${num(m.ty)}))`;
            usesVec2 = true;
          }
        }
        if (mirrorX || mirrorY) {
          uvExpr = `${uvExpr}.mul(vec2(${mirrorX ? -1 : 1}, ${mirrorY ? -1 : 1})).add(vec2(${mirrorX ? 1 : 0}, ${mirrorY ? 1 : 0}))`;
          usesVec2 = true;
        }
        if (tileX !== '1' || tileY !== '1') {
          uvExpr = `${uvExpr}.mul(vec2(${tileX}, ${tileY}))`;
          usesVec2 = true;
        }
        if (offsetX !== '0' || offsetY !== '0') {
          uvExpr = `${uvExpr}.add(vec2(${offsetX}, ${offsetY}))`;
          usesVec2 = true;
        }
        if (usesVec2) addImport('three/tsl', 'vec2');
        // The texture-OBJECT settings (colour space, filter, wrap, flipY) are
        // the placement's spec (readImageTextureSpec, the ONE normaliser); the
        // setup lines are built from it alone, in imageTexturePlan.ts.
        const texVar = `_${varNames.get(placed.textureOwner)!}_tex`;
        if (!imageSetupEmitted.has(node.id)) {
          imageSetupEmitted.add(node.id);
          const owner = varNames.get(placed.imageOwner)!;
          const imgVar = `_${owner}_img`;
          const okVar = `_${owner}_ok`;
          if (placed.ownsImage) setupLines.push(...imageElementSetupLines(imgVar, okVar, placed.asset));
          if (placed.ownsTexture) setupLines.push(...imageTextureSetupLines(texVar, imgVar, okVar, placed.spec));
        }
        // A wired Direction samples the image as a SKY (equirect) and replaces
        // the UV path entirely — tile/offset/flip are UV notions.
        if (dirRef) {
          addImport('three/tsl', 'equirectUV');
          uvExpr = `equirectUV(${dirRef})`;
        }
        bodyLines.push(`  const ${varName} = texture(${texVar}, ${uvExpr}).${wide ? 'rgba' : 'rgb'};`);
      }
    } else if (def.type === 'stripes') {
      // Data Stripes: density-modulated bars + sequential color ramp. Stripe
      // density comes from a CPU-precomputed cumulative-phase ramp (prefix-sum
      // of the desired local frequency) baked from the upstream Data column —
      // so the bars stay continuous (no tearing). Derivative AA + moiré
      // fade-to-average defeat shimmering when the period drops below a pixel.
      const nv = getNodeValues(node);
      const bf = valueNum(nv.baseFrequency ?? 80);
      const dens = valueNum(nv.density ?? 1.5);
      // Ramp ends go out as `color(0x…)` (sRGB decoded), never `vec3(hex/255)`;
      // the unstored fallback is the REGISTRY default, never a literal here.
      // See docs/dev/node-types.md.
      const lo = colorRefOf(inEdge(gidx, node.id, 'lowColor'), nv.lowColor, def.defaultValues?.lowColor);
      const hi = colorRefOf(inEdge(gidx, node.id, 'highColor'), nv.highColor, def.defaultValues?.highColor);
      // Radial ("target"/tree-ring) mode: index the data by distance from a
      // choosable center instead of uv.x, so the bands become concentric rings.
      const { radial, expr: coordExpr } = rampCoord(nv, unwiredUv());
      // How strongly the stripes darken the value-color. 0 = a clean value
      // heatmap (no stripes, colour alone shows the data); ~0.75 = bold stripes.
      const lineStrength = Math.min(Math.max(valueNum(nv.lineStrength ?? 0.75), 0), 1);
      addImport('three/tsl', 'float');
      addImport('three/tsl', 'color');
      addImport('three/tsl', 'mix');
      addImport('three/tsl', 'dFdx');
      addImport('three/tsl', 'dFdy');
      if (radial) addImport('three/tsl', 'vec2');

      const signalEdge = inEdge(gidx, node.id, 'signal');
      const signalRef = signalEdge ? resolveEdgeRef(signalEdge, varNames, gidx) : null;

      // Trace the signal to a Data column → bake a cumulative-phase ramp (stripe
      // density) AND a normalized-value ramp (color). Both are sampled at the
      // SAME coordinate, so linear and radial modes stay in sync.
      let phaseTexVar: string | null = null;
      let valueTexVar: string | null = null;
      let totalCycles = bf;
      const traced = traceSignalColumn(signalEdge, gidx);
      if (traced) {
        const ramp = buildPhaseRamp(traced.cnorm, bf, dens);
        totalCycles = ramp.totalCycles;
        addImport('three/tsl', 'texture');
        addImport('three/tsl', 'vec2');
        phaseTexVar = `_${varName}_phase`;
        valueTexVar = `_${varName}_value`;
        if (firstSetup) {
          bakeHalfFloatTexture(setupLines, phaseTexVar, ramp.phase01);
          bakeHalfFloatTexture(setupLines, valueTexVar, traced.cnorm);
        }
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
      bodyLines.push(`  const ${coord} = ${coordExpr};`);

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
      bodyLines.push(`  const ${lnS} = mix(${ln}, float(0.5), ${fw}.mul(2.0).sub(1.0).clamp(0.0, 1.0));`);
      bodyLines.push(`  const ${br} = float(1.0).sub(${lnS}.mul(${num(lineStrength)}));`);
      bodyLines.push(`  const ${t} = ${colorT};`);
      bodyLines.push(`  const ${col} = mix(${lo}, ${hi}, ${t});`);
      bodyLines.push(`  const ${varName} = ${col}.mul(${br});`);
    } else if (def.type === 'dataviz') {
      // Data Viz: a single Data column distributed along one axis (or radially)
      // as a continuous colour ramp with a full tone curve. Unlike Stripes there
      // are no bars — colour alone reads the value. The upstream column is baked
      // into a normalized HalfFloat value texture (filterable) and sampled at the
      // coord; the tone curve is applied as a chain of TSL ops before the mix.
      const nv = getNodeValues(node);
      const scale = valueNum(nv.scale ?? 1);
      const offset = valueNum(nv.offset ?? 0);
      const contrast = valueNum(nv.contrast ?? 1);
      const lowCut = valueNum(nv.lowCutoff ?? 0);
      const highCut = valueNum(nv.highCutoff ?? 1);
      // Midpoint drives a gamma so the chosen input value maps to output 0.5
      // (lower midpoint → brighter midtones). Kept strictly inside (0,1) so the
      // log is finite.
      const midpoint = Math.min(Math.max(valueNum(nv.midpoint ?? 0.5), 1e-3), 1 - 1e-3);
      // sRGB → linear via `color(0x…)`; see the matching note in the Stripes
      // branch above.
      // A wired ramp colour wins over the stored swatch (the exposedPorts
      // rule); unwired emits the identical `color(0x…)` as before, so a node
      // with nothing wired is byte-stable. Fallback = the registry default;
      // see the Stripes branch above for why it is not a literal here.
      const lo = colorRefOf(inEdge(gidx, node.id, 'lowColor'), nv.lowColor, def.defaultValues?.lowColor);
      const hi = colorRefOf(inEdge(gidx, node.id, 'highColor'), nv.highColor, def.defaultValues?.highColor);
      const { radial, expr: coordExpr } = rampCoord(nv, unwiredUv());
      addImport('three/tsl', 'color');
      addImport('three/tsl', 'mix');
      if (radial) addImport('three/tsl', 'vec2');

      // Trace the signal to a Data column → bake a normalized-value ramp (color).
      const signalEdge = inEdge(gidx, node.id, 'signal');
      const signalRef = signalEdge ? resolveEdgeRef(signalEdge, varNames, gidx) : null;
      let valueTexVar: string | null = null;
      const traced = traceSignalColumn(signalEdge, gidx);
      if (traced) {
        addImport('three/tsl', 'texture');
        addImport('three/tsl', 'vec2');
        valueTexVar = `_${varName}_value`;
        if (firstSetup) bakeHalfFloatTexture(setupLines, valueTexVar, traced.cnorm);
      }

      const coord = `_${varName}_coord`;
      bodyLines.push(`  const ${coord} = ${coordExpr};`);

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
      bodyLines.push(`  const ${varName} = mix(${lo}, ${hi}, ${t});`);
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
      const reverse = valueNum(nv.reverse ?? 0) >= 0.5;
      const levels = Math.floor(valueNum(nv.levels ?? 0));
      const lutVar = `_${varName}_lut`;
      // `reverse` is baked into the table, so it costs nothing per fragment and
      // the emitted TSL is identical either way.
      if (firstSetup) bakeColormapTexture(setupLines, lutVar, buildColormapLut(cmap, reverse));
      addImport('three/tsl', 'texture');
      addImport('three/tsl', 'vec2');

      const valueEdge = inEdge(gidx, node.id, 'value');
      let tExpr = scalarRefOf(valueEdge);
      if (!tExpr) {
        // Unwired: ramp across uv.x, so a freshly dropped Colormap node shows
        // the map it is set to instead of a flat colour. (Inside a splat Fn,
        // across the splat's own sample point — implicitBinding.)
        tExpr = `${unwiredUv()}.x`;
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
      const valueEdge = inEdge(gidx, node.id, 'value');
      const traced = traceSignalColumn(valueEdge, gidx);
      const stats = traced ? columnStats(traced.capped) : null;
      const manual = {
        lo: valueNum(nv.domainMin ?? 0),
        hi: valueNum(nv.domainMax ?? 1),
      };
      const plan = planNormalize(mode, stats, manual);
      const doClamp = valueNum(nv.clamp ?? 1) >= 0.5;

      let src = scalarRefOf(valueEdge);
      if (!src) {
        src = `${unwiredUv()}.x`;
      }

      // A user-authored formula: used only when it parses AND folds to finite
      // constants; anything else falls through to the built-in chains, byte for
      // byte. PARSE-THEN-RE-EMIT (utils/dataRangeFormula.ts), cheap enough uncached.
      let expr: string | null = null;
      let rejected: FormulaErrorCode | null = null;
      const parsed = parseFormula(nv.formula);
      if (parsed.ok) {
        const emitted = emitFormula(parsed.ast, src, formulaEnv(plan, stats, manual), (name) =>
          addImport('three/tsl', name),
        );
        if (emitted.ok) expr = emitted.code;
        else rejected = emitted.err.code;
      } else if (hasCustomFormula(nv.formula)) {
        rejected = parsed.err.code;
      }

      // Say WHY in the generated source when an authored formula was refused:
      // half the rejections depend on the wired column, which the canvas chip
      // cannot see. An absent key still emits exactly what it always did.
      if (rejected && hasCustomFormula(nv.formula)) {
        bodyLines.push(
          `  // Data Range: custom formula ignored (${formulaErrorSummary(rejected)}) — using the ${mode} formula.`,
        );
      }

      if (expr === null) {
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
      addImport('three/tsl', 'mix');

      const levelsExpr = numericParam(node, 'levels', 10, varNames, gidx);
      const widthExpr = numericParam(node, 'width', 1.5, varNames, gidx);
      const offsetExpr = numericParam(node, 'offset', 0, varNames, gidx);

      const valueEdge = inEdge(gidx, node.id, 'value');
      let src = scalarRefOf(valueEdge);
      if (!src) {
        src = `${unwiredUv()}.x`;
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
        `  const ${varName} = mix(${ln}, ${avg}, ${fw}.mul(2.0).sub(1.0).clamp(0.0, 1.0));`,
      );
    } else if (def.type === 'wireframe') {
      // Wireframe: Isolines' construction on a VECTOR, combined with `max` so two
      // crossing lines read as one. The modes differ only in the distance vector:
      //   grid  — 0.5 - |fract(uv * density) - 0.5|, per uv axis (vec2)
      //   edges — the barycentric coordinate, 0 exactly on an edge (vec3)
      // three widens the float constants beside it (MathNode.getInputType).
      const edges = isWireframeEdges(getNodeValues(node));
      addImport('three/tsl', 'dFdx');
      addImport('three/tsl', 'dFdy');
      addImport('three/tsl', 'mix');

      const widthExpr = numericParam(node, 'width', 1.5, varNames, gidx);

      const p = `_${varName}_p`;
      const fw = `_${varName}_fw`;
      const hw = `_${varName}_hw`;
      const ln = `_${varName}_ln`;
      const avg = `_${varName}_avg`;
      const c = `_${varName}_c`;

      if (edges) {
        // The attribute the loader injects when it sees `barycentric: true` in
        // this module's return object. If it is ABSENT — an exported module on
        // a page whose loader does not inject it — three warns and generates a
        // CONST of the node type, i.e. vec3(0), which reads as "on all three
        // edges" and would flood the whole surface. The sum guard below turns
        // that into "no wireframe at all", which is the failure worth having.
        addImport('three/tsl', 'attribute');
        addImport('three/tsl', 'vec3');
        bodyLines.push(`  const ${p} = attribute('bary', 'vec3');`);
      } else {
        addImport('three/tsl', 'vec2');
        const densityExpr = numericParam(node, 'density', 10, varNames, gidx);
        bodyLines.push(`  const ${p} = ${unwiredUv()}.mul(${densityExpr});`);
      }

      // Distance to the nearest line, per axis (grid) or per edge (edges).
      // Taken from the CONTINUOUS phase in grid mode — never a derivative of
      // fract(), whose one-per-cell jump would draw a false line through every
      // real one. A barycentric is already continuous, so it is used as-is.
      const dist = edges ? p : `_${varName}_d`;
      if (!edges) {
        bodyLines.push(`  const ${dist} = vec2(0.5).sub(${p}.fract().sub(0.5).abs());`);
      }
      // Phase change per pixel. Floored away from zero for the reason Isolines
      // documents: on a face exactly parallel to the screen an axis can have a
      // zero derivative, and the smoothstep edges would then collapse onto each
      // other — a divide by zero inside the hardware step.
      bodyLines.push(
        `  const ${fw} = dFdx(${dist}).abs().add(dFdy(${dist}).abs()).max(0.00001);`,
      );
      bodyLines.push(`  const ${hw} = ${fw}.mul(${widthExpr}).mul(0.5);`);
      const zero = edges ? 'vec3(0.0)' : 'vec2(0.0)';
      bodyLines.push(`  const ${ln} = ${dist}.smoothstep(${zero}, ${hw}).oneMinus();`);
      // Average coverage of one cell — what a region should read as once its
      // lines are packed tighter than a pixel, instead of aliasing into moire.
      bodyLines.push(`  const ${avg} = ${fw}.mul(${widthExpr}).clamp(0.0, 1.0);`);
      bodyLines.push(
        `  const ${c} = mix(${ln}, ${avg}, ${fw}.mul(2.0).sub(1.0).clamp(0.0, 1.0));`,
      );
      if (edges) {
        // Real barycentrics sum to exactly 1; the missing-attribute const sums
        // to 0. Clamping that sum gives 1 or 0 with no extra import and no
        // branch, so a module that lands on geometry without the attribute
        // draws nothing rather than a solid fill.
        const g = `_${varName}_g`;
        bodyLines.push(`  const ${g} = ${p}.x.add(${p}.y).add(${p}.z).clamp(0.0, 1.0);`);
        bodyLines.push(`  const ${varName} = ${c}.x.max(${c}.y).max(${c}.z).mul(${g});`);
      } else {
        bodyLines.push(`  const ${varName} = ${c}.x.max(${c}.y);`);
      }
    } else if (def.type === 'append') {
      // Append node: concatenate operands into a vector. The constructor follows
      // the TOTAL component count (a vec2 + float must become vec3, not vec2),
      // and both it and the argument list are capped at vec4.
      const raw = resolveArguments(node, varNames, def, gidx);
      const channels = appendOperandChannels(node, def, gidx, shapeOfEdgeSource);
      const { ctor, args } = buildAppendConstructor(raw, channels);
      addImport('three/tsl', ctor);
      bodyLines.push(`  const ${varName} = ${ctor}(${args.join(', ')});`);
    } else if (def.type === 'rayDirection') {
      // A module helper call (engine/moduleHelpers.ts), never the bare inline
      // maths — so codeToGraph reads it back as this one node.
      bodyLines.push(`  const ${varName} = rayDirection();`);
    } else if (def.type === 'time') {
      // Time: BEFORE the generic zero-input branch, which would emit `time(1)`;
      // `time` is a uniform node OBJECT, not a callable (a runtime TypeError).
      // Speed 1, absent or non-finite emits the bare reference byte for byte;
      // otherwise the METHOD CHAIN `time.mul(k)`, the one shape codeToGraph
      // collapses back. See docs/dev/node-types.md, Time node speed.
      const speedEdge = inEdge(gidx, node.id, 'speed');
      const speedRef = speedEdge ? resolveEdgeRef(speedEdge, varNames, gidx) : null;
      const rawSpeed = Number(getNodeValues(node).speed);
      const speed = Number.isFinite(rawSpeed) ? rawSpeed : 1;
      bodyLines.push(
        speedRef
          ? `  const ${varName} = ${def.tslFunction}.mul(${speedRef});`
          : speed === 1
            ? `  const ${varName} = ${def.tslFunction};`
            : `  const ${varName} = ${def.tslFunction}.mul(${num(speed)});`,
      );
    } else if (isSoundNodeType(def.type)) {
      // Sound: four ORDINARY numeric uniforms (`sound1_bass = uniform(0)`), one
      // per CONSUMED channel, so only numbers cross the sandbox. BEFORE the
      // generic zero-input branch; 0 is silence. See docs/dev/node-types.md.
      const wanted = new Set(
        outEdges(gidx, node.id).map((e) => soundChannelForHandle(e.sourceHandle)),
      );
      if (wanted.size > 0) {
        // The generic import collection keys off `def.tslFunction`, which is
        // empty here, so `uniform` must be requested explicitly.
        addImport('three/tsl', 'uniform');
        // Gain is a SEPARATE statement: the uniform line must stay a bare
        // literal for buildShaderModule's `uniformLineRe` to rewrite it.
        const gainExpr = micGainExpr(node, varNames, gidx);
        for (const ch of SOUND_CHANNELS) {
          if (!wanted.has(ch)) continue;
          const u = soundUniformName(varName, ch);
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

      // Resolve position: from exposed port edge, or default positionGeometry.
      // UNWIRED inside a splat Fn, the stored identifier is an implicit read
      // of that root and is bound like one — `mx_noise_float(p)`, the splat's
      // centre, never the quad corner `positionGeometry` is in that vertex
      // stage (implicitBinding; the flat copy keeps today's text).
      const posEdge = inEdge(gidx, node.id, 'pos');
      const posWired = !!posEdge && resolveEdgeRef(posEdge, varNames, gidx) !== null;
      let posExpr = resolveExposedParam(node, 'pos', varNames, nv, gidx);
      const scopedPos = posWired ? null : implicitBinding(posExpr);
      if (scopedPos) {
        posExpr = scopedPos;
      } else if (/^\d+(\.\d+)?$/.test(posExpr) || posExpr === 'positionGeometry') {
        posExpr = 'positionGeometry';
        addImport('three/tsl', 'positionGeometry');
      }

      // Apply scale via method chain so the result keeps the position's vector type
      const scaleExpr = resolveExposedParam(node, 'scale', varNames, nv, gidx);
      if (scaleExpr !== '1') {
        posExpr = `${posExpr}.mul(${scaleExpr})`;
      }

      // The 0–1 remap wraps the FINISHED call, never posExpr, and is gated on the
      // def TYPE as well as the stored flag (codeToGraph's gate is symmetric). An
      // absent flag emits the bare call. See docs/dev/node-types.md, noise range.
      let noiseExpr = `${def.tslFunction}(${posExpr})`;
      if (isUnsignedNoise(def.type, nv)) {
        noiseExpr = `${noiseExpr}.mul(0.5).add(0.5)`;
      }
      bodyLines.push(`  const ${varName} = ${noiseExpr};`);
    } else if (def.type === 'property_color') {
      // Colour uniform. The generic branch below would emit `uniform(0xff0000)`
      // — a FLOAT uniform holding 16711680 — so wrap the literal in color() to
      // get a real vec3-valued uniform. buildShaderModule rewrites this whole
      // line to `params.<name>` and records the hex as the schema default.
      const nv = getNodeValues(node);
      addImport('three/tsl', 'color');
      bodyLines.push(`  const ${varName} = uniform(color(${hexLiteral(nv.hex)}));`);
    } else if (def.inputs.length === 0 && def.defaultValues) {
      // Type constructors with default values. `values` is ADVERSARIAL and the
      // XR popup runs this module at the real origin, so the argument is a
      // literal WE construct. The REGISTRY default's type picks which: testing
      // the stored value let `"0xff0000); evil(); color(0"` through verbatim.
      const nodeValues = getNodeValues(node);
      const defaultKey = Object.keys(def.defaultValues)[0];
      const dflt = Object.values(def.defaultValues)[0];
      const val = nodeValues?.[defaultKey] ?? dflt;
      const n = Number(val);
      const formatted = typeof dflt === 'string' && dflt.startsWith('#')
        ? hexLiteral(val)
        : num(Number.isFinite(n) ? n : Number(dflt));
      bodyLines.push(`  const ${varName} = ${def.tslFunction}(${formatted});`);
    } else if (def.type === 'hsl' || def.type === 'toHsl') {
      // HSL↔RGB: neither `hsl` nor `toHsl` exists in three/tsl, so the module
      // carries helper Fns (engine/moduleHelpers.ts) and codeToGraph skips them
      // by name.
      const call = def.type === 'hsl' ? 'hsl' : 'toHsl';
      const fallback = def.type === 'hsl' ? '0, 0, 0' : 'vec3(0, 0, 0)';
      const argExpr = def.type === 'hsl'
        ? args.join(', ')
        : (args[0] ?? fallback);
      bodyLines.push(`  const ${varName} = ${call}(${argExpr});`);
    } else if (def.type === 'sdBox') {
      // ONE Box def, two helpers: the wired position's WIDTH picks sdBox2
      // (vec2) or sdBox3 (anything else, incl. unwired). Each helper takes its
      // own port list (2D has no Half depth), read from the same table the
      // parser maps the name back through.
      const pEdge = inEdge(gidx, node.id, 'p');
      const width = pEdge ? shapeOfEdgeSource(pEdge) : 3;
      const callee = width === 2 ? 'sdBox2' : 'sdBox3';
      const boxArgs = resolveArguments(node, varNames, def, gidx, helperCallPorts(callee, def.inputs));
      usedHelperNames.add(callee);
      bodyLines.push(`  const ${varName} = ${callee}(${boxArgs.join(', ')});`);
    } else if (def.modes) {
      // A def with MODES calls the variant its mode selects (the default mode
      // is the def's own tslFunction), with that variant's port list — a
      // variant may take fewer arguments (xor has no smoothness).
      const callee = helperNameFor(def, getNodeValues(node));
      const modeArgs = resolveArguments(node, varNames, def, gidx, helperCallPorts(callee, def.inputs));
      usedHelperNames.add(callee);
      bodyLines.push(`  const ${varName} = ${callee}(${modeArgs.join(', ')});`);
    } else {
      // Regular function call
      if (MODULE_HELPERS.has(def.tslFunction)) usedHelperNames.add(def.tslFunction);
      bodyLines.push(`  const ${varName} = ${def.tslFunction}(${args.join(', ')});`);
    }
  }

  // The helper block, in table order. hsl/toHsl and rayDirection are emitted
  // by dedicated branches that never touch usedHelperNames, so they are
  // recorded here by def instead.
  for (const n of sorted) {
    const d = registry.get(n.data.registryType);
    if (d && (d.type === 'hsl' || d.type === 'toHsl' || d.type === 'rayDirection')) usedHelperNames.add(d.tslFunction);
  }
  for (const [name, helper] of MODULE_HELPERS) {
    if (!usedHelperNames.has(name)) continue;
    usedHelpers.push(name);
    for (const imp of helper.imports) addImport('three/tsl', imp);
  }

  // ===== Raymarch Output =====
  // Emitted AFTER every ordinary node: its per-step Fns capture the flat body by
  // closure. ONE IIFE returning ONE vec4 (RGB + coverage), surface and volume
  // shaded inside it. See docs/dev/sdf-and-raymarch.md.
  let sdfEmission: { lines: string[]; discardLine: string | null; returnLine: string } | null = null;
  if (marchNode && part) {
    const node = marchNode;
    const base = varNames.get(node.id)!;
    const nv = getNodeValues(node);
    const fieldEdge = inEdge(gidx, node.id, 'field');
    const densityEdge = inEdge(gidx, node.id, 'density');
    const fieldRef = fieldEdge ? resolveEdgeRef(fieldEdge, varNames, gidx) : null;
    const densityRef = densityEdge ? resolveEdgeRef(densityEdge, varNames, gidx) : null;
    if (fieldRef || densityRef) {
      const paramExpr = (key: string, dflt: number): string => numericParam(node, key, dflt, varNames, gidx);
      const lines: string[] = [];
      // A per-step chain (Field/Density scalar, or Color/Emissive/Glow colour),
      // a function of the ray POSITION `p`.
      const posFn = (handle: string, suffix: string, chainLines: string[], set: ReadonlySet<string>): string | null => {
        const edge = inEdge(gidx, node.id, handle);
        const widened = widenedRefOf(edge);
        if (!edge || !widened) return null;
        if (!set.has(edge.source)) {
          // Captured (not p-dependent): still its own declarator, so codeToGraph
          // reads the edge back off `const rm1Color = color1;`.
          lines.push(`  const ${base}${suffix} = ${widened};`);
          return `@CAP@${base}${suffix}`;
        }
        pushScopeFn(lines, `${base}${suffix}`, 'p', chainLines, widened);
        return `${base}${suffix}`;
      };
      // Field: scalar distance.
      let fieldName: string | null = null;
      if (fieldRef) {
        const scoped = part.scopes.get('field')!.has(fieldEdge!.source);
        const scalarRef = shapeOfEdgeSource(fieldEdge!) === 1 ? fieldRef : `${fieldRef}.x`;
        if (scoped) {
          pushScopeFn(lines, `${base}Field`, 'p', scopeLines.get('field')!, scalarRef);
          fieldName = `${base}Field`;
        } else {
          // Not p-dependent — a constant field. Wrap so the march can call it.
          lines.push(`  const ${base}Field = Fn(([p]) => ${scalarRef});`);
          fieldName = `${base}Field`;
        }
      }
      let densityName: string | null = null;
      if (densityRef) {
        const scoped = part.scopes.get('density')!.has(densityEdge!.source);
        const scalarRef = shapeOfEdgeSource(densityEdge!) === 1 ? densityRef : `${densityRef}.x`;
        pushScopeFn(lines, `${base}Density`, 'p', scoped ? scopeLines.get('density')! : [], scalarRef);
        densityName = `${base}Density`;
      }
      // Colour/Emissive/Glow: p-functions, or captured refs (marked @CAP@), or
      // the Color swatch's stored value, or a literal fallback.
      const cap = (v: string | null, at: string): string | null =>
        v == null ? null : v.startsWith('@CAP@') ? v.slice(5) : `${v}(${at})`;
      const storedColor = storedHex6(nv.color);
      let colorName: string | null = posFn('color', 'Color', scopeLines.get('color')!, part.scopes.get('color')!);
      if (colorName == null && storedColor) {
        addImport('three/tsl', 'color');
        lines.push(`  const ${base}Color = color(${hexLiteral(storedColor)});`);
        colorName = `@CAP@${base}Color`;
      }
      const emissiveName = posFn('emissive', 'Emissive', scopeLines.get('emissive')!, part.scopes.get('emissive')!);
      const glowName = posFn('glow', 'Glow', scopeLines.get('glow')!, part.scopes.get('glow')!);
      // Background: a function of the ray's FINAL DIRECTION `dir`.
      let bgName: string | null = null;
      {
        const edge = inEdge(gidx, node.id, 'background');
        const widened = widenedRefOf(edge);
        if (edge && widened) {
          if (part.scopes.get('background')!.has(edge.source)) {
            pushScopeFn(lines, `${base}Background`, 'dir', scopeLines.get('background')!, widened);
            bgName = `@FN@${base}Background`;
          } else {
            lines.push(`  const ${base}Background = ${widened};`);
            bgName = `${base}Background`;
          }
        }
      }
      // The march's own light and ambient: a captured chain, the stored
      // swatch, or NOTHING (the literal default is then inlined below, so an
      // untouched socket emits no declarator and round-trips as untouched).
      const capColor = (handle: string, suffix: string): string | null => {
        const widened = widenedRefOf(inEdge(gidx, node.id, handle));
        if (widened) {
          lines.push(`  const ${base}${suffix} = ${widened};`);
          return `${base}${suffix}`;
        }
        const stored = storedHex6(nv[handle]);
        if (stored) {
          addImport('three/tsl', 'color');
          lines.push(`  const ${base}${suffix} = color(${hexLiteral(stored)});`);
          return `${base}${suffix}`;
        }
        return null;
      };
      const lightColExpr = capColor('lightColor', 'LightColor') ?? 'vec3(0.85, 0.85, 0.85)';
      const ambientExpr = capColor('ambient', 'Ambient') ?? 'vec3(0.15, 0.15, 0.15)';
      const steps = paramExpr('steps', 64);
      const stepSize = paramExpr('stepSize', 0.03);
      const eps = paramExpr('epsilon', 0.002);
      const bend = paramExpr('bend', 0);
      const horizon = paramExpr('horizon', 0);
      const win = paramExpr('window', 1);
      const fieldR = paramExpr('fieldRadius', 1);
      const lightX = paramExpr('lightX', 0.6);
      const lightY = paramExpr('lightY', 0.8);
      const lightZ = paramExpr('lightZ', 0.5);
      const aoAmt = paramExpr('ao', 0);
      const shadowAmt = paramExpr('shadow', 0);
      const stepScale = paramExpr('stepScale', 1);
      const aoOn = Number(aoAmt) !== 0 || !!inEdge(gidx, node.id, 'ao');
      const shadowOn = Number(shadowAmt) !== 0 || !!inEdge(gidx, node.id, 'shadow');
      // ---- the march ----
      lines.push(`  const ${base} = Fn(() => {`);
      lines.push(`    const stepSize = float(${stepSize});`);
      lines.push(`    const eps = float(${eps});`);
      lines.push(`    const bend = float(${bend});`);
      lines.push(`    const horizon = float(${horizon});`);
      lines.push(`    const win = float(${win});`);
      lines.push(`    const fieldR = float(${fieldR});`);
      lines.push(`    const stepScale = float(${stepScale});`);
      lines.push(`    const lightX = float(${lightX});`);
      lines.push(`    const lightY = float(${lightY});`);
      lines.push(`    const lightZ = float(${lightZ});`);
      lines.push(`    const ao = float(${aoAmt});`);
      lines.push(`    const shadow = float(${shadowAmt});`);
      lines.push('    const cam = modelWorldMatrixInverse.mul(vec4(cameraPosition, 1)).xyz;');
      lines.push('    const rd = normalize(sub(positionLocal, cam)).toVar();');
      lines.push('    const pos = select(frontFacing, positionLocal, cam).toVar();');
      lines.push('    const col = vec3(0, 0, 0).toVar();');
      lines.push('    const alpha = float(0).toVar();');
      lines.push('    const surfHit = float(0).toVar();');
      lines.push('    const hp = vec3(0, 0, 0).toVar();');
      lines.push(`    Loop(int(${steps}), () => {`);
      lines.push('      const r = length(pos);');
      lines.push('      If(r.greaterThan(mul(win, 1.05)), () => { Break(); });');
      if (Number(horizon) !== 0 || inEdge(gidx, node.id, 'horizon')) {
        lines.push('      If(r.lessThan(horizon), () => { alpha.assign(1); surfHit.assign(0); Break(); });');
      }
      // The gap to the field bubble: outside Field radius the ray jumps
      // straight to it, so a large Window costs nothing on the way in.
      lines.push('      const gap = max(sub(r, fieldR), float(0));');
      if (fieldName) {
        lines.push(`      const d = ${fieldName}(pos);`);
        lines.push('      If(d.lessThan(eps), () => { surfHit.assign(1); hp.assign(pos); Break(); });');
      }
      // Advance: sphere-trace when only Field is wired; a fixed step whenever a
      // volume integrates (its density is weighted by the step actually taken).
      // Step scale shrinks the sphere-trace advance for bound-only fields
      // (deformed, scaled, smooth-combined) that would otherwise show holes;
      // the jump to the field bubble is never scaled.
      lines.push(fieldName && !densityName
        ? '      const adv = max(mul(max(d, eps), stepScale), gap);'
        : '      const adv = max(stepSize, gap);');
      if (densityName) {
        lines.push(`      const dens = clamp(mul(${densityName}(pos), adv), 0, 1);`);
        lines.push('      const w = mul(sub(1, alpha), dens);');
        const glowExpr = cap(glowName, 'pos') ?? 'vec3(1, 1, 1)';
        lines.push(`      col.addAssign(mul(${glowExpr}, w));`);
        lines.push('      alpha.addAssign(w);');
      }
      // Gravity: pull the direction toward the origin (bend / r²) each step.
      if (Number(bend) !== 0 || inEdge(gidx, node.id, 'bend')) {
        lines.push('      const steer = mul(normalize(pos), div(mul(bend, adv), max(mul(r, r), 0.01)));');
        lines.push('      rd.assign(normalize(sub(rd, steer)));');
      }
      lines.push('      pos.addAssign(mul(rd, adv));');
      lines.push('      If(alpha.greaterThan(0.995), () => { Break(); });');
      lines.push('    });');
      // ---- shade the surface, composite volume over it, fill the sky ----
      if (fieldName) {
        // Gradient normal (four field taps) → a simple key-plus-ambient lambert.
        lines.push(`    const nrm = Fn(([q]) => {`);
        lines.push('      const e = float(0.001);');
        lines.push('      const k1 = vec3(1, -1, -1); const k2 = vec3(-1, -1, 1); const k3 = vec3(-1, 1, -1); const k4 = vec3(1, 1, 1);');
        lines.push(`      const g = add(add(mul(k1, ${fieldName}(add(q, mul(k1, e)))), mul(k2, ${fieldName}(add(q, mul(k2, e))))), add(mul(k3, ${fieldName}(add(q, mul(k3, e)))), mul(k4, ${fieldName}(add(q, mul(k4, e))))));`);
        lines.push('      return normalize(g);');
        lines.push('    })(hp);');
        lines.push('    const key = normalize(vec3(lightX, lightY, lightZ));');
        let aoTerm = '';
        if (aoOn) {
          // IQ's 5-tap ambient occlusion along the normal, unrolled: how much
          // of the space above the hit is inside the field, decaying with
          // distance. Scales the AMBIENT only, never the key light.
          const taps = [0.01, 0.04, 0.07, 0.1, 0.13];
          const terms = taps.map((hr, i) => `mul(sub(float(${hr}), ${fieldName}(add(hp, mul(nrm, float(${hr}))))), float(${(0.95 ** i).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}))`);
          lines.push(`    const occ = ${terms.reduce((a, b) => `add(${a}, ${b})`)};`);
          lines.push('    const aoF = clamp(sub(float(1), mul(occ, mul(float(3), ao))), float(0), float(1));');
          aoTerm = 'aoF';
        }
        let shadowTerm = '';
        if (shadowOn) {
          // A second march from the hit toward the light: the closest miss
          // along the way, divided by the distance travelled times Shadow
          // softness, is the penumbra. Scales the KEY light only.
          lines.push('    const sh = float(1).toVar();');
          lines.push('    const st = float(0.02).toVar();');
          lines.push('    Loop(int(24), () => {');
          lines.push(`      const hd = ${fieldName}(add(hp, mul(key, st)));`);
          lines.push('      If(hd.lessThan(float(0.0005)), () => { sh.assign(0); Break(); });');
          lines.push('      sh.assign(min(sh, div(hd, mul(shadow, st))));');
          lines.push('      st.addAssign(clamp(hd, float(0.01), float(0.1)));');
          lines.push('      If(st.greaterThan(float(3)), () => { Break(); });');
          lines.push('    });');
          lines.push('    const shF = clamp(sh, float(0), float(1));');
          shadowTerm = 'shF';
        }
        const keyTerm = shadowTerm ? `mul(max(dot(nrm, key), float(0)), ${shadowTerm})` : 'max(dot(nrm, key), float(0))';
        const ambTerm = aoTerm ? `mul(${ambientExpr}, ${aoTerm})` : ambientExpr;
        lines.push(`    const lam = add(mul(${lightColExpr}, ${keyTerm}), ${ambTerm});`);
        const surfCol = cap(colorName, 'hp') ?? 'vec3(0.8, 0.8, 0.8)';
        const surfEmis = cap(emissiveName, 'hp');
        lines.push(`    const surf = ${surfEmis ? `add(mul(${surfCol}, lam), ${surfEmis})` : `mul(${surfCol}, lam)`};`);
        lines.push('    const surfCov = surfHit;');
        lines.push('    col.assign(add(col, mul(surf, mul(sub(1, alpha), surfCov))));');
        lines.push('    alpha.assign(max(alpha, surfCov));');
      }
      // Sky: what the (bent) ray left toward, in world space.
      lines.push('    const rdWorld = transformDirection(rd, modelWorldMatrix);');
      const bgExpr = bgName ? (bgName.startsWith('@FN@') ? `${bgName.slice(4)}(rdWorld)` : bgName) : null;
      if (bgExpr) lines.push(`    const bg = ${bgExpr};`);
      lines.push(`    return vec4(add(col, ${bgExpr ? 'mul(bg, sub(1, alpha))' : 'vec3(0, 0, 0)'}), ${bgExpr ? 'float(1)' : 'alpha'});`);
      lines.push('  })();');
      lines.push(`  const ${base}Col = ${base}.xyz;`);
      const imports = [
        'Fn', 'Loop', 'If', 'Break', 'int', 'float', 'vec3', 'vec4', 'add', 'mul', 'sub', 'div', 'max', 'clamp',
        'length', 'normalize', 'select', 'frontFacing', 'cameraPosition', 'modelWorldMatrixInverse', 'modelWorldMatrix',
        'transformDirection', 'positionLocal', 'color',
      ];
      if (fieldName) imports.push('dot');
      if (fieldName && shadowOn) imports.push('min');
      if (!bgExpr) imports.push('Discard');
      for (const name of imports) addImport('three/tsl', name);
      sdfEmission = {
        lines,
        // Self-lit: the composited colour is EMISSIVE over a black, rough
        // surface, so the scene lights add nothing. With a Background the sky
        // fills the window (alpha 1); otherwise empty rays are cut away.
        discardLine: bgExpr ? null : `  Discard(${base}.w.lessThan(0.01));`,
        returnLine: `  return { color: color(0x000000), emissive: ${base}Col, roughness: float(1) };`,
      };
    }
  }

  // ===== Splat Output =====
  // The return is `{ splat: { shade, shape, size, feather, invert, lit } }`, NOT
  // a material: Fns of `(p, pw, n, c)` returning VALUES, each omitted when it is
  // the identity, and NEVER a `Discard(`. See docs/dev/splats.md.
  let splatEmission: { lines: string[]; discardLine: null; returnLine: string } | null = null;
  if (splatNode && part) {
    const node = splatNode;
    const base = varNames.get(node.id)!;
    const nv = getNodeValues(node);
    const rawValues = (node.data as { values?: unknown }).values;
    const lines: string[] = [];
    const params = SPLAT_FN_PARAMS.join(', ');
    const edgeOf = (handle: string) => inEdge(gidx, node.id, handle);
    /** A stored number, strictly: a finite number or a numeric string —
     *  never `''` or a boolean, which `Number()` would read as 0 / 1. */
    const storedNumber = (key: string, dflt: number): number => {
      const raw = nv[key];
      if (typeof raw === 'number') return Number.isFinite(raw) ? raw : dflt;
      if (typeof raw === 'string' && raw.trim() !== '') {
        const v = valueNum(raw);
        return Number.isFinite(v) ? v : dflt;
      }
      return dflt;
    };
    const notVec3 = (shape: number) => shape !== 3;
    const entries: string[] = [];

    // lit: `lit: true` on the return plus ONE light line in the shade Fn; only
    // the literal `true` lights. The epsilon keeps a zero direction from turning
    // every splat NaN (docs/dev/splats.md).
    const lit = isSplatLit(rawValues);
    let lightLine: string | null = null;
    if (lit) {
      const dir = (key: 'lightX' | 'lightY' | 'lightZ') =>
        scalarRefOf(edgeOf(key)) ?? num(storedNumber(key, SPLAT_LIGHT_DIRECTION_DEFAULTS[key]));
      // A wire (widened like Color), the stored swatch, or the default LITERAL
      // — a `vec3(…)`, which the parse reads back as unset.
      const colour = (key: 'lightColor' | 'ambient') => {
        const wired = widenedRefOf(edgeOf(key), notVec3);
        if (wired) return wired;
        const stored = splatStoredColor(nv[key]);
        if (stored) {
          addImport('three/tsl', 'color');
          return `color(${hexLiteral(stored)})`;
        }
        addImport('three/tsl', 'vec3');
        return SPLAT_LIGHT_COLOR_DEFAULTS[key].emit;
      };
      const lightColour = colour('lightColor');
      const ambient = colour('ambient');
      const x = dir('lightX');
      const y = dir('lightY');
      const z = dir('lightZ');
      for (const name of ['add', 'mul', 'max', 'dot', 'normalize', 'vec3']) addImport('three/tsl', name);
      lightLine = `  const ${base}Light = add(mul(${lightColour}, max(dot(n, normalize(add(vec3(${x}, ${y}, ${z}), ${SPLAT_LIGHT_DIRECTION_EPSILON}))), 0)), ${ambient});`;
    }

    // shade → vec4(rgb, opacity) — lit, vec4(mul(rgb, sp1Light), opacity).
    // A wired or stored Color TINTS the captured colour, `mul(c.rgb, colour)`,
    // unless `replaceColor` (utils/splatColor.ts) makes it the colour alone.
    // An UNLIT node's Light sockets are in no scope (splatScopes), so a wire a
    // file carries into one leaves its feeder in the flat body, and the shade
    // scope holds a node only when one of the terms below reads it.
    const colorRef = widenedRefOf(edgeOf('color'), notVec3);
    const opacityRef = scalarRefOf(edgeOf('opacity'));
    const storedColor = splatStoredColor(nv.color);
    const opacity = storedNumber('opacity', 1);
    const shadeLines = scopeLines.get('shade')!;
    if (lightLine || colorRef || storedColor || opacityRef || opacity !== 1) {
      let rgb = colorRef;
      if (!rgb && storedColor) {
        addImport('three/tsl', 'color');
        rgb = `color(${hexLiteral(storedColor)})`;
      }
      addImport('three/tsl', 'vec4');
      if (rgb && !isSplatReplaceColor(rawValues)) {
        addImport('three/tsl', 'mul');
        rgb = `mul(c.rgb, ${rgb})`;
      }
      const shaded = lightLine ? `mul(${rgb ?? 'c.rgb'}, ${base}Light)` : rgb ?? 'c.rgb';
      pushScopeFn(lines, `${base}Shade`, params, lightLine ? [...shadeLines, lightLine] : shadeLines, `vec4(${shaded}, ${opacityRef ?? num(opacity)})`);
      entries.push(`shade: ${base}Shade`);
    }

    // shape → vec4(move, cut)
    const moveRef = widenedRefOf(edgeOf('move'), notVec3);
    const cutRef = scalarRefOf(edgeOf('cut'));
    if (moveRef || cutRef) {
      addImport('three/tsl', 'vec4');
      pushScopeFn(lines, `${base}Shape`, params, scopeLines.get('shape')!, `vec4(${moveRef ?? '0, 0, 0'}, ${cutRef ?? '0'})`);
      entries.push(`shape: ${base}Shape`);
    }

    // size → a Fn when it depends on the splat, the captured node when it
    // does not, the stored number when it is not 1.
    const sizeEdge = edgeOf('size');
    const sizeRef = scalarRefOf(sizeEdge);
    if (sizeEdge && sizeRef) {
      if (part.scopes.get('size')!.has(sizeEdge.source)) {
        pushScopeFn(lines, `${base}Size`, params, scopeLines.get('size')!, sizeRef);
        entries.push(`size: ${base}Size`);
      } else {
        entries.push(`size: ${sizeRef}`);
      }
    } else {
      const size = storedNumber('size', 1);
      if (size !== 1) entries.push(`size: ${num(size)}`);
    }

    // feather → exactly like size; a Fn when it depends on the splat, because
    // the loader reads it per VERTEX and a flat one would tear the quad.
    const featherEdge = edgeOf('feather');
    const featherRef = scalarRefOf(featherEdge);
    if (featherEdge && featherRef) {
      if (part.scopes.get('feather')!.has(featherEdge.source)) {
        pushScopeFn(lines, `${base}Feather`, params, scopeLines.get('feather')!, featherRef);
        entries.push(`feather: ${base}Feather`);
      } else {
        entries.push(`feather: ${featherRef}`);
      }
    } else {
      const feather = storedNumber('feather', 0);
      if (feather !== 0) entries.push(`feather: ${num(feather)}`);
    }

    // invert → only the literal `true` counts (node data is untrusted).
    if (hasTrueFlag(rawValues, 'invert')) entries.push('invert: true');
    // lit → the loader's half of the light: `n` becomes the surface normal.
    if (lightLine) entries.push('lit: true');

    splatEmission = {
      lines,
      discardLine: null,
      returnLine: entries.length > 0 ? `  return { splat: { ${entries.join(', ')} } };` : '  return { splat: {} };',
    };
  }

  // The DEFAULT material: `defaultOutput` over NODES, never `sorted` (an unwired
  // Output sorts before a wired one), and none while a custom sink drives. NULL
  // is a real answer: a document whose every Output is targeted emits `parts`
  // alone. See docs/dev/outputs-and-materials.md, "Several output nodes".
  const defaultNode = customNode ? null : defaultOutput(nodes);
  /**
   * THE Outputs whose `parts` / `materialParts` entries reach the module, in
   * (emitRank, id) order. The custom-sink check stays HERE: `customNode` was
   * resolved over `sorted`, and asking again over `nodes` could elect another.
   */
  const outputs = customNode ? [] : contributingOutputs(nodes);
  const outputById = new Map(outputs.map((n) => [n.id, n] as const));
  /** `outputMaterials` per node, memoised: it synthesizes material 0 into a
   *  fresh array on every call, and the loops below ask per entry. */
  const materialsByNode = new Map<string, OutputMaterial[]>();
  const materialsFor = (node: AppNode): OutputMaterial[] => {
    let m = materialsByNode.get(node.id);
    if (!m) { m = outputMaterials(node); materialsByNode.set(node.id, m); }
    return m;
  };
  // `metalness` is appended (not slotted in visual order) so the emitted
  // return-object key order for existing graphs stays byte-identical; `env`
  // is deliberately NOT here — it needs the source's TEXTURE, not a sampled
  // ref, and is resolved after this loop.
  const OUTPUT_CHANNELS = ['color', 'emissive', 'normal', 'position', 'opacity', 'roughness', 'metalness'] as const;
  // Discard is a side-effect statement for the DEFAULT output — emitted as
  // `Discard(cond);` between definitions and the return so the wired condition
  // (e.g. greaterThan(distance(positionWorld, cameraPosition), maxDist)) kills
  // the fragment before any further work. A TARGETED output cannot use a
  // statement (a statement belongs to the whole module, not to one mesh), so
  // the resolver returns the raw CONDITION and each caller decides its form.

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
   * `emissive` is included because the loader copies emissiveNode into
   * colorNode when no colour is wired (0.8.js, `buildMaterial`).
   */
  const ALPHA_BEARING_CHANNELS = new Set(['color', 'emissive']);

  /**
   * Resolve one Output node into its channel expressions plus its discard
   * condition. Declared inside `graphToCode` so it closes over the whole
   * emission context (gidx, varNames, registry, addImport, resolveEdgeRef,
   * shapeOfEdgeSource, imagePlanner …) instead of threading a dozen
   * parameters through — the body below is the block that used to run inline
   * for the single output, moved verbatim apart from returning its results.
   */
  const resolveOutputChannels = (
    outputNode: AppNode,
    materialIndex = 0,
  ): { channels: Record<string, string>; discardRef: string | null } => {
    // Which material's state to read, and which handles its channels are wired
    // through. Index 0 is the node's own fields and the BARE handle ids, so a
    // document with no added materials resolves exactly as it always has.
    const material = outputMaterials(outputNode)[materialIndex];
    const handleOf = (ch: string) => channelHandle(materialIndex, ch);
    const channels: Record<string, string> = {};
    let discardRef: string | null = null;
    // Stored per-channel values, read DIRECTLY from data. An ABSENT key emits
    // nothing, a wired edge always wins, and emission is gated on the channel
    // being EXPOSED; numbers and hexes are re-emitted, never interpolated.
    // See docs/dev/outputs-and-materials.md.
    const outValues = (material?.values ?? {}) as Record<string, unknown>;
    const outExposed = new Set(
      materialIndex === 0
        ? effectiveExposedPorts(outputNode)
        : materialExposedPorts(material, OUTPUT_DEFAULT_EXPOSED),
    );
    const FLOAT_VALUE_CHANNELS = new Set(['roughness', 'metalness', 'opacity', 'position']);
    const COLOR_VALUE_CHANNELS = new Set(['color', 'emissive', 'normal', 'env']);
    const storedChannelExpr = (ch: string): string | null => {
      if (!outExposed.has(ch)) return null;
      const v = outValues[ch];
      if (v === undefined || v === null || v === '') return null;
      if (FLOAT_VALUE_CHANNELS.has(ch)) {
        const n = Number(v);
        if (!Number.isFinite(n)) return null;
        // Zero displacement is a literal no-op — skip so the widget default
        // (0) and an absent key emit identically (no dead positionLocal.add
        // chain in every export).
        if (ch === 'position' && n === 0) return null;
        addImport('three/tsl', 'float');
        return `float(${num(n)})`;
      }
      if (COLOR_VALUE_CHANNELS.has(ch) && typeof v === 'string' && HEX6.test(v)) {
        if (ch === 'normal') {
          // The DEFAULT normal color #8080ff is the flat tangent-space
          // "no perturbation" texel — an identity override, so it emits
          // NOTHING (absent and default read identically, like a zero
          // discard). Any other stored normal color is a normal-map TEXEL
          // and must be DECODED — normalMap() does the [0,1]→[-1,1] remap +
          // TBN transform; a raw color(0x…) fed to normalNode would be an
          // unnormalized, un-remapped vector that shears the shading.
          if (v.toLowerCase() === '#8080ff') return null;
          addImport('three/tsl', 'normalMap');
          addImport('three/tsl', 'color');
          return `normalMap(color(${hexLiteral(v)}))`;
        }
        addImport('three/tsl', 'color');
        return `color(${hexLiteral(v)})`;
      }
      return null;
    };

    for (const ch of OUTPUT_CHANNELS) {
      const edge = inEdge(gidx, outputNode.id, handleOf(ch));
      if (!edge) {
        const stored = storedChannelExpr(ch);
        if (stored) channels[ch] = stored;
      }
      if (edge) {
        const ref = resolveEdgeRef(edge, varNames, gidx);
        if (ref) {
          const sourceNode = gidx.nodeById.get(edge.source);
          const sourceDef = sourceNode ? registry.get(sourceNode.data.registryType) : undefined;
          if (sourceDef?.category === 'logic' && VEC3_CHANNELS.has(ch)) {
            addImport('three/tsl', 'vec3');
            addImport('three/tsl', 'float');
            channels[ch] = `vec3(float(${ref}))`;
          } else if (ALPHA_BEARING_CHANNELS.has(ch) && shapeOfEdgeSource(edge) !== 3) {
            // Alpha comes ONLY from the opacity channel: `vec4(float)` splats
            // and `vec4(vec4)` hands `w` to alpha, hence `!== 3`, not `=== 1`.
            // See docs/dev/codegen.md.
            addImport('three/tsl', 'vec3');
            channels[ch] = `vec3(${ref})`;
          } else if (
            ch === 'normal' &&
            sourceNode?.data.registryType === 'imageNode' &&
            !isImageChannelHandle(edge.sourceHandle)
          ) {
            // An image on its Color (`out`) socket is a tangent-space normal
            // MAP: decode it with normalMap(). A channel socket is a scalar and
            // takes the plain path. See docs/dev/images-and-textures.md.
            addImport('three/tsl', 'normalMap');
            // glTF without TANGENT: the importer's recorded green flip becomes
            // the normal scale, as GLTFLoader does.
            if (readImageUvMapping(getNodeValues(sourceNode)).normalGreenFlip) {
              addImport('three/tsl', 'vec2');
              channels[ch] = `normalMap(${ref}, vec2(1, -1))`;
            } else {
              channels[ch] = `normalMap(${ref})`;
            }
          } else {
            channels[ch] = ref;
          }
        }
      }
    }

    // Environment is the one channel whose value is the TEXTURE, never the
    // sampled vec3, guarded on the planner having declared that var and on the
    // Color (`out`) socket. Any other source is widened to vec3. See
    // docs/dev/outputs-and-materials.md, "Environment maps".
    const envEdge = inEdge(gidx, outputNode.id, handleOf('env'));
    if (!envEdge) {
      // Stored env color: a constant ambient environment (EnvironmentNode
      // consumes any node — a color is uniform radiance+irradiance).
      const stored = storedChannelExpr('env');
      if (stored) channels.env = stored;
    }
    if (envEdge) {
      const envSrc = gidx.nodeById.get(envEdge.source);
      const placedEnv =
        envSrc?.data.registryType === 'imageNode' && !isImageChannelHandle(envEdge.sourceHandle)
          ? imagePlanner.get(envSrc.id)
          : undefined;
      if (placedEnv) {
        addImport('three/tsl', 'texture');
        channels.env = `texture(_${varNames.get(placedEnv.textureOwner)!}_tex)`;
      } else {
        const ref = resolveEdgeRef(envEdge, varNames, gidx);
        if (ref) {
          if (shapeOfEdgeSource(envEdge) !== 3) {
            addImport('three/tsl', 'vec3');
            channels.env = `vec3(${ref})`;
          } else {
            channels.env = ref;
          }
        }
      }
    }

    const discardEdge = inEdge(gidx, outputNode.id, handleOf('discard'));
    if (!discardEdge) {
      // Stored discard value. Discard is a TRUTHINESS test, so a non-zero
      // stored value is an UNCONDITIONAL cull (the whole mesh vanishes —
      // deliberate, the widget is a dial the user turned). Zero is skipped:
      // bool(0) never culls, so absent and 0 emit identically and the code
      // never grows a dead __pixel wrapper.
      if (outExposed.has('discard')) {
        const dv = Number(outValues.discard);
        if (
          outValues.discard !== undefined &&
          outValues.discard !== null &&
          Number.isFinite(dv) &&
          dv !== 0
        ) {
          addImport('three/tsl', 'Discard');
          addImport('three/tsl', 'float');
          discardRef = `float(${num(dv)})`;
        }
      }
    }
    if (discardEdge) {
      // The condition compiles as `bool(<ref>)`, and a non-scalar float becomes
      // `all(vecN)`, a link error: coerce to a scalar, EXCEPT for logic nodes,
      // whose vector really is a bvecN. See docs/dev/codegen.md, Discard.
      const discardSrc = gidx.nodeById.get(discardEdge.source);
      const discardDef = discardSrc ? registry.get(discardSrc.data.registryType) : undefined;
      const ref = discardDef?.category === 'logic'
        ? resolveEdgeRef(discardEdge, varNames, gidx)
        : scalarRefOf(discardEdge);
      if (ref) {
        addImport('three/tsl', 'Discard');
        discardRef = ref;
      }
    }
    return { channels, discardRef };
  };

  // The DEFAULT material's channels, or none — see `defaultNode` above. With
  // no default the module carries `parts` alone, and loader 0.6/0.8 leaves
  // every unclaimed mesh on its authored material.
  const defaultResolved = defaultNode
    ? resolveOutputChannels(defaultNode, 0)
    : { channels: {} as Record<string, string>, discardRef: null as string | null };
  const channels = defaultResolved.channels;
  const discardLine = defaultResolved.discardRef
    ? `  Discard(${defaultResolved.discardRef});`
    : null;

  // Every TARGETED material becomes a `parts` entry, re-validated here because
  // emission is the gate that decides what becomes CODE. FIRST CLAIM WINS for a
  // duplicate mesh name, decided by the ONE cross-node plan the node's shadowed
  // mark shares. See docs/dev/outputs-and-materials.md, per-mesh materials.
  const parts: {
    name: string;
    channels: Record<string, string>;
    discardRef: string | null;
    /** The material's settings as loader-form entries (`side: 2`) — [] for none. */
    settings: string[];
  }[] = [];
  {
    // Resolved ONCE per material, not once per mesh, so N meshes carry N
    // byte-identical bodies (the parse's merge relies on it). The four settings
    // ride the same body in the LOADER's spelling; `materialSettingProps` is
    // the security gate. NESTED by node id, never a joined key: an id out of a
    // `.fastshader` may spell any separator.
    const bySection = new Map<string, Map<number, {
      channels: Record<string, string>;
      discardRef: string | null;
      settings: string[];
    }>>();
    for (const { name, nodeId, section } of planNamedPartsAcross(outputs).entries) {
      const node = outputById.get(nodeId);
      if (!node) continue;
      let byNode = bySection.get(nodeId);
      if (!byNode) { byNode = new Map(); bySection.set(nodeId, byNode); }
      let resolved = byNode.get(section);
      if (!resolved) {
        resolved = {
          ...resolveOutputChannels(node, section),
          settings: materialSettingProps(materialsFor(node)[section].materialSettings),
        };
        byNode.set(section, resolved);
      }
      parts.push({ name, ...resolved });
    }
  }

  // Every IMPORT-BUILT index section becomes a `materialParts` entry keyed by
  // its glTF material index, in ascending order, and only beside a VALID
  // signature (R3). ONE signature governs the table: `moduleSignatureOf`, read
  // off the lowest-ranked contributing Output holding an index binding, never
  // off the untargeted default. See docs/dev/outputs-and-materials.md.
  const signature = moduleSignatureOf(outputs);
  const indexParts: {
    index: number;
    channels: Record<string, string>;
    discardRef: string | null;
    settings: string[];
  }[] = [];
  if (signature) {
    for (const { gltfIndex, nodeId, section } of planIndexPartsAcross(outputs, signature).entries) {
      const node = outputById.get(nodeId);
      if (!node) continue;
      indexParts.push({
        index: gltfIndex,
        ...resolveOutputChannels(node, section),
        settings: materialSettingProps(materialsFor(node)[section].materialSettings),
      });
    }
  }

  /** One part's body — its channels, its `discard` key, then its settings in
   *  the loader's spelling. Shared by `parts` and `materialParts`, so the two
   *  bodies cannot drift (a mirror is byte-identical to its index entry only
   *  because both came from here). */
  const partBody = (part: { channels: Record<string, string>; discardRef: string | null; settings: string[] }): string => {
    const entries = Object.entries(part.channels);
    if (part.discardRef) entries.push(['discard', part.discardRef]);
    return [...entries.map(([k, v]) => `${k}: ${v}`), ...part.settings].join(', ');
  };

  // Build return line — single value for color-only, object for multiple channels
  let returnLine: string;
  const channelEntries = Object.entries(channels);

  if (parts.length > 0 || indexParts.length > 0) {
    // A `parts` key can only ride the OBJECT form. An EMPTY default emits
    // parts ALONE, never the red sentinel, so unclaimed meshes keep their
    // authored material and the shape round-trips (per-mesh rule 2).
    const defaultProps = channelEntries;
    // A targeted output with nothing wired still emits its entry. It must:
    // the parse is what re-creates the node, so an omitted entry means the
    // Output and its edges vanish on the next code-panel Apply. The same holds
    // for an unwired index section (`"3": {  }`).
    const partProps = parts.map((part) => `${moduleStringLiteral(part.name)}: { ${partBody(part)} }`);
    const props = defaultProps.map(([k, v]) => `${k}: ${v}`).join(', ');
    const lead = props ? `${props}, ` : '';
    // ONE line, always: `parseBody` reads the return from a single source line,
    // and a signature name containing `}`, `,`, `:` or `"` survives it because
    // every name is a string literal the splitters honour.
    const pieces: string[] = [];
    if (parts.length > 0) pieces.push(`parts: { ${partProps.join(', ')} }`);
    if (indexParts.length > 0 && signature) {
      pieces.push(`materialParts: { ${indexParts
        .map((part) => `${moduleStringLiteral(String(part.index))}: { ${partBody(part)} }`)
        .join(', ')} }`);
      pieces.push(`modelSignature: { materials: [${signature.map(moduleStringLiteral).join(', ')}] }`);
    }
    returnLine = `  return { ${lead}${pieces.join(', ')} };`;
  } else if (channelEntries.length === 0) {
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

  // The custom sink's own program, when one drives — its lines, its cutout
  // (the march's; a splat never has one) and its return REPLACE the plain
  // Output's.
  const customEmission = sdfEmission ?? splatEmission;
  const effectiveReturnLine = customEmission ? customEmission.returnLine : returnLine;

  // Ensure vec3 is imported if used in fallback return. Asked of the return
  // line that is actually EMITTED: the plain sentinel computed beside an
  // active Splat Output never reaches the module, and neither may its import.
  if (effectiveReturnLine.includes('vec3(')) {
    addImport('three/tsl', 'vec3');
  }

  // Build import lines (after all imports are collected)
  const importLines: string[] = [];
  for (const [module, names] of importsByModule) {
    const sortedNames = Array.from(names).sort();
    importLines.push(`import { ${sortedNames.join(', ')} } from '${module}';`);
  }

  const helperLines: string[] = [];
  for (const type of usedHelpers) helperLines.push(...MODULE_HELPERS.get(type)!.lines, '');

  const code = [
    ...importLines,
    '',
    ...helperLines,
    // Module-scope DataTexture construction (Data/Stripes nodes) — must precede
    // the shader Fn so its body can close over the textures.
    ...(setupLines.length ? [...setupLines, ''] : []),
    'const shader = Fn(() => {',
    ...mainLines,
    ...(customEmission ? customEmission.lines : []),
    ...(customEmission ? (customEmission.discardLine ? [customEmission.discardLine] : []) : discardLine ? [discardLine] : []),
    '',
    effectiveReturnLine,
    '});',
    '',
    'export default shader;',
    '',
  ].join('\n');

  return { code, importStatements: importLines, varNames };
}


/**
 * An append node's vector constructor over ALL its wired operands. The size is
 * the SUM of the operands' channels, capped at 4, and the ARGUMENTS are capped
 * with it: an overflowing operand is swizzled down, later ones are dropped
 * (`vec4(vec3A, vec3B)` is not valid TSL).
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

/**
 * Channel count of each append operand, in socket order, from the PER-HANDLE
 * `shapeOfEdgeSource`, never a node-level count (`toHsl.h` is 1, not 3). An
 * unwired operand counts 1: it still emits a `0` argument.
 */
function appendOperandChannels(
  node: AppNode,
  def: NodeDefinition,
  gidx: GraphIndex,
  shapeOf: (edge: AppEdge) => number,
): number[] {
  const connected = inEdges(gidx, node.id)
    .filter((e) => typeof e.targetHandle === 'string')
    .map((e) => e.targetHandle as string);
  const inputs = effectiveInputs(def, connected, false, Object.keys(getNodeValues(node)));
  return inputs.map((input) => {
    const edge = inEdge(gidx, node.id, input.id);
    if (!edge) return 1;
    const ch = shapeOf(edge);
    return ch > 0 ? ch : 1;
  });
}

/**
 * The multiplier the Sound node applies to every channel: the wired `gain`,
 * else the stored one clamped by `readSoundSettings`, or null when it is
 * exactly 1 and unwired (byte-identical to the ungained form).
 */
function micGainExpr(
  node: AppNode,
  varNames: Map<string, string>,
  gidx: GraphIndex,
): string | null {
  const edge = inEdges(gidx, node.id).find(
    // A self-loop would recurse straight back into resolveEdgeRef. The editor
    // never offers a cycle, but a hand-edited project file can contain one.
    (e) => e.targetHandle === 'gain' && e.source !== node.id,
  );
  if (edge) {
    const ref = resolveEdgeRef(edge, varNames, gidx);
    if (ref) return ref;
  }
  const { gain } = readSoundSettings(getNodeValues(node));
  return gain === 1 ? null : num(gain);
}

/** Resolve a source edge reference, looking through split nodes to inline swizzle. */
function resolveEdgeRef(
  edge: AppEdge,
  varNames: Map<string, string>,
  gidx: GraphIndex
): string | null {
  const sourceNode = gidx.nodeById.get(edge.source);
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

  // Sound: each channel is its own `<var>_<channel>` uniform, addressed by the
  // handle through `soundChannelForHandle`, the emitter's own normalization.
  if (isSoundNodeType(sourceNode.data.registryType)) {
    const base = varNames.get(sourceNode.id);
    if (!base) return null;
    const u = soundUniformName(base, soundChannelForHandle(edge.sourceHandle));
    // With gain applied, downstream reads the SCALED variable, not the raw
    // uniform — the uniform line itself must stay a bare `uniform(0)` so
    // buildShaderModule's uniformLineRe still turns it into a schema property.
    return micGainExpr(sourceNode, varNames, gidx) ? `_${u}` : u;
  }

  // Data Viz: the `value` handle exposes the tone-mapped scalar (`_<var>_t`,
  // a float 0–1) instead of the coloured `out` vec3 — so displacement can be
  // driven by the data height independently of the chosen ramp colours.
  if (sourceNode.data.registryType === 'dataviz' && edge.sourceHandle === 'value') {
    const base = varNames.get(sourceNode.id);
    return base ? `_${base}_t` : null;
  }

  // RGB to HSL: h/s/l read components of this node's OWN emitted variable —
  // one `const toHsl1 = toHsl(rgb);` serves all three sockets, so the node
  // costs one conversion however many are wired (three separate calls measure
  // ~2.5× the GLSL: three INLINES the helper Fn each time and does not CSE
  // it). Deliberately its own branch and NOT folded into the split one below:
  // split inlines its UPSTREAM variable, this swizzles its own. `out`, null
  // and any tampered handle fall through to the bare variable name, which is
  // what keeps every pre-existing graph byte-identical.
  if (sourceNode.data.registryType === 'toHsl' && edge.sourceHandle) {
    const comp = TOHSL_HANDLE_TO_COMPONENT.get(edge.sourceHandle);
    const base = varNames.get(sourceNode.id);
    if (comp && base) return `${base}.${comp}`;
  }

  // Texture (Image) node: Alpha/R/G/B read components of this node's ONE
  // sample — only in WIDE mode (a channel socket is wired, imageSampleIsWide),
  // where the variable is the vec4 sample, so `out`, a null handle and any
  // tampered id read its `.rgb`. Out-only graphs fall through to the bare name
  // below, which keeps them byte-identical. No codeToGraph inverse map: image
  // nodes are one-way (see the imageNode branch). The lookup is a Map, so a
  // `__proto__`/`constructor` handle out of a .fastshader resolves to `.rgb`.
  if (sourceNode.data.registryType === 'imageNode' && imageSampleIsWide(gidx, sourceNode.id)) {
    const base = varNames.get(sourceNode.id);
    if (base) return `${base}.${IMAGE_CHANNEL_COMPONENTS.get(edge.sourceHandle ?? '') ?? 'rgb'}`;
  }

  // If source is a split node, inline as inputVar.component
  if (sourceNode.data.registryType === 'split' && edge.sourceHandle && edge.sourceHandle !== 'out' && VALID_SWIZZLE.has(edge.sourceHandle)) {
    const splitInputEdge = inEdge(gidx, sourceNode.id, 'v');
    if (splitInputEdge && varNames.has(splitInputEdge.source)) {
      return `${varNames.get(splitInputEdge.source)}.${edge.sourceHandle}`;
    }
  }

  return varNames.get(edge.source) ?? null;
}

function resolveArguments(
  node: AppNode,
  varNames: Map<string, string>,
  def: NodeDefinition,
  gidx: GraphIndex,
  /** An explicit positional port list (a helper VARIANT's), instead of the
   *  def's effective inputs — see engine/moduleHelpers.ts helperCallPorts. */
  ports?: readonly string[],
): string[] {
  // Chainable arithmetic emits a variadic call over its wired operands (plus any
  // interior gaps filled with the identity) — `includeTrailingEmpty=false` drops
  // the dangling grow socket so we never emit e.g. `add(a, b, 0)`. Stored values
  // on extension operands (imported `add(x, 2, 3)`) are honored via valuedHandles.
  const nodeVals = getNodeValues(node);
  const connected = inEdges(gidx, node.id)
    .filter((e) => typeof e.targetHandle === 'string')
    .map((e) => e.targetHandle as string);
  const inputs = ports
    ? ports.map((id) => def.inputs.find((i) => i.id === id) ?? { id, label: id, dataType: 'any' as const })
    : effectiveInputs(def, connected, false, Object.keys(nodeVals));
  return inputs.map((input) => {
    const edge = inEdge(gidx, node.id, input.id);
    if (edge) {
      const ref = resolveEdgeRef(edge, varNames, gidx);
      if (ref) return ref;
    }
    // No connection: stored value, then the registry default for this port,
    // then the chain identity, then `0`; every step through num(), never
    // String(). `valueNum`, because `values` is adversarial and Number() can
    // THROW on a tampered entry. See docs/dev/codegen.md and utils/valueCoerce.ts.
    const stored = valueNum(nodeVals[input.id]);
    if (Number.isFinite(stored)) return num(stored);
    const dflt = Number(def.defaultValues?.[input.id]);
    if (Number.isFinite(dflt)) return num(dflt);
    if (def.chainable && def.chainIdentity !== undefined) return num(Number(def.chainIdentity));
    return '0';
  });
}

/** Resolve an exposed parameter: if an edge connects to it, use the variable ref; else use stored value. */
function resolveExposedParam(
  node: AppNode,
  key: string,
  varNames: Map<string, string>,
  nodeValues: Record<string, string | number>,
  gidx: GraphIndex,
): string {
  // Check if there's an edge connected to this exposed port
  const edge = inEdge(gidx, node.id, key);
  if (edge) {
    const ref = resolveEdgeRef(edge, varNames, gidx);
    if (ref) return ref;
  }
  // The REGISTRY default before the hardcoded 1, so a node whose `values` lack
  // the key agrees with cpuEvaluator; byte-identical for every complete node.
  // See docs/dev/codegen.md.
  const registryDefault = NODE_REGISTRY.get(node.data.registryType)?.defaultValues?.[key];
  const raw = nodeValues?.[key] ?? registryDefault ?? 1;
  // `pos` is the ONE identifier-bearing key that reaches here: codeToGraph
  // stores the unresolved variable NAME of a noise call's position argument
  // (codeToGraph.ts `extractedValues.pos = posArg.name`), so it is legitimately
  // `positionGeometry` — or any other identifier a pasted shader used. The
  // noise branch then normalizes a non-identifier back to positionGeometry and
  // adds the import, byte-identically to the old numeric fallback.
  // The ONE rule (utils/sdfPartition.ts noisePosIdentifier), shared with the
  // partition that decides whether the noise reads a splat root implicitly.
  if (key === 'pos') return noisePosIdentifier(raw);
  // Every other key here (noise `scale`, uv `channel`/`tilingU`/`tilingV`/
  // `rotation`) is numeric. Garbage degrades to the SAME `1` an absent key
  // already degrades to, so this function keeps a single documented fallback.
  const n = Number(raw);
  return num(Number.isFinite(n) ? n : 1);
}

