import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import type { AppNode, AppEdge, NodeDefinition, ParseError, ShaderNodeData } from '@/types';
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
  const warnings: ParseError[] = [];
  // Track split nodes created for member expression patterns (sourceVarName → splitNodeId)
  const splitNodes = new Map<string, string>();

  let hasOutput = false;

  // Build the OutputNode and wire its channels from a return/output expression.
  // Shared between `return X` (FastShaders canonical form) and `output = X`
  // (three.js TSL editor compatible form).
  const buildOutputFromExpr = (arg: t.Node): void => {
    if (hasOutput) return;

    const outputDef = NODE_REGISTRY.get('output');
    if (!outputDef) return;

    const outputId = generateId();
    rawNodes.push(createNode(outputId, outputDef, 'Output'));
    hasOutput = true;

    // Multi-channel: { color: x, position: y, ... }
    if (t.isObjectExpression(arg)) {
      for (const prop of arg.properties) {
        if (!t.isObjectProperty(prop) || !t.isIdentifier(prop.key)) continue;
        const channel = prop.key.name;
        if (t.isIdentifier(prop.value)) {
          const sourceId = varToNodeId.get(prop.value.name)
            ?? ensureBareInputNode(prop.value.name, rawNodes, varToNodeId);
          if (sourceId) {
            rawEdges.push({
              id: generateEdgeId(sourceId, 'out', outputId, channel),
              source: sourceId, sourceHandle: 'out',
              target: outputId, targetHandle: channel,
              type: 'typed' as const, animated: true,
              data: { dataType: 'any' as const },
            });
          }
        } else if (t.isMemberExpression(prop.value)) {
          const ref = resolveMemberExpr(prop.value, rawNodes, rawEdges, varToNodeId, splitNodes);
          if (ref) {
            rawEdges.push({
              id: generateEdgeId(ref.nodeId, ref.handle, outputId, channel),
              source: ref.nodeId, sourceHandle: ref.handle,
              target: outputId, targetHandle: channel,
              type: 'typed' as const, animated: true,
              data: { dataType: 'float' as const },
            });
          }
        } else if (t.isCallExpression(prop.value)) {
          const tempVar = `_return_${channel}`;
          processCall(prop.value, tempVar, rawNodes, rawEdges, varToNodeId, splitNodes, code, warnings);
          const sourceId = varToNodeId.get(tempVar);
          if (sourceId) {
            rawEdges.push({
              id: generateEdgeId(sourceId, 'out', outputId, channel),
              source: sourceId, sourceHandle: 'out',
              target: outputId, targetHandle: channel,
              type: 'typed' as const, animated: true,
              data: { dataType: 'any' as const },
            });
          }
        }
      }
      return;
    }

    // Single-value: wire to output.color
    const returnRef = resolveReturnSource(arg, rawNodes, rawEdges, varToNodeId, splitNodes, code, warnings);
    if (returnRef) {
      rawEdges.push({
        id: generateEdgeId(returnRef.nodeId, returnRef.handle, outputId, 'color'),
        source: returnRef.nodeId,
        sourceHandle: returnRef.handle,
        target: outputId,
        targetHandle: 'color',
        type: 'typed' as const,
        animated: true,
        data: { dataType: 'any' as const },
      });
    }
  };

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
          processCall(init, varName, rawNodes, rawEdges, varToNodeId, splitNodes, code, warnings);
        }
      },

      // Handle "return x;" or "return { color: x, position: y };" to create the Output node
      ReturnStatement(path) {
        const arg = path.node.argument;
        if (!arg) return;
        buildOutputFromExpr(arg);
      },

      // Handle three.js TSL editor compatible form: `output = X` at the top level.
      // The three.js webgpu_tsl_editor example evaluates a flat snippet that
      // assigns its result to a magic `output` variable. We treat that exactly
      // like a return statement so snippets can be pasted in directly.
      AssignmentExpression(path) {
        if (path.node.operator !== '=') return;
        if (!t.isIdentifier(path.node.left)) return;
        if (path.node.left.name !== 'output') return;
        buildOutputFromExpr(path.node.right);
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { nodes: [], edges: [], errors: [{ message: msg }] };
  }

  // If no return/output assignment produced an output node, add an unconnected one
  if (!hasOutput) {
    const outputDef = NODE_REGISTRY.get('output');
    if (outputDef) {
      rawNodes.push(createNode(generateId(), outputDef, 'Output'));
    }
  }

  return { nodes: rawNodes, edges: rawEdges, errors: warnings };
}

/**
 * Lazily create an input node for a bare TSL identifier (e.g. `time`,
 * `positionGeometry`, `normalGeometry`) the first time it appears as a chained
 * receiver or call argument. This lets snippets pasted from the three.js TSL
 * editor — which use these globals directly without `const time1 = time;`
 * scaffolding — still produce a wired graph.
 */
function ensureBareInputNode(
  name: string,
  nodes: AppNode[],
  varToNodeId: Map<string, string>,
): string | undefined {
  const existing = varToNodeId.get(name);
  if (existing) return existing;
  const def = TSL_FUNCTION_TO_DEF.get(name);
  if (!def) return undefined;
  // Only auto-create zero-arg input nodes (time, positionGeometry, uv, etc.).
  // Anything that takes parameters or has default values must be declared
  // explicitly so we don't guess at the wrong shape.
  if (def.inputs.length > 0 || def.defaultValues) return undefined;
  if (def.category !== 'input') return undefined;
  const nodeId = generateId();
  nodes.push(createNode(nodeId, def, name));
  varToNodeId.set(name, nodeId);
  return nodeId;
}

/** Resolve a return statement argument to a source node ID + optional handle. */
function resolveReturnSource(
  arg: t.Node,
  nodes: AppNode[],
  edges: AppEdge[],
  varToNodeId: Map<string, string>,
  splitNodesMap: Map<string, string>,
  code: string,
  errors: ParseError[],
): { nodeId: string; handle: string } | undefined {
  // return someVar;  (or `output = someVar` for three.js editor compatible form)
  if (t.isIdentifier(arg)) {
    const id = varToNodeId.get(arg.name) ?? ensureBareInputNode(arg.name, nodes, varToNodeId);
    if (id) return { nodeId: id, handle: 'out' };
  }
  // return someVar.x; — member expression through split node
  if (t.isMemberExpression(arg)) {
    const ref = resolveMemberExpr(arg, nodes, edges, varToNodeId, splitNodesMap);
    if (ref) return ref;
  }
  // return someFunc(a, b); — process as an inline call and return its node ID
  if (t.isCallExpression(arg)) {
    const tempVar = '_return';
    processCall(arg, tempVar, nodes, edges, varToNodeId, splitNodesMap, code, errors);
    const id = varToNodeId.get(tempVar);
    if (id) return { nodeId: id, handle: 'out' };
  }
  return undefined;
}

function processCall(
  callExpr: t.CallExpression,
  varName: string,
  nodes: AppNode[],
  edges: AppEdge[],
  varToNodeId: Map<string, string>,
  splitNodesMap: Map<string, string> = new Map(),
  code: string = '',
  errors: ParseError[] = [],
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

  // Pass-through TSL methods that don't change graph semantics. `.toVar()`
  // and `.toConst()` only mark a node for evaluation in the GPU pipeline; for
  // graph purposes they alias the receiver. Common in three.js TSL editor
  // snippets like `const blink = sin(t).toVar();`.
  if (
    (funcName === 'toVar' || funcName === 'toConst') &&
    callExpr.arguments.length === 0 &&
    t.isMemberExpression(callExpr.callee)
  ) {
    const inner = callExpr.callee.object;
    if (t.isIdentifier(inner)) {
      const sourceId =
        varToNodeId.get(inner.name) ?? ensureBareInputNode(inner.name, nodes, varToNodeId);
      if (sourceId) varToNodeId.set(varName, sourceId);
      return;
    }
    if (t.isCallExpression(inner)) {
      // Recurse: let the inner call produce a node under our varName.
      processCall(inner, varName, nodes, edges, varToNodeId, splitNodesMap, code, errors);
      return;
    }
  }

  // Detect UV-tiling pattern: mul(uv(), vec2(x, y)) → create UV node with tiling values
  if (funcName === 'mul' && callExpr.arguments.length === 2) {
    const uvNode = tryParseUVTiling(callExpr, varName, nodes, edges, varToNodeId);
    if (uvNode) return;
  }

  // Detect append pattern: vec2(ref, ref) where at least one arg is a variable reference
  if (funcName === 'vec2' && callExpr.arguments.length === 2) {
    const hasVarRef = callExpr.arguments.some(
      (a) => t.isIdentifier(a) && varToNodeId.has(a.name)
    );
    const hasMemberRef = callExpr.arguments.some(
      (a) => t.isMemberExpression(a) && t.isIdentifier(a.object) && varToNodeId.has(a.object.name)
    );
    if (hasVarRef || hasMemberRef) {
      const appendDef = NODE_REGISTRY.get('append');
      if (appendDef) {
        const nodeId = generateId();
        nodes.push(createNode(nodeId, appendDef, varName));
        varToNodeId.set(varName, nodeId);
        const ports = ['a', 'b'];
        for (let i = 0; i < 2; i++) {
          const arg = callExpr.arguments[i];
          if (t.isIdentifier(arg)) {
            const sourceId =
              varToNodeId.get(arg.name) ?? ensureBareInputNode(arg.name, nodes, varToNodeId);
            if (sourceId) {
              edges.push({
                id: generateEdgeId(sourceId, 'out', nodeId, ports[i]),
                source: sourceId, sourceHandle: 'out',
                target: nodeId, targetHandle: ports[i],
                type: 'typed' as const, animated: true,
                data: { dataType: 'any' as const },
              });
            }
          } else if (t.isMemberExpression(arg)) {
            const ref = resolveMemberExpr(arg, nodes, edges, varToNodeId, splitNodesMap);
            if (ref) {
              edges.push({
                id: generateEdgeId(ref.nodeId, ref.handle, nodeId, ports[i]),
                source: ref.nodeId, sourceHandle: ref.handle,
                target: nodeId, targetHandle: ports[i],
                type: 'typed' as const, animated: true,
                data: { dataType: 'float' as const },
              });
            }
          }
        }
        return;
      }
    }
  }

  // Look up definition
  let def = TSL_FUNCTION_TO_DEF.get(funcName);
  // Also try the registry type directly (e.g. for 'noise' mapping to 'mx_noise_float')
  if (!def) def = NODE_REGISTRY.get(funcName);
  if (!def) {
    // Create an unknown node preserving the raw expression for round-tripping
    const unknownDef = NODE_REGISTRY.get('unknown');
    if (!unknownDef) return;
    const nodeId = generateId();
    const rawExpr = callExpr.start != null && callExpr.end != null
      ? code.slice(callExpr.start, callExpr.end)
      : `${funcName}(/* ... */)`;
    const node = createNode(nodeId, unknownDef, varName);
    (node.data as ShaderNodeData).values = { functionName: funcName, rawExpression: rawExpr };
    nodes.push(node);
    varToNodeId.set(varName, nodeId);
    errors.push({
      message: `Unknown function: ${funcName}`,
      line: callExpr.loc?.start.line,
      severity: 'warning',
    });
    return;
  }

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
  // graphToCode emits: mx_worley_noise_float(posOrMul)
  // where posOrMul is either `positionGeometry`, a var ref, or `mul(pos, scale)`
  if (def.category === 'noise') {
    processNoiseCall(callExpr, nodeId, def, nodes, edges, varToNodeId);
    return;
  }

  // Wire edges from arguments
  let inputIdx = 0;

  // If chained, the object becomes the first input
  if (objectVarName && def.inputs.length > 0) {
    const sourceId =
      varToNodeId.get(objectVarName) ?? ensureBareInputNode(objectVarName, nodes, varToNodeId);
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
      const sourceId =
        varToNodeId.get(arg.name) ?? ensureBareInputNode(arg.name, nodes, varToNodeId);
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
    } else if (t.isMemberExpression(arg)) {
      // Member expression: someVar.x → resolve through split node
      const ref = resolveMemberExpr(arg, nodes, edges, varToNodeId, splitNodesMap);
      if (ref && port) {
        edges.push({
          id: generateEdgeId(ref.nodeId, ref.handle, nodeId, port.id),
          source: ref.nodeId, sourceHandle: ref.handle,
          target: nodeId, targetHandle: port.id,
          type: 'typed' as const, animated: true,
          data: { dataType: 'float' as const },
        });
      } else if (ref && def.inputs.length === 0 && defaultKeys[i]) {
        edges.push({
          id: generateEdgeId(ref.nodeId, ref.handle, nodeId, defaultKeys[i]),
          source: ref.nodeId, sourceHandle: ref.handle,
          target: nodeId, targetHandle: defaultKeys[i],
          type: 'typed' as const, animated: true,
          data: { dataType: 'float' as const },
        });
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
 * Parse noise function calls: mx_worley_noise_float(posOrMul)
 * The first arg may be `positionGeometry`, a variable ref, or `mul(pos, scale)`.
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

    // new THREE.Color(0x...) / color(0x...) / vec3(1,2,3) / vec2(1,2)
    const ctor = extractConstructor(val) ?? extractTSLConstructorCall(val);
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

const SWIZZLE_COMPONENTS = new Set(['x', 'y', 'z', 'w']);

/**
 * Resolve a member expression like `someVar.x` to a split node output.
 * Creates the split node on first use for each source variable.
 * Returns { nodeId, handle } for the split node output, or null.
 */
function resolveMemberExpr(
  expr: t.MemberExpression,
  nodes: AppNode[],
  edges: AppEdge[],
  varToNodeId: Map<string, string>,
  splitNodesMap: Map<string, string>,
): { nodeId: string; handle: string } | null {
  if (!t.isIdentifier(expr.object) || !t.isIdentifier(expr.property)) return null;
  const varName = expr.object.name;
  const component = expr.property.name;
  if (!SWIZZLE_COMPONENTS.has(component)) return null;

  const sourceId = varToNodeId.get(varName);
  if (!sourceId) return null;

  // Reuse existing split node for this source variable
  let splitId = splitNodesMap.get(varName);
  if (!splitId) {
    const splitDef = NODE_REGISTRY.get('split');
    if (!splitDef) return null;
    splitId = generateId();
    nodes.push(createNode(splitId, splitDef, `split_${varName}`));
    // Wire source → split.v
    edges.push({
      id: generateEdgeId(sourceId, 'out', splitId, 'v'),
      source: sourceId,
      sourceHandle: 'out',
      target: splitId,
      targetHandle: 'v',
      type: 'typed' as const,
      animated: true,
      data: { dataType: 'any' as const },
    });
    splitNodesMap.set(varName, splitId);
  }

  return { nodeId: splitId, handle: component };
}

/**
 * Extract a TSL constructor function call: color(0xFF), vec3(1,2,3), vec2(1,2).
 * Unlike extractConstructor, this handles function calls (not `new` expressions).
 */
function extractTSLConstructorCall(node: t.Node): ConstructorResult | null {
  if (!t.isCallExpression(node) || !t.isIdentifier(node.callee)) return null;
  const name = node.callee.name;
  const args = node.arguments;

  if (name === 'color' && args.length >= 1) {
    const lit = extractLiteral(args[0] as t.Node);
    if (typeof lit === 'number') {
      return { type: 'color', hex: '#' + Math.round(lit).toString(16).padStart(6, '0') };
    }
    if (typeof lit === 'string') {
      return { type: 'color', hex: lit.startsWith('#') ? lit : `#${lit}` };
    }
    return { type: 'color', hex: '#ff0000' };
  }
  if (name === 'vec3' && args.length >= 3) {
    return {
      type: 'vec3',
      x: Number(extractLiteral(args[0] as t.Node) ?? 0),
      y: Number(extractLiteral(args[1] as t.Node) ?? 0),
      z: Number(extractLiteral(args[2] as t.Node) ?? 0),
    };
  }
  if (name === 'vec2' && args.length >= 2) {
    return {
      type: 'vec2',
      x: Number(extractLiteral(args[0] as t.Node) ?? 0),
      y: Number(extractLiteral(args[1] as t.Node) ?? 0),
    };
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
