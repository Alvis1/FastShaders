import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import type { AppNode, AppEdge, NodeDefinition, ParseError, TSLDataType } from '@/types';
import { setNodeValues } from '@/types';
import { NODE_REGISTRY, TSL_FUNCTION_TO_DEF, getFlowNodeType, chainPortId, MAX_CHAIN_OPERANDS } from '@/registry/nodeRegistry';
import { generateId } from '@/utils/idGenerator';
import { makeTypedEdge } from '@/utils/edgeUtils';
import complexityData from '@/registry/complexity.json';
import { VALID_SWIZZLE } from './graphToCode';

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

export function codeToGraph(code: string): CodeToGraphResult {
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
  // Vars declared from a swizzle (`const f1 = worley.x`) point at a split node,
  // whose value lives on a component handle rather than `out`. Consulted by
  // every identifier-wiring site via `varToHandle.get(name) ?? 'out'`.
  const varToHandle = new Map<string, string>();
  const rawNodes: AppNode[] = [];
  const rawEdges: AppEdge[] = [];
  const warnings: ParseError[] = [];
  // Track split nodes created for member expression patterns (sourceVarName → splitNodeId)
  const splitNodes = new Map<string, string>();

  let hasOutput = false;
  // Discard is a side-effect statement (`Discard(cond);`) that appears in the
  // function body, but its value flows into the Output node's `discard` port —
  // which doesn't exist until the return statement creates the output. Buffer
  // the argument here, then wire it after the output node is built (either by
  // ReturnStatement / `output =` or by the no-output fallback below).
  let pendingDiscardArg: t.Node | undefined;

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
            addEdge(rawEdges, sourceId, varToHandle.get(prop.value.name) ?? 'out', outputId, channel);
          }
        } else if (t.isMemberExpression(prop.value)) {
          const ref = resolveMemberExpr(prop.value, rawNodes, rawEdges, varToNodeId, splitNodes);
          if (ref) {
            addEdge(rawEdges, ref.nodeId, ref.handle, outputId, channel, 'float');
          }
        } else if (t.isCallExpression(prop.value)) {
          const tempVar = `_return_${channel}`;
          processCall(prop.value, tempVar, rawNodes, rawEdges, varToNodeId, varToHandle, splitNodes, code, warnings);
          const sourceId = varToNodeId.get(tempVar);
          if (sourceId) {
            addEdge(rawEdges, sourceId, 'out', outputId, channel);
          }
        }
      }
      return;
    }

    // Single-value: wire to output.color
    const returnRef = resolveReturnSource(arg, rawNodes, rawEdges, varToNodeId, varToHandle, splitNodes, code, warnings);
    if (returnRef) {
      addEdge(rawEdges, returnRef.nodeId, returnRef.handle, outputId, 'color');
    }
  };

  try {
    traverse(ast, {
      VariableDeclarator(path) {
        if (!t.isIdentifier(path.node.id)) return;
        const varName = path.node.id.name;
        const init = path.node.init;
        if (!init) return;

        // Skip module-local color helpers (`const hsl = Fn(...)`, `const toHsl = Fn(...)`)
        // that graphToCode emits when the graph contains an hsl/toHsl node.
        // Their bodies contain raw TSL primitives (mul/sub/clamp/…) which would
        // otherwise be parsed as standalone nodes, polluting the graph on every
        // code→graph round-trip.
        if (
          (varName === 'hsl' || varName === 'toHsl') &&
          t.isCallExpression(init) &&
          t.isIdentifier(init.callee) &&
          init.callee.name === 'Fn'
        ) {
          path.skip();
          return;
        }

        // const x = identifier (e.g. positionGeometry, or aliasing another var)
        if (t.isIdentifier(init)) {
          const def = TSL_FUNCTION_TO_DEF.get(init.name);
          if (def) {
            const nodeId = generateId();
            rawNodes.push(createNode(nodeId, def, varName));
            varToNodeId.set(varName, nodeId);
          } else if (varToNodeId.has(init.name)) {
            // `const colorNode = baseColor;` — alias to an existing node so
            // later references (return, Discard, …) resolve through this name.
            varToNodeId.set(varName, varToNodeId.get(init.name)!);
            const handle = varToHandle.get(init.name);
            if (handle) varToHandle.set(varName, handle);
          }
          return;
        }

        // const f1 = worley.x — a swizzle read off a known variable. Wire it
        // through the shared split node so later references (sub(f2, f1),
        // returns, …) resolve to that component instead of being dropped.
        if (t.isMemberExpression(init)) {
          const ref = resolveMemberExpr(init, rawNodes, rawEdges, varToNodeId, splitNodes);
          if (ref) {
            varToNodeId.set(varName, ref.nodeId);
            varToHandle.set(varName, ref.handle);
          } else {
            const exprText = init.start != null && init.end != null
              ? code.slice(init.start, init.end)
              : 'member expression';
            warnings.push({
              message: `Cannot represent "${exprText}" — "${varName}" is left unwired.`,
              line: init.loc?.start.line,
              severity: 'warning',
            });
          }
          return;
        }

        // const x = func(args...) or const x = obj.method(args...)
        if (t.isCallExpression(init)) {
          processCall(init, varName, rawNodes, rawEdges, varToNodeId, varToHandle, splitNodes, code, warnings);
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

      // Capture bare `Discard(cond);` statements. The arg is buffered and wired
      // to the Output node's `discard` port after traversal, since the output
      // node may not exist yet at the moment the Discard call is visited.
      ExpressionStatement(path) {
        const expr = path.node.expression;
        if (!t.isCallExpression(expr)) return;
        if (!t.isIdentifier(expr.callee) || expr.callee.name !== 'Discard') return;
        if (expr.arguments.length === 0) return;
        pendingDiscardArg = expr.arguments[0];
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

  // Wire any deferred Discard(cond) into the output node's discard port.
  if (pendingDiscardArg) {
    const outputNode = rawNodes.find((n) => n.data.registryType === 'output');
    if (outputNode) {
      const ref = resolveReturnSource(
        pendingDiscardArg, rawNodes, rawEdges, varToNodeId, varToHandle, splitNodes, code, warnings,
      );
      if (ref) {
        addEdge(rawEdges, ref.nodeId, ref.handle, outputNode.id, 'discard', 'float');
      }
    }
  }

  return { nodes: rawNodes, edges: rawEdges, errors: warnings };
}

/** Push a typed animated edge, deriving its ID from the endpoints. */
function addEdge(
  edges: AppEdge[],
  source: string,
  sourceHandle: string,
  target: string,
  targetHandle: string,
  dataType: TSLDataType = 'any',
): void {
  edges.push(makeTypedEdge(source, sourceHandle, target, targetHandle, dataType));
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
  varToHandle: Map<string, string>,
  splitNodesMap: Map<string, string>,
  code: string,
  errors: ParseError[],
): { nodeId: string; handle: string } | undefined {
  // return someVar;  (or `output = someVar` for three.js editor compatible form)
  if (t.isIdentifier(arg)) {
    const id = varToNodeId.get(arg.name) ?? ensureBareInputNode(arg.name, nodes, varToNodeId);
    if (id) return { nodeId: id, handle: varToHandle.get(arg.name) ?? 'out' };
  }
  // return someVar.x; — member expression through split node
  if (t.isMemberExpression(arg)) {
    const ref = resolveMemberExpr(arg, nodes, edges, varToNodeId, splitNodesMap);
    if (ref) return ref;
  }
  // return someFunc(a, b); — process as an inline call and return its node ID
  if (t.isCallExpression(arg)) {
    const tempVar = '_return';
    processCall(arg, tempVar, nodes, edges, varToNodeId, varToHandle, splitNodesMap, code, errors);
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
  varToHandle: Map<string, string>,
  splitNodesMap: Map<string, string> = new Map(),
  code: string = '',
  errors: ParseError[] = [],
): void {
  let funcName: string | undefined;
  let objectVarName: string | undefined;
  let objectMember: t.MemberExpression | undefined;

  if (t.isIdentifier(callExpr.callee)) {
    // Direct call: noise(pos)
    funcName = callExpr.callee.name;
  } else if (
    t.isMemberExpression(callExpr.callee) &&
    t.isIdentifier(callExpr.callee.property)
  ) {
    // Chained call: pos.mul(2)
    funcName = callExpr.callee.property.name;

    // Pass-through TSL methods that don't change graph semantics. `.toVar()`
    // and `.toConst()` only mark a node for evaluation in the GPU pipeline; for
    // graph purposes they alias the receiver. Common in three.js TSL editor
    // snippets like `const blink = sin(t).toVar();`. This MUST run before the
    // nested-chain recursion below — otherwise `sin(time).toVar()` processes
    // the inner call twice (once as the chain receiver, once here) and leaves
    // a duplicate, orphaned node in the graph.
    if ((funcName === 'toVar' || funcName === 'toConst') && callExpr.arguments.length === 0) {
      const inner = callExpr.callee.object;
      if (t.isIdentifier(inner)) {
        const sourceId =
          varToNodeId.get(inner.name) ?? ensureBareInputNode(inner.name, nodes, varToNodeId);
        if (sourceId) {
          varToNodeId.set(varName, sourceId);
          const handle = varToHandle.get(inner.name);
          if (handle) varToHandle.set(varName, handle);
        }
        return;
      }
      if (t.isCallExpression(inner)) {
        // Recurse: let the inner call produce a node under our varName.
        processCall(inner, varName, nodes, edges, varToNodeId, varToHandle, splitNodesMap, code, errors);
        return;
      }
      if (t.isMemberExpression(inner)) {
        // `worley.x.toVar()` — alias to the split-node component.
        const ref = resolveMemberExpr(inner, nodes, edges, varToNodeId, splitNodesMap);
        if (ref) {
          varToNodeId.set(varName, ref.nodeId);
          varToHandle.set(varName, ref.handle);
          return;
        }
      }
      // Unresolvable receiver — fall through to the unknown-node path below.
    }

    if (t.isIdentifier(callExpr.callee.object)) {
      objectVarName = callExpr.callee.object.name;
    } else if (t.isCallExpression(callExpr.callee.object)) {
      // Nested chain like `positionWorld.sub(cameraPosition).length()`. Recurse
      // on the inner call under a synthetic variable, then use that as the
      // chain receiver so the outer call can wire to it normally.
      const innerVar = `__chain${nodes.length}`;
      processCall(
        callExpr.callee.object, innerVar,
        nodes, edges, varToNodeId, varToHandle, splitNodesMap, code, errors,
      );
      if (varToNodeId.has(innerVar)) objectVarName = innerVar;
    } else if (t.isMemberExpression(callExpr.callee.object)) {
      // Swizzle receiver like `pos.x.mul(2)` — resolved through the split
      // node at receiver-wiring time below.
      objectMember = callExpr.callee.object;
    }
  }

  if (!funcName) return;

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
              addEdge(edges, sourceId, varToHandle.get(arg.name) ?? 'out', nodeId, ports[i]);
            }
          } else if (t.isMemberExpression(arg)) {
            const ref = resolveMemberExpr(arg, nodes, edges, varToNodeId, splitNodesMap);
            if (ref) {
              addEdge(edges, ref.nodeId, ref.handle, nodeId, ports[i], 'float');
            }
          }
        }
        return;
      }
    }
  }

  // Skip Fn() wrapper — Babel's traverse already enters its arrow function body,
  // so the inner VariableDeclarator/ReturnStatement visitors process the contents.
  // Creating an unknown node for Fn would pollute the graph and trigger a warning.
  if (funcName === 'Fn') return;

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
    setNodeValues(node, { functionName: funcName, rawExpression: rawExpr });
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
  const node = createNode(nodeId, def, varName);
  nodes.push(node);
  varToNodeId.set(varName, nodeId);

  // Noise nodes: special positional arg mapping
  // graphToCode emits: mx_worley_noise_float(posOrMul)
  // where posOrMul is either `positionGeometry`, a var ref, or `mul(pos, scale)`
  if (def.category === 'noise') {
    processNoiseCall(callExpr, node, def, edges, varToNodeId, varToHandle);
    return;
  }

  // Wire edges from arguments
  let inputIdx = 0;

  // If chained, the object becomes the first input
  if ((objectVarName || objectMember) && def.inputs.length > 0) {
    let src: { nodeId: string; handle: string } | null = null;
    if (objectVarName) {
      const sourceId =
        varToNodeId.get(objectVarName) ?? ensureBareInputNode(objectVarName, nodes, varToNodeId);
      if (sourceId) src = { nodeId: sourceId, handle: varToHandle.get(objectVarName) ?? 'out' };
    } else if (objectMember) {
      src = resolveMemberExpr(objectMember, nodes, edges, varToNodeId, splitNodesMap);
    }
    if (src) {
      addEdge(edges, src.nodeId, src.handle, nodeId, def.inputs[0].id, def.inputs[0].dataType);
    }
    inputIdx = 1;
  }

  // Process remaining arguments — extract literals and wire identifier edges
  const extractedValues: Record<string, string | number> = {};
  const defaultKeys = def.defaultValues ? Object.keys(def.defaultValues) : [];

  // An argument that lands on a real port/default key but has no graph
  // representation would silently keep the port's default — surface that as a
  // sync-permitting warning instead (see ParseError.severity in tsl.types).
  const warnUnsupportedArg = (arg: t.Node): void => {
    const argText = arg.start != null && arg.end != null
      ? code.slice(arg.start, arg.end)
      : 'argument';
    errors.push({
      message: `Cannot represent "${argText}" (argument of ${funcName}) — the port keeps its default value.`,
      line: arg.loc?.start.line ?? callExpr.loc?.start.line,
      severity: 'warning',
    });
  };

  for (let i = 0; i < callExpr.arguments.length; i++) {
    const arg = callExpr.arguments[i];
    // Chainable (variadic arithmetic) calls carry more args than the two static
    // registry ports — synthesize the extra operand ports (c, d, …) so the whole
    // `add(a, b, c, d)` chain wires up instead of stopping at `b`.
    const portIndex = inputIdx + i;
    // graphToCode's effectiveInputs caps chains at MAX_CHAIN_OPERANDS, so any
    // operand past that would be silently dropped on the next graph→code pass —
    // changing the computed value (worse for sub/div). Stop here and warn
    // instead of round-tripping into a different expression.
    if (def.chainable && portIndex >= MAX_CHAIN_OPERANDS) {
      errors.push({
        message: `"${funcName ?? def.type}" has more than ${MAX_CHAIN_OPERANDS} operands; the extras are ignored.`,
        line: callExpr.loc?.start.line,
        severity: 'warning',
      });
      break;
    }
    const port = def.inputs[portIndex]
      ?? (def.chainable
        ? { id: chainPortId(portIndex), label: chainPortId(portIndex).toUpperCase(), dataType: 'any' as const }
        : undefined);

    const literalValue = extractLiteral(arg);

    if (t.isIdentifier(arg)) {
      const sourceId =
        varToNodeId.get(arg.name) ?? ensureBareInputNode(arg.name, nodes, varToNodeId);
      const srcHandle = varToHandle.get(arg.name) ?? 'out';
      if (sourceId && port) {
        // Wire to a defined input port
        addEdge(edges, sourceId, srcHandle, nodeId, port.id, port.dataType);
      } else if (sourceId && def.inputs.length === 0 && defaultKeys[i]) {
        // No defined input ports (noise/UV) — wire edge to the defaultValues key
        addEdge(edges, sourceId, srcHandle, nodeId, defaultKeys[i]);
      } else if (!sourceId && def.inputs.length === 0 && defaultKeys[i]) {
        // Bare identifier (e.g. positionGeometry) — store as string value
        extractedValues[defaultKeys[i]] = arg.name;
      } else if (!port) {
        break;
      }
    } else if (t.isMemberExpression(arg)) {
      // Member expression: someVar.x (or a bare global like positionGeometry.y)
      // → resolve through split node
      const ref = resolveMemberExpr(arg, nodes, edges, varToNodeId, splitNodesMap);
      if (ref && port) {
        addEdge(edges, ref.nodeId, ref.handle, nodeId, port.id, 'float');
      } else if (ref && def.inputs.length === 0 && defaultKeys[i]) {
        addEdge(edges, ref.nodeId, ref.handle, nodeId, defaultKeys[i], 'float');
      } else if (!ref && (port || (def.inputs.length === 0 && defaultKeys[i]))) {
        // Not a resolvable swizzle (Math.PI, multi-char swizzle, unknown var).
        warnUnsupportedArg(arg);
      }
    } else if (t.isCallExpression(arg)) {
      // Inline call argument like `add(x, foo.bar(y))`. Process under a
      // synthetic variable, then wire that node's output into our input port.
      const innerVar = `__arg${nodes.length}_${i}`;
      processCall(arg, innerVar, nodes, edges, varToNodeId, varToHandle, splitNodesMap, code, errors);
      const sourceId = varToNodeId.get(innerVar);
      if (sourceId && port) {
        addEdge(edges, sourceId, 'out', nodeId, port.id, port.dataType);
      } else if (sourceId && def.inputs.length === 0 && defaultKeys[i]) {
        addEdge(edges, sourceId, 'out', nodeId, defaultKeys[i]);
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
    } else if (port || (def.inputs.length === 0 && defaultKeys[i])) {
      // Non-constant computed expression (unfoldable binary, template, …).
      warnUnsupportedArg(arg);
    }
  }

  // Merge extracted values into the node
  if (Object.keys(extractedValues).length > 0) {
    setNodeValues(node, extractedValues);
  }

  // For property_float nodes, set the property name from the variable name in code
  if (def.type === 'property_float') {
    setNodeValues(node, { name: varName });
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
  // createNode already seeded values with uvDef.defaultValues; merge on top.
  setNodeValues(node, {
    channel: Number(channel),
    tilingU: Number(tilingU),
    tilingV: Number(tilingV),
  });
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
  node: AppNode,
  def: NodeDefinition,
  edges: AppEdge[],
  varToNodeId: Map<string, string>,
  varToHandle: Map<string, string>
): void {
  const nodeId = node.id;
  const extractedValues: Record<string, string | number> = {};
  const args = callExpr.arguments;

  // Process a (pos, scale) pair extracted from either `mul(pos, scale)` or
  // `pos.mul(scale)`. graphToCode emits the chained form; the three.js TSL
  // editor produces the direct-call form. Both need to round-trip.
  const wirePosAndScale = (posInner: t.Node, scaleInner: t.Node): void => {
    if (t.isIdentifier(posInner)) {
      const sourceId = varToNodeId.get(posInner.name);
      if (sourceId) {
        addEdge(edges, sourceId, varToHandle.get(posInner.name) ?? 'out', nodeId, 'pos');
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
        addEdge(edges, sourceId, varToHandle.get(scaleInner.name) ?? 'out', nodeId, 'scale');
      }
    }
  };

  // --- arg[0]: position (possibly wrapped in mul(pos, scale) or pos.mul(scale)) ---
  if (args.length > 0) {
    const posArg = args[0];
    if (
      t.isCallExpression(posArg) &&
      t.isIdentifier(posArg.callee) &&
      posArg.callee.name === 'mul' &&
      posArg.arguments.length === 2
    ) {
      // mul(pos, scale) — direct-call form
      wirePosAndScale(posArg.arguments[0], posArg.arguments[1]);
    } else if (
      t.isCallExpression(posArg) &&
      t.isMemberExpression(posArg.callee) &&
      t.isIdentifier(posArg.callee.property) &&
      posArg.callee.property.name === 'mul' &&
      posArg.arguments.length === 1
    ) {
      // pos.mul(scale) — chained form (what graphToCode emits)
      wirePosAndScale(posArg.callee.object, posArg.arguments[0]);
    } else if (t.isIdentifier(posArg)) {
      const sourceId = varToNodeId.get(posArg.name);
      if (sourceId) {
        addEdge(edges, sourceId, varToHandle.get(posArg.name) ?? 'out', nodeId, 'pos');
      } else {
        extractedValues.pos = posArg.name;
      }
    }
  }

  // Merge extracted values
  if (Object.keys(extractedValues).length > 0) {
    setNodeValues(node, extractedValues);
  }
}

/** Color-channel swizzle aliases map onto the split node's xyzw handles. */
const SWIZZLE_ALIAS: Record<string, string> = { r: 'x', g: 'y', b: 'z', a: 'w' };

/**
 * Resolve a member expression like `someVar.x` to a split node output.
 * Creates the split node on first use for each source variable. The object may
 * also be a bare TSL input global (`positionGeometry.y`) — it gets an input
 * node on demand, same as bare identifier references.
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
  const component = SWIZZLE_ALIAS[expr.property.name] ?? expr.property.name;
  if (!VALID_SWIZZLE.has(component)) return null;

  const sourceId = varToNodeId.get(varName) ?? ensureBareInputNode(varName, nodes, varToNodeId);
  if (!sourceId) return null;

  // Reuse existing split node for this source variable
  let splitId = splitNodesMap.get(varName);
  if (!splitId) {
    const splitDef = NODE_REGISTRY.get('split');
    if (!splitDef) return null;
    splitId = generateId();
    nodes.push(createNode(splitId, splitDef, `split_${varName}`));
    // Wire source → split.v
    addEdge(edges, sourceId, 'out', splitId, 'v');
    splitNodesMap.set(varName, splitId);
  }

  return { nodeId: splitId, handle: component };
}

function extractLiteral(node: t.Node): string | number | undefined {
  if (t.isStringLiteral(node)) return node.value;
  // Numbers, negative numbers, and computed numeric constants (1 / 6, 2 * 0.5)
  return foldNumericConstant(node);
}

/**
 * Evaluate a compile-time numeric constant: numeric literals, unary +/-, and
 * BinaryExpressions whose operands are themselves numeric constants (`1 / 6`,
 * `2 ** -3`). Returns undefined for anything non-constant or non-finite so the
 * caller can degrade with a warning instead of silently dropping the argument.
 */
function foldNumericConstant(node: t.Node): number | undefined {
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isUnaryExpression(node) && (node.operator === '-' || node.operator === '+')) {
    const v = foldNumericConstant(node.argument);
    if (v === undefined) return undefined;
    return node.operator === '-' ? -v : v;
  }
  if (t.isBinaryExpression(node) && !t.isPrivateName(node.left)) {
    const l = foldNumericConstant(node.left);
    const r = foldNumericConstant(node.right);
    if (l === undefined || r === undefined) return undefined;
    let v: number;
    switch (node.operator) {
      case '+': v = l + r; break;
      case '-': v = l - r; break;
      case '*': v = l * r; break;
      case '/': v = l / r; break;
      case '%': v = l % r; break;
      case '**': v = l ** r; break;
      default: return undefined;
    }
    return Number.isFinite(v) ? v : undefined;
  }
  return undefined;
}

function createNode(id: string, def: NodeDefinition, label: string): AppNode {
  const costs = complexityData.costs as Record<string, number>;
  const cost = costs[def.type] ?? 0;

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
