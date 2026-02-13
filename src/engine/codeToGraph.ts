import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import type { AppNode, AppEdge, NodeDefinition, ParseError } from '@/types';
import { NODE_REGISTRY, TSL_FUNCTION_TO_DEF } from '@/registry/nodeRegistry';
import { autoLayout } from './layoutEngine';
import { generateId } from '@/utils/idGenerator';
import complexityData from '@/registry/complexity.json';

// Handle babel traverse CJS/ESM interop
const traverse = (
  typeof (_traverse as unknown as { default: typeof _traverse }).default === 'function'
    ? (_traverse as unknown as { default: typeof _traverse }).default
    : _traverse
) as typeof _traverse;

interface CodeToGraphResult {
  nodes: AppNode[];
  edges: AppEdge[];
  errors: ParseError[];
}

export function codeToGraph(
  code: string,
  _registry: Map<string, NodeDefinition> = NODE_REGISTRY
): CodeToGraphResult {
  if (!code.trim()) {
    return { nodes: [], edges: [], errors: [] };
  }

  let ast;
  try {
    ast = parse(code, {
      sourceType: 'module',
      plugins: ['typescript'],
      errorRecovery: true,
    });
  } catch (e: unknown) {
    const err = e as { message: string; loc?: { line: number; column: number } };
    return {
      nodes: [],
      edges: [],
      errors: [{ message: err.message, line: err.loc?.line }],
    };
  }

  const varToNodeId = new Map<string, string>();
  const rawNodes: AppNode[] = [];
  const rawEdges: AppEdge[] = [];

  traverse(ast, {
    VariableDeclarator(path) {
      if (!t.isIdentifier(path.node.id)) return;
      const varName = path.node.id.name;
      const init = path.node.init;
      if (!init) return;

      // const x = identifier (e.g. positionGeometry)
      if (t.isIdentifier(init)) {
        const def = TSL_FUNCTION_TO_DEF.get(init.name);
        if (def) {
          const nodeId = generateId();
          rawNodes.push(createNode(nodeId, def, varName));
          varToNodeId.set(varName, nodeId);
        }
        return;
      }

      // const x = func(args...) or const x = obj.method(args...)
      if (t.isCallExpression(init)) {
        processCall(init, varName, rawNodes, rawEdges, varToNodeId);
      }
    },
  });

  // Auto-layout
  const layoutedNodes = autoLayout(rawNodes, rawEdges, 'LR');

  return { nodes: layoutedNodes, edges: rawEdges, errors: [] };
}

function processCall(
  callExpr: t.CallExpression,
  varName: string,
  nodes: AppNode[],
  edges: AppEdge[],
  varToNodeId: Map<string, string>
): void {
  let funcName: string | undefined;
  let objectVarName: string | undefined;

  if (t.isIdentifier(callExpr.callee)) {
    // Direct call: noise(pos)
    funcName = callExpr.callee.name;
  } else if (
    t.isMemberExpression(callExpr.callee) &&
    t.isIdentifier(callExpr.callee.property)
  ) {
    // Chained call: pos.mul(2)
    funcName = callExpr.callee.property.name;
    if (t.isIdentifier(callExpr.callee.object)) {
      objectVarName = callExpr.callee.object.name;
    }
  }

  if (!funcName) return;

  // Look up definition
  let def = TSL_FUNCTION_TO_DEF.get(funcName);
  // Also try the registry type directly (e.g. for 'noise' mapping to 'mx_noise_float')
  if (!def) def = NODE_REGISTRY.get(funcName);
  if (!def) return;

  const nodeId = generateId();
  nodes.push(createNode(nodeId, def, varName));
  varToNodeId.set(varName, nodeId);

  // Wire edges from arguments
  let inputIdx = 0;

  // If chained, the object becomes the first input
  if (objectVarName && def.inputs.length > 0) {
    const sourceId = varToNodeId.get(objectVarName);
    if (sourceId) {
      edges.push({
        id: `e-${sourceId}-${nodeId}-${def.inputs[0].id}`,
        source: sourceId,
        sourceHandle: 'out',
        target: nodeId,
        targetHandle: def.inputs[0].id,
        data: { dataType: def.inputs[0].dataType },
      });
    }
    inputIdx = 1;
  }

  // Process remaining arguments
  for (let i = 0; i < callExpr.arguments.length; i++) {
    const arg = callExpr.arguments[i];
    const port = def.inputs[inputIdx + i];
    if (!port) break;

    if (t.isIdentifier(arg)) {
      const sourceId = varToNodeId.get(arg.name);
      if (sourceId) {
        edges.push({
          id: `e-${sourceId}-${nodeId}-${port.id}`,
          source: sourceId,
          sourceHandle: 'out',
          target: nodeId,
          targetHandle: port.id,
          data: { dataType: port.dataType },
        });
      }
    }
    // Numeric/string literals are stored as default values (already on node)
  }
}

function createNode(id: string, def: NodeDefinition, label: string): AppNode {
  const costs = complexityData.costs as Record<string, number>;
  const cost = costs[def.type] ?? 0;

  return {
    id,
    type: def.type === 'output' ? 'output' : 'shader',
    position: { x: 0, y: 0 },
    data: {
      registryType: def.type,
      label,
      cost,
      values: { ...def.defaultValues },
    },
  } as AppNode;
}
