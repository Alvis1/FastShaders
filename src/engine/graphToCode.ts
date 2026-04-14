import type { AppNode, AppEdge, NodeDefinition, GeneratedCode } from '@/types';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { getComponentCount } from './cpuEvaluator';
import { topologicalSort } from './topologicalSort';

/** Valid swizzle component handles for split node output. */
export const VALID_SWIZZLE = new Set(['x', 'y', 'z', 'w']);

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

  for (const node of sorted) {
    const def = registry.get(node.data.registryType);
    if (!def || node.data.registryType === 'output' || node.data.registryType === 'split') continue;

    // Property nodes use their user-defined name as the variable name
    if (node.data.registryType === 'property_float') {
      const nodeValues = getNodeValues(node);
      const rawName = String(nodeValues.name ?? 'property1');
      let baseName = rawName.replace(/[^a-zA-Z0-9_$]/g, '_').replace(/^(\d)/, '_$1');
      if (!baseName) baseName = 'property1';

      let name = baseName;
      let i = 1;
      while (usedNames.has(name)) {
        name = `${baseName}${++i}`;
      }
      usedNames.add(name);
      varNames.set(node.id, name);
      continue;
    }

    // Unknown nodes: use the stored function name as the variable base
    if (def.type === 'unknown') {
      const nv = getNodeValues(node);
      let baseName = String(nv.functionName ?? 'unknown').replace(/[^a-zA-Z0-9_$]/g, '_');
      if (!baseName) baseName = 'unknown';
      let idx = 1;
      while (usedNames.has(`${baseName}${idx}`)) idx++;
      const name = `${baseName}${idx}`;
      usedNames.add(name);
      varNames.set(node.id, name);
      continue;
    }

    let baseName = def.tslFunction;
    // Clean up names for MaterialX functions
    if (baseName.startsWith('mx_')) {
      baseName = baseName.replace('mx_', '').replace(/_float$|_vec[234]$/, '');
    }

    // Always number from 1 to avoid shadowing TSL imports (color1, add1, etc.)
    let idx = 1;
    while (usedNames.has(`${baseName}${idx}`)) {
      idx++;
    }
    const name = `${baseName}${idx}`;
    usedNames.add(name);
    varNames.set(node.id, name);
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

  for (const node of sorted) {
    const def = registry.get(node.data.registryType);
    if (!def || node.data.registryType === 'output' || node.data.registryType === 'split') continue;

    const varName = varNames.get(node.id)!;

    // Unknown nodes: emit the preserved raw expression verbatim
    if (def.type === 'unknown') {
      const nv = getNodeValues(node);
      const rawExpr = String(nv.rawExpression ?? 'float(0)');
      bodyLines.push(`  const ${varName} = ${rawExpr};`);
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
    } else if (def.type === 'append') {
      // Append node: concatenate values into a vector. Pick vec2/vec3/vec4 based on the
      // total component count of the inputs (a vec2 + float must become vec3, not vec2).
      const args = resolveArguments(node, edges, varNames, def, sorted);
      const total = computeAppendOutputSize(node, edges, sorted);
      const ctor = total === 2 ? 'vec2' : total === 3 ? 'vec3' : 'vec4';
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
    } else if (def.inputs.length === 0 && def.defaultValues) {
      // Type constructors with default values
      const nodeValues = getNodeValues(node);
      const defaultKey = Object.keys(def.defaultValues)[0];
      const val = nodeValues?.[defaultKey] ?? Object.values(def.defaultValues)[0];
      const formatted = typeof val === 'string' && val.startsWith('#')
        ? `0x${val.slice(1)}`
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

  if (outputNode) {
    for (const ch of OUTPUT_CHANNELS) {
      const edge = edges.find(
        (e) => e.target === outputNode.id && e.targetHandle === ch
      );
      if (edge) {
        const ref = resolveEdgeRef(edge, edges, varNames, sorted);
        if (ref) channels[ch] = ref;
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
    'const shader = Fn(() => {',
    ...bodyLines,
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
 * (GLSL-style — no conditionals, suitable for the GPU). Identical to the factory
 * in graphToTSLNodes so generated-code and live-preview paths stay in sync.
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
 * Compute the total component count produced by an append node by summing the channel
 * counts of its two inputs (connected = evaluate upstream; unconnected = scalar = 1).
 * Result is clamped to [2, 4] since GLSL has no vec5+.
 */
function computeAppendOutputSize(
  node: AppNode,
  edges: AppEdge[],
  nodes: AppNode[],
): number {
  let total = 0;
  for (const inputId of ['a', 'b'] as const) {
    const edge = edges.find((e) => e.target === node.id && e.targetHandle === inputId);
    if (edge) {
      total += getComponentCount(edge.source, nodes, edges);
    } else {
      total += 1;
    }
  }
  return Math.min(Math.max(total, 2), 4);
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
  return def.inputs.map((input) => {
    const edge = edges.find(
      (e) => e.target === node.id && e.targetHandle === input.id
    );
    if (edge) {
      const ref = resolveEdgeRef(edge, edges, varNames, sorted);
      if (ref) return ref;
    }
    // No connection: use node's stored value or placeholder
    const nodeValues = getNodeValues(node);
    const val = nodeValues[input.id];
    if (val !== undefined) return String(val);
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

