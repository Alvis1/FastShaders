import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import type { AppNode, AppEdge, NodeDefinition, ParseError } from '@/types';
import { getNodeValues } from '@/types';
import { NODE_REGISTRY, TSL_FUNCTION_TO_DEF, getFlowNodeType } from '@/registry/nodeRegistry';
import { generateId, generateEdgeId } from '@/utils/idGenerator';
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

      // Handle "return x;" or "return { color: x, position: y };" to create the Output node
      ReturnStatement(path) {
        if (hasOutput) return;
        const arg = path.node.argument;
        if (!arg) return;

        const outputDef = NODE_REGISTRY.get('output');
        if (!outputDef) return;

        const outputId = generateId();
        rawNodes.push(createNode(outputId, outputDef, 'Output'));
        hasOutput = true;

        // Multi-channel return: return { color: x, position: y, ... }
        if (t.isObjectExpression(arg)) {
          for (const prop of arg.properties) {
            if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key)) continue;
            const channel = prop.key.name;
            const sourceId = t.isIdentifier(prop.value)
              ? varToNodeId.get(prop.value.name)
              : undefined;
            if (sourceId) {
              rawEdges.push({
                id: generateEdgeId(sourceId, 'out', outputId, channel),
                source: sourceId,
                sourceHandle: 'out',
                target: outputId,
                targetHandle: channel,
                type: 'typed' as const,
                animated: true,
                data: { dataType: 'any' as const },
              });
            }
          }
          return;
        }

        // Single-value return: wire to output.color
        const sourceId = resolveReturnSource(arg, rawNodes, rawEdges, varToNodeId);
        if (sourceId) {
          rawEdges.push({
            id: generateEdgeId(sourceId, 'out', outputId, 'color'),
            source: sourceId,
            sourceHandle: 'out',
            target: outputId,
            targetHandle: 'color',
            type: 'typed' as const,
            animated: true,
            data: { dataType: 'any' as const },
          });
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

/** Resolve a return statement argument to a source node ID. Handles identifiers, call expressions, and member expressions. */
function resolveReturnSource(
  arg: t.Node,
  nodes: AppNode[],
  edges: AppEdge[],
  varToNodeId: Map<string, string>
): string | undefined {
  // return someVar;
  if (t.isIdentifier(arg)) {
    return varToNodeId.get(arg.name);
  }
  // return someFunc(a, b); — process as an inline call and return its node ID
  if (t.isCallExpression(arg)) {
    const tempVar = '_return';
    processCall(arg, tempVar, nodes, edges, varToNodeId);
    return varToNodeId.get(tempVar);
  }
  return undefined;
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

  // Detect UV-tiling pattern: mul(uv(), vec2(x, y)) → create UV node with tiling values
  if (funcName === 'mul' && callExpr.arguments.length === 2) {
    const uvNode = tryParseUVTiling(callExpr, varName, nodes, edges, varToNodeId);
    if (uvNode) return;
  }

  // Look up definition
  let def = TSL_FUNCTION_TO_DEF.get(funcName);
  // Also try the registry type directly (e.g. for 'noise' mapping to 'mx_noise_float')
  if (!def) def = NODE_REGISTRY.get(funcName);
  if (!def) return;

  const nodeId = generateId();
  nodes.push(createNode(nodeId, def, varName));
  varToNodeId.set(varName, nodeId);

  // tsl-textures: single object argument
  if (
    def.tslImportModule === 'tsl-textures' &&
    callExpr.arguments.length === 1 &&
    t.isObjectExpression(callExpr.arguments[0])
  ) {
    processObjectCall(callExpr.arguments[0], nodeId, def, nodes, edges, varToNodeId);
    return;
  }

  // Noise nodes: special positional arg mapping
  // graphToCode emits: mx_fractal_noise_float(posOrMul, octaves, lacunarity, diminish)
  // where posOrMul is either `positionGeometry`, a var ref, or `mul(pos, scale)`
  if (def.category === 'noise') {
    processNoiseCall(callExpr, nodeId, def, nodes, edges, varToNodeId);
    return;
  }

  // Wire edges from arguments
  let inputIdx = 0;

  // If chained, the object becomes the first input
  if (objectVarName && def.inputs.length > 0) {
    const sourceId = varToNodeId.get(objectVarName);
    if (sourceId) {
      edges.push({
        id: generateEdgeId(sourceId, 'out', nodeId, def.inputs[0].id),
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
  const defaultKeys = def.defaultValues ? Object.keys(def.defaultValues) : [];

  for (let i = 0; i < callExpr.arguments.length; i++) {
    const arg = callExpr.arguments[i];
    const port = def.inputs[inputIdx + i];

    const literalValue = extractLiteral(arg);

    if (t.isIdentifier(arg)) {
      const sourceId = varToNodeId.get(arg.name);
      if (sourceId && port) {
        // Wire to a defined input port
        edges.push({
          id: generateEdgeId(sourceId, 'out', nodeId, port.id),
          source: sourceId,
          sourceHandle: 'out',
          target: nodeId,
          targetHandle: port.id,
          type: 'typed' as const,
          animated: true,
          data: { dataType: port.dataType },
        });
      } else if (sourceId && def.inputs.length === 0 && defaultKeys[i]) {
        // No defined input ports (noise/UV) — wire edge to the defaultValues key
        edges.push({
          id: generateEdgeId(sourceId, 'out', nodeId, defaultKeys[i]),
          source: sourceId,
          sourceHandle: 'out',
          target: nodeId,
          targetHandle: defaultKeys[i],
          type: 'typed' as const,
          animated: true,
          data: { dataType: 'any' as const },
        });
      } else if (!sourceId && def.inputs.length === 0 && defaultKeys[i]) {
        // Bare identifier (e.g. positionGeometry) — store as string value
        extractedValues[defaultKeys[i]] = arg.name;
      } else if (!port) {
        break;
      }
    } else if (literalValue !== undefined) {
      // Type constructors or noise nodes (no inputs, has defaultValues) — use default key order
      if (def.inputs.length === 0 && def.defaultValues) {
        const key = defaultKeys[i] ?? 'value';
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
      const prev = getNodeValues(node);
      (node.data as Record<string, unknown>).values = { ...prev, ...extractedValues };
    }
  }

  // For property_float nodes, set the property name from the variable name in code
  if (def.type === 'property_float') {
    const node = nodes.find((n) => n.id === nodeId);
    if (node) {
      const prev = getNodeValues(node);
      (node.data as Record<string, unknown>).values = { ...prev, name: varName };
    }
  }
}

/**
 * Detect `mul(uv(), vec2(tilingU, tilingV))` pattern and create a UV node with tiling values.
 * Returns true if the pattern was matched and handled.
 */
function tryParseUVTiling(
  callExpr: t.CallExpression,
  varName: string,
  nodes: AppNode[],
  _edges: AppEdge[],
  varToNodeId: Map<string, string>
): boolean {
  const [arg0, arg1] = callExpr.arguments;

  // arg0 must be uv() or uv(channel)
  if (!t.isCallExpression(arg0) || !t.isIdentifier(arg0.callee) || arg0.callee.name !== 'uv') {
    return false;
  }
  // arg1 must be vec2(x, y)
  if (!t.isCallExpression(arg1) || !t.isIdentifier(arg1.callee) || arg1.callee.name !== 'vec2') {
    return false;
  }

  const uvDef = NODE_REGISTRY.get('uv');
  if (!uvDef) return false;

  const channel = arg0.arguments.length > 0 ? (extractLiteral(arg0.arguments[0]) ?? 0) : 0;
  const tilingU = arg1.arguments.length > 0 ? (extractLiteral(arg1.arguments[0]) ?? 1) : 1;
  const tilingV = arg1.arguments.length > 1 ? (extractLiteral(arg1.arguments[1]) ?? 1) : 1;

  const nodeId = generateId();
  const node = createNode(nodeId, uvDef, varName);
  (node.data as Record<string, unknown>).values = {
    ...uvDef.defaultValues,
    channel: Number(channel),
    tilingU: Number(tilingU),
    tilingV: Number(tilingV),
  };
  nodes.push(node);
  varToNodeId.set(varName, nodeId);
  return true;
}

/**
 * Parse noise function calls: mx_fractal_noise_float(posOrMul, octaves, lacunarity, diminish)
 * The first arg may be `positionGeometry`, a variable ref, or `mul(pos, scale)`.
 * Remaining args map to fractal-specific defaultValues keys.
 */
function processNoiseCall(
  callExpr: t.CallExpression,
  nodeId: string,
  def: NodeDefinition,
  nodes: AppNode[],
  edges: AppEdge[],
  varToNodeId: Map<string, string>
): void {
  const extractedValues: Record<string, string | number> = {};
  const args = callExpr.arguments;

  // --- arg[0]: position (possibly wrapped in mul(pos, scale)) ---
  if (args.length > 0) {
    const posArg = args[0];
    if (
      t.isCallExpression(posArg) &&
      t.isIdentifier(posArg.callee) &&
      posArg.callee.name === 'mul' &&
      posArg.arguments.length === 2
    ) {
      // mul(pos, scale) pattern — extract both
      const posInner = posArg.arguments[0];
      const scaleInner = posArg.arguments[1];
      if (t.isIdentifier(posInner)) {
        const sourceId = varToNodeId.get(posInner.name);
        if (sourceId) {
          edges.push({
            id: generateEdgeId(sourceId, 'out', nodeId, 'pos'),
            source: sourceId, sourceHandle: 'out',
            target: nodeId, targetHandle: 'pos',
            type: 'typed' as const, animated: true,
            data: { dataType: 'any' as const },
          });
        } else {
          extractedValues.pos = posInner.name;
        }
      }
      const scaleLit = extractLiteral(scaleInner);
      if (scaleLit !== undefined) {
        extractedValues.scale = scaleLit;
      } else if (t.isIdentifier(scaleInner)) {
        const sourceId = varToNodeId.get(scaleInner.name);
        if (sourceId) {
          edges.push({
            id: generateEdgeId(sourceId, 'out', nodeId, 'scale'),
            source: sourceId, sourceHandle: 'out',
            target: nodeId, targetHandle: 'scale',
            type: 'typed' as const, animated: true,
            data: { dataType: 'any' as const },
          });
        }
      }
    } else if (t.isIdentifier(posArg)) {
      const sourceId = varToNodeId.get(posArg.name);
      if (sourceId) {
        edges.push({
          id: generateEdgeId(sourceId, 'out', nodeId, 'pos'),
          source: sourceId, sourceHandle: 'out',
          target: nodeId, targetHandle: 'pos',
          type: 'typed' as const, animated: true,
          data: { dataType: 'any' as const },
        });
      } else {
        extractedValues.pos = posArg.name;
      }
    }
  }

  // --- fractal-specific args: octaves (arg[1]), lacunarity (arg[2]), diminish (arg[3]) ---
  const fractalKeys = ['octaves', 'lacunarity', 'diminish'];
  for (let i = 0; i < fractalKeys.length; i++) {
    const arg = args[1 + i];
    if (!arg) break;
    const lit = extractLiteral(arg);
    if (lit !== undefined) {
      extractedValues[fractalKeys[i]] = lit;
    } else if (t.isIdentifier(arg)) {
      const sourceId = varToNodeId.get(arg.name);
      if (sourceId) {
        edges.push({
          id: generateEdgeId(sourceId, 'out', nodeId, fractalKeys[i]),
          source: sourceId, sourceHandle: 'out',
          target: nodeId, targetHandle: fractalKeys[i],
          type: 'typed' as const, animated: true,
          data: { dataType: 'any' as const },
        });
      }
    }
  }

  // Merge extracted values
  if (Object.keys(extractedValues).length > 0) {
    const node = nodes.find((n) => n.id === nodeId);
    if (node) {
      const prev = getNodeValues(node);
      (node.data as Record<string, unknown>).values = { ...prev, ...extractedValues };
    }
  }
}

function processObjectCall(
  objExpr: t.ObjectExpression,
  nodeId: string,
  def: NodeDefinition,
  nodes: AppNode[],
  edges: AppEdge[],
  varToNodeId: Map<string, string>
): void {
  const extractedValues: Record<string, string | number> = {};

  for (const prop of objExpr.properties) {
    if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key)) continue;
    const key = prop.key.name;
    const val = prop.value;

    // Variable reference → wire as edge
    if (t.isIdentifier(val)) {
      const sourceId = varToNodeId.get(val.name);
      const port = def.inputs.find((p) => p.id === key);
      if (sourceId && port) {
        edges.push({
          id: generateEdgeId(sourceId, 'out', nodeId, port.id),
          source: sourceId,
          sourceHandle: 'out',
          target: nodeId,
          targetHandle: port.id,
          type: 'typed' as const,
          animated: true,
          data: { dataType: port.dataType },
        });
      }
      continue;
    }

    // new THREE.Color(0x...) or new Color(0x...)
    const ctor = extractConstructor(val);
    if (ctor) {
      if (ctor.type === 'color') {
        extractedValues[key] = ctor.hex;
      } else if (ctor.type === 'vec3') {
        extractedValues[`${key}_x`] = ctor.x;
        extractedValues[`${key}_y`] = ctor.y;
        extractedValues[`${key}_z`] = ctor.z;
      } else if (ctor.type === 'vec2') {
        extractedValues[`${key}_x`] = ctor.x;
        extractedValues[`${key}_y`] = ctor.y;
      }
      continue;
    }

    // Numeric literal
    const lit = extractLiteral(val);
    if (lit !== undefined) {
      extractedValues[key] = lit;
    }
  }

  // Merge extracted values into the node
  if (Object.keys(extractedValues).length > 0) {
    const node = nodes.find((n) => n.id === nodeId);
    if (node) {
      const prev = getNodeValues(node);
      (node.data as Record<string, unknown>).values = { ...prev, ...extractedValues };
    }
  }
}

type ConstructorResult =
  | { type: 'color'; hex: string }
  | { type: 'vec3'; x: number; y: number; z: number }
  | { type: 'vec2'; x: number; y: number };

function extractConstructor(node: t.Node): ConstructorResult | null {
  if (!t.isNewExpression(node)) return null;

  let className: string | undefined;

  // new Color(...) or new THREE.Color(...)
  if (t.isIdentifier(node.callee)) {
    className = node.callee.name;
  } else if (
    t.isMemberExpression(node.callee) &&
    t.isIdentifier(node.callee.property)
  ) {
    className = node.callee.property.name;
  }

  if (!className) return null;

  const args = node.arguments;

  if (className === 'Color') {
    // new THREE.Color(0xff0000) or new THREE.Color(r, g, b)
    if (args.length === 1) {
      const lit = extractLiteral(args[0] as t.Node);
      if (typeof lit === 'number') {
        return { type: 'color', hex: '#' + Math.round(lit).toString(16).padStart(6, '0') };
      }
      if (typeof lit === 'string') {
        return { type: 'color', hex: lit.startsWith('#') ? lit : `#${lit}` };
      }
    } else if (args.length === 3) {
      const r = extractLiteral(args[0] as t.Node) ?? 0;
      const g = extractLiteral(args[1] as t.Node) ?? 0;
      const b = extractLiteral(args[2] as t.Node) ?? 0;
      const rHex = Math.round(Number(r) * 255).toString(16).padStart(2, '0');
      const gHex = Math.round(Number(g) * 255).toString(16).padStart(2, '0');
      const bHex = Math.round(Number(b) * 255).toString(16).padStart(2, '0');
      return { type: 'color', hex: `#${rHex}${gHex}${bHex}` };
    }
    return { type: 'color', hex: '#ff0000' };
  }

  if (className === 'Vector3') {
    const x = Number(extractLiteral(args[0] as t.Node) ?? 0);
    const y = Number(extractLiteral(args[1] as t.Node) ?? 0);
    const z = Number(extractLiteral(args[2] as t.Node) ?? 0);
    return { type: 'vec3', x, y, z };
  }

  if (className === 'Vector2') {
    const x = Number(extractLiteral(args[0] as t.Node) ?? 0);
    const y = Number(extractLiteral(args[1] as t.Node) ?? 0);
    return { type: 'vec2', x, y };
  }

  return null;
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
  const cost = costs[def.type] ?? (def.category === 'texture' ? 50 : 0);

  return {
    id,
    type: getFlowNodeType(def),
    position: { x: 0, y: 0 },
    data: {
      registryType: def.type,
      label,
      cost,
      values: { ...def.defaultValues },
    },
  } as AppNode;
}
