import type { AppNode, AppEdge, NodeDefinition, GeneratedCode } from '@/types';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { getParamClassifications } from '@/registry/tslTexturesRegistry';
import { topologicalSort } from './topologicalSort';

export function graphToCode(
  nodes: AppNode[],
  edges: AppEdge[],
  registry: Map<string, NodeDefinition> = NODE_REGISTRY
): GeneratedCode {
  if (nodes.length === 0) {
    return { code: '// Empty shader — add nodes to begin\n', importStatements: [] };
  }

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

    let baseName = def.tslFunction;
    // Clean up names for MaterialX functions
    if (baseName.startsWith('mx_')) {
      baseName = baseName.replace('mx_', '').replace(/_float$|_vec[234]$/, '');
    }

    let name = baseName;
    let i = 1;
    while (usedNames.has(name)) {
      name = `${baseName}${++i}`;
    }
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

  let needsTHREEImport = false;
  for (const node of sorted) {
    const def = registry.get(node.data.registryType);
    if (!def || node.data.registryType === 'output' || !def.tslImportModule) continue;
    addImport(def.tslImportModule, def.tslFunction);
    if (def.tslImportModule === 'tsl-textures') needsTHREEImport = true;
  }

  // Build body lines
  const bodyLines: string[] = [];

  for (const node of sorted) {
    const def = registry.get(node.data.registryType);
    if (!def || node.data.registryType === 'output' || node.data.registryType === 'split') continue;

    const varName = varNames.get(node.id)!;
    const args = resolveArguments(node, edges, varNames, def, sorted);

    if (def.tslImportModule === 'tsl-textures') {
      // tsl-textures: object parameter call
      const objProps = buildTSLTextureCallProps(node, edges, varNames, def, sorted);
      bodyLines.push(`  const ${varName} = ${def.tslFunction}({ ${objProps} });`);
    } else if (def.inputs.length === 0 && def.category === 'input' && !def.defaultValues) {
      // Input nodes: bare reference (positionGeometry, time, etc.)
      bodyLines.push(`  const ${varName} = ${def.tslFunction};`);
    } else if (def.inputs.length === 0 && def.defaultValues) {
      // Type constructors with default values
      const nodeValues = getNodeValues(node);
      const defaultKey = Object.keys(def.defaultValues)[0];
      const val = nodeValues?.[defaultKey] ?? Object.values(def.defaultValues)[0];
      const formatted = typeof val === 'string' && val.startsWith('#')
        ? `0x${val.slice(1)}`
        : val;
      bodyLines.push(`  const ${varName} = ${def.tslFunction}(${formatted});`);
    } else if (def.type === 'hsl') {
      // HSL → RGB: emit as vec3 (simplified placeholder)
      addImport('three/tsl', 'vec3');
      bodyLines.push(`  const ${varName} = vec3(${args.join(', ')});`);
    } else if (def.type === 'toHsl') {
      // RGB → HSL: passthrough (simplified placeholder)
      bodyLines.push(`  const ${varName} = ${args[0] ?? 'vec3(0, 0, 0)'};`);
    } else if (def.category === 'noise') {
      // Noise nodes: all params come from exposed ports / stored values
      const nv = getNodeValues(node);

      // Resolve position: from exposed port edge, or default positionGeometry
      let posExpr = resolveExposedParam(node, 'pos', edges, varNames, nv, sorted);
      if (/^\d+(\.\d+)?$/.test(posExpr) || posExpr === 'positionGeometry') {
        posExpr = 'positionGeometry';
      }
      addImport('three/tsl', 'positionGeometry');

      // Apply scale
      const scaleExpr = resolveExposedParam(node, 'scale', edges, varNames, nv, sorted);
      if (scaleExpr !== '1') {
        posExpr = `mul(${posExpr}, ${scaleExpr})`;
        addImport('three/tsl', 'mul');
      }

      const noiseArgs: string[] = [posExpr];

      // Fractal noise: resolve extra params (octaves, lacunarity, diminish)
      if (node.data.registryType === 'fractal') {
        noiseArgs.push(
          resolveExposedParam(node, 'octaves', edges, varNames, nv, sorted),
          resolveExposedParam(node, 'lacunarity', edges, varNames, nv, sorted),
          resolveExposedParam(node, 'diminish', edges, varNames, nv, sorted),
        );
      }
      bodyLines.push(`  const ${varName} = ${def.tslFunction}(${noiseArgs.join(', ')});`);
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
  if (needsTHREEImport) {
    importLines.push(`import * as THREE from 'three';`);
  }
  for (const [module, names] of importsByModule) {
    const sortedNames = Array.from(names).sort();
    importLines.push(`import { ${sortedNames.join(', ')} } from '${module}';`);
  }

  const code = [
    ...importLines,
    '',
    'const shader = Fn(() => {',
    ...bodyLines,
    '',
    returnLine,
    '});',
    '',
    'export default shader;',
    '',
  ].join('\n');

  return { code, importStatements: importLines };
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
  const VALID_SWIZZLE = new Set(['x', 'y', 'z', 'w']);
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

function buildTSLTextureCallProps(
  node: AppNode,
  edges: AppEdge[],
  varNames: Map<string, string>,
  def: NodeDefinition,
  sorted: AppNode[]
): string {
  const classifications = getParamClassifications(def.tslFunction);
  const nodeValues = getNodeValues(node);
  const parts: string[] = [];

  for (const param of classifications) {
    if (param.kind === 'meta') continue;

    // Check if this param has an edge connection
    const edge = edges.find(
      (e) => e.target === node.id && e.targetHandle === param.key
    );

    if (param.kind === 'tslRef') {
      // Only include if connected to a different node
      if (edge) {
        const ref = resolveEdgeRef(edge, edges, varNames, sorted);
        if (ref) parts.push(`${param.key}: ${ref}`);
      }
    } else if (param.kind === 'number') {
      if (edge) {
        const ref = resolveEdgeRef(edge, edges, varNames, sorted);
        if (ref) { parts.push(`${param.key}: ${ref}`); }
      } else {
        const val = nodeValues[param.key] ?? param.defaultValue;
        parts.push(`${param.key}: ${val}`);
      }
    } else if (param.kind === 'color') {
      const hex = String(nodeValues[param.key] ?? '#000000');
      parts.push(`${param.key}: new THREE.Color(0x${hex.slice(1).toUpperCase()})`);
    } else if (param.kind === 'vec3') {
      const x = Number(nodeValues[`${param.key}_x`] ?? 0);
      const y = Number(nodeValues[`${param.key}_y`] ?? 0);
      const z = Number(nodeValues[`${param.key}_z`] ?? 0);
      parts.push(`${param.key}: new THREE.Vector3(${x}, ${y}, ${z})`);
    } else if (param.kind === 'vec2') {
      const x = Number(nodeValues[`${param.key}_x`] ?? 0);
      const y = Number(nodeValues[`${param.key}_y`] ?? 0);
      parts.push(`${param.key}: new THREE.Vector2(${x}, ${y})`);
    }
  }

  return parts.join(', ');
}
