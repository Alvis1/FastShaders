import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import type { AppNode, AppEdge, NodeDefinition, ParseError } from '@/types';
import { NODE_REGISTRY, TSL_FUNCTION_TO_DEF } from '@/registry/nodeRegistry';
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

  let hasOutput = false;

  try {
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

      // Handle "return x;" to create the Output node and wire the color input
      ReturnStatement(path) {
        if (hasOutput) return;
        const arg = path.node.argument;
        if (!arg) return;

        const outputDef = NODE_REGISTRY.get('output');
        if (!outputDef) return;

        const outputId = generateId();
        rawNodes.push(createNode(outputId, outputDef, 'Output'));
        hasOutput = true;

        // Wire the returned value → output.color
        if (t.isIdentifier(arg)) {
          const sourceId = varToNodeId.get(arg.name);
          if (sourceId) {
            rawEdges.push({
              id: `e-${sourceId}-${outputId}-color`,
              source: sourceId,
              sourceHandle: 'out',
              target: outputId,
              targetHandle: 'color',
              type: 'typed' as const,
              animated: true,
              data: { dataType: 'any' as const },
            });
          }
        }
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { nodes: [], edges: [], errors: [{ message: msg }] };
  }

  // If no return statement produced an output node, add an unconnected one
  if (!hasOutput) {
    const outputDef = NODE_REGISTRY.get('output');
    if (outputDef) {
      rawNodes.push(createNode(generateId(), outputDef, 'Output'));
    }
  }

  return { nodes: rawNodes, edges: rawEdges, errors: [] };
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
        type: 'typed' as const,
        animated: true,
        data: { dataType: def.inputs[0].dataType },
      });
    }
    inputIdx = 1;
  }

  // Process remaining arguments — extract literals and wire identifier edges
  const extractedValues: Record<string, string | number> = {};

  for (let i = 0; i < callExpr.arguments.length; i++) {
    const arg = callExpr.arguments[i];
    const port = def.inputs[inputIdx + i];

    const literalValue = extractLiteral(arg);

    if (t.isIdentifier(arg)) {
      if (!port) break;
      const sourceId = varToNodeId.get(arg.name);
      if (sourceId) {
        edges.push({
          id: `e-${sourceId}-${nodeId}-${port.id}`,
          source: sourceId,
          sourceHandle: 'out',
          target: nodeId,
          targetHandle: port.id,
          type: 'typed' as const,
          animated: true,
          data: { dataType: port.dataType },
        });
      }
    } else if (literalValue !== undefined) {
      // Type constructors (no inputs, has defaultValues) — use default key order
      if (def.inputs.length === 0 && def.defaultValues) {
        const key = Object.keys(def.defaultValues)[i] ?? 'value';
        // Handle hex color literals: color(0xff0000) → '#ff0000'
        if (key === 'hex' && typeof literalValue === 'number') {
          extractedValues[key] = '#' + Math.round(literalValue).toString(16).padStart(6, '0');
        } else {
          extractedValues[key] = literalValue;
        }
      } else if (port) {
        extractedValues[port.id] = literalValue;
      }
    }
  }

  // Merge extracted values into the node
  if (Object.keys(extractedValues).length > 0) {
    const node = nodes.find((n) => n.id === nodeId);
    if (node) {
      const data = node.data as { values: Record<string, string | number> };
      data.values = { ...data.values, ...extractedValues };
    }
  }
}

function extractLiteral(node: t.Node): string | number | undefined {
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isStringLiteral(node)) return node.value;
  // Negative numbers: -2.5
  if (t.isUnaryExpression(node) && node.operator === '-' && t.isNumericLiteral(node.argument)) {
    return -node.argument.value;
  }
  return undefined;
}

function createNode(id: string, def: NodeDefinition, label: string): AppNode {
  const costs = complexityData.costs as Record<string, number>;
  const cost = costs[def.type] ?? 0;

  return {
    id,
    type: def.type === 'output' ? 'output' : def.type === 'color' ? 'color' : def.category === 'noise' ? 'preview' : 'shader',
    position: { x: 0, y: 0 },
    data: {
      registryType: def.type,
      label,
      cost,
      values: { ...def.defaultValues },
    },
  } as AppNode;
}
