import type { AppNode, AppEdge, NodeDefinition, GeneratedCode } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
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
    if (!def || node.data.registryType === 'output') continue;

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

  for (const node of sorted) {
    const def = registry.get(node.data.registryType);
    if (!def || node.data.registryType === 'output' || !def.tslImportModule) continue;
    addImport(def.tslImportModule, def.tslFunction);
  }

  // Build import lines
  const importLines: string[] = [];
  for (const [module, names] of importsByModule) {
    const sortedNames = Array.from(names).sort();
    importLines.push(`import { ${sortedNames.join(', ')} } from '${module}';`);
  }

  // Build body lines
  const bodyLines: string[] = [];

  for (const node of sorted) {
    const def = registry.get(node.data.registryType);
    if (!def || node.data.registryType === 'output') continue;

    const varName = varNames.get(node.id)!;
    const args = resolveArguments(node, edges, varNames, def);

    if (def.inputs.length === 0 && def.category === 'input') {
      // Input nodes: bare reference (positionGeometry, time, etc.)
      bodyLines.push(`  const ${varName} = ${def.tslFunction};`);
    } else if (def.inputs.length === 0 && def.defaultValues) {
      // Type constructors with default values
      const nodeValues = (node.data as { values?: Record<string, string | number> }).values;
      const defaultKey = Object.keys(def.defaultValues)[0];
      const val = nodeValues?.[defaultKey] ?? Object.values(def.defaultValues)[0];
      const formatted = typeof val === 'string' && val.startsWith('#')
        ? `0x${val.slice(1)}`
        : val;
      bodyLines.push(`  const ${varName} = ${def.tslFunction}(${formatted});`);
    } else {
      // Regular function call
      bodyLines.push(`  const ${varName} = ${def.tslFunction}(${args.join(', ')});`);
    }
  }

  // Handle output node return
  const outputNode = sorted.find((n) => n.data.registryType === 'output');
  let returnLine = '  return vec3(1, 0, 0); // default red';

  if (outputNode) {
    const colorEdge = edges.find(
      (e) => e.target === outputNode.id && e.targetHandle === 'color'
    );
    if (colorEdge && varNames.has(colorEdge.source)) {
      returnLine = `  return ${varNames.get(colorEdge.source)};`;
    }
  }

  // Check if vec3 is needed for fallback
  if (returnLine.includes('vec3(') && !importsByModule.get('three/tsl')?.has('vec3')) {
    addImport('three/tsl', 'vec3');
    // Rebuild import lines
    importLines.length = 0;
    for (const [module, names] of importsByModule) {
      const sortedNames = Array.from(names).sort();
      importLines.push(`import { ${sortedNames.join(', ')} } from '${module}';`);
    }
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

function resolveArguments(
  node: AppNode,
  edges: AppEdge[],
  varNames: Map<string, string>,
  def: NodeDefinition
): string[] {
  return def.inputs.map((input) => {
    const edge = edges.find(
      (e) => e.target === node.id && e.targetHandle === input.id
    );
    if (edge && varNames.has(edge.source)) {
      return varNames.get(edge.source)!;
    }
    // No connection: use node's stored value or placeholder
    const nodeValues = (node.data as { values?: Record<string, string | number> }).values;
    const val = nodeValues?.[input.id];
    if (val !== undefined) return String(val);
    return '0';
  });
}
