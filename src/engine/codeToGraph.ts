import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import type { AppNode, AppEdge, NodeDefinition, ParseError, TSLDataType, OutputMaterial } from '@/types';
import { setNodeValues } from '@/types';
import { isUsableMeshName } from '@/utils/meshInventory';
import { MAX_PARTS, findDefaultOutput, outputNodes, channelHandle } from '@/utils/outputMaterials';
import { NODE_REGISTRY, TSL_FUNCTION_TO_DEF, getFlowNodeType, chainPortId, growsOperands, MAX_CHAIN_OPERANDS } from '@/registry/nodeRegistry';
import { MODULE_HELPER_NAMES } from './moduleHelpers';
import { SDF_OUTPUT_TYPE } from '@/utils/sdfPartition';
import { generateId } from '@/utils/idGenerator';
import { hasNoiseRangeFlag } from '@/utils/noiseRange';
import { makeTypedEdge } from '@/utils/edgeUtils';
import complexityData from '@/registry/complexity.json';
import { VALID_SWIZZLE, TOHSL_COMPONENT_TO_HANDLE } from './graphToCode';
import { OUTPUT_DEFAULT_EXPOSED } from '@/utils/exposedPorts';

/** Output channels whose widget stores a NUMBER / a HEX color — the parse
 *  twin of graphToCode's stored-value emission (keep the two in sync). */
const OUTPUT_FLOAT_VALUE_CHANNELS = new Set(['roughness', 'metalness', 'opacity', 'position', 'discard']);
const OUTPUT_COLOR_VALUE_CHANNELS = new Set(['color', 'emissive', 'normal', 'env']);

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
  // ===== SDF Output (the raymarcher) =====
  // graphToCode emits it as `const sdfOut1Field = Fn(([p]) => {…})` (+ an
  // optional `sdfOut1Color`), the march IIFE `sdfOut1`, `sdfOut1Hit`, the normal
  // `sdfOut1N`, a `Discard(sdfOut1.w.lessThan(0.5))` and `return { color?, normal }`.
  // The two per-step functions are graph content: their bodies are walked by
  // the ordinary visitors with `p` bound to a Local Position node and their
  // `return` routed to the SDF Output's socket. The IIFE, the hit swizzle and
  // the normal function are the node ITSELF and are skipped whole (which is
  // also what keeps their Loop/If from raising the imperative-block warning).
  let sdfOutputId: string | null = null;
  let marchPosId: string | null = null;
  const helperReturnTargets = new Map<t.Node, { nodeId: string; handle: string }>();
  const ensureSdfOutput = (): string => {
    if (sdfOutputId) return sdfOutputId;
    const def = NODE_REGISTRY.get(SDF_OUTPUT_TYPE)!;
    sdfOutputId = generateId();
    rawNodes.push(createNode(sdfOutputId, def, 'SDF Output'));
    hasOutput = true;
    return sdfOutputId;
  };
  const ensureMarchPos = (): string => {
    if (marchPosId) return marchPosId;
    const def = NODE_REGISTRY.get('positionLocal')!;
    marchPosId = generateId();
    rawNodes.push(createNode(marchPosId, def, 'positionLocal'));
    return marchPosId;
  };
  // Discard is a side-effect statement (`Discard(cond);`) that appears in the
  // function body, but its value flows into the Output node's `discard` port —
  // which doesn't exist until the return statement creates the output. Buffer
  // the argument here, then wire it after the output node is built (either by
  // ReturnStatement / `output =` or by the no-output fallback below).
  let pendingDiscardArg: t.Node | undefined;

  /**
   * Undo the scalar→vec3 widening graphToCode applies to a vec3-typed output
   * channel (`return vec3(noise1)`), so the round trip lands back on the plain
   * Noise→Color edge instead of growing a Vec3 node whose y/z default to 0 —
   * which would re-emit `vec3(noise1, 0, 0)` and turn a grey ramp red.
   *
   * Unambiguous: graphToCode emits a real Vec3 NODE with all three arguments
   * (`vec3(a, 0, 0)`), never one, so a single-argument vec3 in a channel
   * position is always the coercion. Restricted to an identifier/member
   * argument — the exact shape codegen produces — so a hand-written literal
   * splat like `vec3(0.5)` keeps whatever it did before.
   */
  const unwrapScalarWiden = (arg: t.Node): t.Node => {
    if (
      t.isCallExpression(arg) &&
      t.isIdentifier(arg.callee) &&
      arg.callee.name === 'vec3' &&
      arg.arguments.length === 1 &&
      (t.isIdentifier(arg.arguments[0]) || t.isMemberExpression(arg.arguments[0]))
    ) {
      return arg.arguments[0];
    }
    return arg;
  };

  /**
   * Collapse an INLINE literal wrapper in an output-channel position back into
   * the Output node's STORED channel value — the reverse of graphToCode's
   * widget-value emission. Without this, every code-panel Apply would
   * materialize a Float/Color node for a value the user set on the Output
   * node's own widget, and the widget would read as broken.
   *
   * Deliberately narrow (the noise-remap-collapse philosophy): exactly the
   * shapes codegen emits — `float(<numeric constant>)` on the three float
   * channels, `color(<numeric literal>)` on the two color channels, inline in
   * the channel position. An IDENTIFIER (`opacity: float1`) stays a real node
   * + edge, so every existing graph parses unchanged.
   */
  const matchStoredChannelValue = (channel: string, expr: t.Node): string | number | null => {
    if (!t.isCallExpression(expr) || !t.isIdentifier(expr.callee) || expr.arguments.length !== 1) {
      return null;
    }
    const arg = expr.arguments[0];
    if (expr.callee.name === 'float' && OUTPUT_FLOAT_VALUE_CHANNELS.has(channel)) {
      const n = foldNumericConstant(arg as t.Node);
      return n === undefined ? null : n;
    }
    if (
      expr.callee.name === 'color' &&
      OUTPUT_COLOR_VALUE_CHANNELS.has(channel) &&
      t.isNumericLiteral(arg)
    ) {
      return toHex6(arg.value);
    }
    // The normal widget's emitted form: `normalMap(color(0x…))` — a decoded
    // constant normal-map texel. Narrow: the inner call must be a literal
    // color(); `normalMap(<identifier>)` (the image→normal wrap) keeps its
    // historical parse.
    if (
      expr.callee.name === 'normalMap' &&
      channel === 'normal' &&
      t.isCallExpression(arg) &&
      t.isIdentifier(arg.callee) &&
      arg.callee.name === 'color' &&
      arg.arguments.length === 1 &&
      t.isNumericLiteral(arg.arguments[0])
    ) {
      return toHex6(arg.arguments[0].value);
    }
    return null;
  };

  /** Attach collected stored channel values to the just-created output node,
   *  and expose those channels: graphToCode's emission is exposure-gated and
   *  the on-node widget is the only honest signal the value exists, so a
   *  valued channel must be visible. (Wired channels are exposed separately
   *  by autoExposeConnectedParamPorts.) */
  const applyStoredOutputValues = (
    outputId: string,
    values: Record<string, string | number>,
    material?: OutputMaterial,
  ): void => {
    const keys = Object.keys(values);
    if (keys.length === 0) return;
    // A MATERIAL owns its own values and exposed set; only material 0 writes
    // the node's fields (where they have always lived).
    const sink = material
      ?? (rawNodes.find((n) => n.id === outputId)?.data as Record<string, unknown> | undefined);
    if (!sink) return;
    (sink as Record<string, unknown>).values = values;
    (sink as Record<string, unknown>).exposedPorts = Array.from(
      new Set([...OUTPUT_DEFAULT_EXPOSED, ...keys]),
    );
  };

  /**
   * Read an object-property key as a string. Channels arrive as IDENTIFIERS
   * (`color:`), mesh names inside `parts` as STRING LITERALS (`"Glass":`) —
   * a mesh name is not necessarily a valid identifier, and quoting it is what
   * lets a name contain spaces or punctuation at all.
   */
  const propKeyName = (prop: t.ObjectProperty): string | null => {
    if (t.isIdentifier(prop.key)) return prop.key.name;
    if (t.isStringLiteral(prop.key)) return prop.key.value;
    return null;
  };

  /**
   * Wire one output node's channels from an object expression. Shared by the
   * default output and every `parts` entry, so a per-mesh material parses
   * exactly as well as the top-level one — including stored widget values.
   *
   * `tempPrefix` namespaces the synthetic variable a call-expression channel
   * needs. It MUST differ per output: two materials both wiring `color: mix(…)`
   * would otherwise both claim `_return_color`, and the second would silently
   * steal the first's node.
   */
  const wireOutputChannels = (
    outputId: string,
    obj: t.ObjectExpression,
    tempPrefix: string,
    materialIndex = 0,
    material?: OutputMaterial,
  ): void => {
    const storedValues: Record<string, string | number> = {};
  for (const rawProp of obj.properties) {
    if (!t.isObjectProperty(rawProp)) continue;
    const channel = propKeyName(rawProp);
    // `parts` is the per-mesh map, handled by buildPartOutputs — never a
    // channel of the output it appears on.
    if (channel === null || channel === 'parts') continue;
      // Same widening undo as the single-value form above — a multi-channel
      // return carries `{ color: vec3(noise1), opacity: … }`.
      const prop = { ...rawProp, value: unwrapScalarWiden(rawProp.value) } as t.ObjectProperty;
      // Stored widget values first: an inline `float(0.35)` / `color(0x…)`
      // in channel position is the Output node's own value, not a node.
      const stored = matchStoredChannelValue(channel, prop.value);
      if (stored !== null) {
        storedValues[channel] = stored;
        continue;
      }
      if (t.isIdentifier(prop.value)) {
        const sourceId = varToNodeId.get(prop.value.name)
          ?? ensureBareInputNode(prop.value.name, rawNodes, varToNodeId);
        if (sourceId) {
          addEdge(rawEdges, sourceId, varToHandle.get(prop.value.name) ?? 'out', outputId, channelHandle(materialIndex, channel));
        }
      } else if (t.isMemberExpression(prop.value)) {
        const ref = resolveMemberExpr(prop.value, rawNodes, rawEdges, varToNodeId, splitNodes);
        if (ref) {
          addEdge(rawEdges, ref.nodeId, ref.handle, outputId, channelHandle(materialIndex, channel), 'float');
        }
      } else if (t.isCallExpression(prop.value)) {
        // The synthetic name must not be one the MODULE already defines:
        // `processCall` writes it into `varToNodeId`, so a user variable
        // spelled `_return_color` / `_part0_color` would have its mapping
        // overwritten, and every reference resolved after the return — a
        // deferred `Discard(_part0_color)`, a later part naming it — would
        // silently point at this channel's node instead. Declarations are
        // visited before the return, so asking the map is enough.
        let tempVar = `${tempPrefix}${channel}`;
        for (let n = 2; varToNodeId.has(tempVar); n += 1) tempVar = `${tempPrefix}${channel}_${n}`;
        processCall(prop.value, tempVar, rawNodes, rawEdges, varToNodeId, varToHandle, splitNodes, code, warnings);
        const sourceId = varToNodeId.get(tempVar);
        if (sourceId) {
          addEdge(rawEdges, sourceId, 'out', outputId, channelHandle(materialIndex, channel));
        }
      }
    }
    applyStoredOutputValues(outputId, storedValues, material);
  };

  /**
   * Mint one Output node per `parts` entry, each bound to its mesh.
   *
   * Names are validated exactly as the emitter validates them: this parses
   * files other people wrote, and an unusable name is one the loader could
   * never match anyway, so dropping the entry loses nothing real.
   */
  const buildPartMaterials = (outputId: string, arg: t.ObjectExpression): void => {
    const partsProp = arg.properties.find(
      (p): p is t.ObjectProperty => t.isObjectProperty(p) && propKeyName(p) === 'parts',
    );
    if (!partsProp || !t.isObjectExpression(partsProp.value)) return;

    // LAST occurrence wins, because that is what the RUNTIME does: `parts` is a
    // JS object literal, so a repeated key overwrites, and loader 0.6 iterates
    // the evaluated object. Keeping the first would make an Apply silently swap
    // which material a mesh wears — the code says one thing before Apply and
    // the graph renders the other after it, with no error either side.
    const lastByName = new Map<string, t.ObjectProperty>();
    for (const rawPart of partsProp.value.properties) {
      if (!t.isObjectProperty(rawPart)) continue;
      const name = propKeyName(rawPart);
      if (name === null) continue;
      if (!isUsableMeshName(name)) {
        // Not tidiness: the graph→code sync writes the parse's result straight
        // back over the user's source, so an entry dropped in silence deletes
        // itself from the file the user is looking at. Same reason the
        // unconditional-Discard and extra-argument cases warn.
        warnings.push({
          message: `Part "${String(name).slice(0, 64)}" has an unusable mesh name — it was dropped.`,
          line: rawPart.loc?.start.line,
          severity: 'warning',
        });
        continue;
      }
      if (!t.isObjectExpression(rawPart.value)) {
        warnings.push({
          message: `Part "${name}" is not a channel object — it was dropped.`,
          line: rawPart.loc?.start.line,
          severity: 'warning',
        });
        continue;
      }
      lastByName.set(name, rawPart);
    }

    // Each DISTINCT part body becomes a MATERIAL on the one Output node, wired
    // through that material's namespaced handles (`m1:color`). The node's own
    // fields stay material 0 — the default — so a module whose `parts` are all
    // dropped parses to exactly the Output it would have without them.
    //
    // Parts whose bodies are BYTE-IDENTICAL merge into ONE material naming
    // several meshes, because that is what emission does in reverse: a material
    // shading three meshes writes three entries carrying the same expressions.
    // Without the merge the feature would not survive its own round trip — a
    // three-mesh material would split into three on the first code-panel Apply.
    // EMPTY bodies are deliberately NOT merged: they carry nothing to match on,
    // and two freshly-added mesh materials (the state right before you wire
    // them differently) are exactly the pair that would be collapsed.
    const materials: OutputMaterial[] = [];
    /** part-body source -> the material it already produced. */
    const byBody = new Map<string, OutputMaterial>();
    for (const [name, rawPart] of lastByName) {
      const value = rawPart.value as t.ObjectExpression;
      const body = value.properties.length > 0 && value.start != null && value.end != null
        ? code.slice(value.start, value.end)
        : null;
      const merged = body === null ? undefined : byBody.get(body);
      if (merged) {
        (merged.meshTargets as string[]).push(name);
        continue;
      }
      if (materials.length >= MAX_PARTS) {
        warnings.push({
          message:
            `More than ${MAX_PARTS} targeted meshes — "${name}" and any after it were dropped.`,
          line: rawPart.loc?.start.line,
          severity: 'warning',
        });
        break;
      }
      const index = materials.length + 1;
      const material: OutputMaterial = { meshTargets: [name] };
      materials.push(material);
      if (body !== null) byBody.set(body, material);
      wireOutputChannels(outputId, value, `_part${index}_`, index, material);
    }
    if (materials.length === 0) return;
    const outputNode = rawNodes.find((n) => n.id === outputId);
    if (outputNode) {
      (outputNode.data as Record<string, unknown>).materials = materials;
    }
  };

  // Build the OutputNode and wire its channels from a return/output expression.
  // Shared between `return X` (FastShaders canonical form) and `output = X`
  // (three.js TSL editor compatible form).
  const buildOutputFromExpr = (rawArg: t.Node): void => {
    // An SDF Output's return carries `normal: sdfOut1N` (the node itself) and an
    // optional `color` — a captured ref, or the `sdfOut1Color(sdfOut1Hit)` call
    // whose chain was already wired by the helper's own return.
    if (sdfOutputId) {
      if (!t.isObjectExpression(rawArg)) return;
      for (const rawProp of rawArg.properties) {
        if (!t.isObjectProperty(rawProp)) continue;
        if (propKeyName(rawProp) !== 'color') continue;
        const v = unwrapScalarWiden(rawProp.value);
        if (t.isCallExpression(v) && /^sdfOut\d+Color$/.test(rootIdentifierOf(v) ?? '')) continue;
        const storedHex = matchStoredChannelValue('color', v);
        if (typeof storedHex === 'string') {
          const sdfNode = rawNodes.find((n) => n.id === sdfOutputId)!;
          setNodeValues(sdfNode, { color: storedHex });
          continue;
        }
        const ref = resolveReturnSource(v, rawNodes, rawEdges, varToNodeId, varToHandle, splitNodes, code, warnings);
        if (ref) addEdge(rawEdges, ref.nodeId, ref.handle, sdfOutputId, 'color');
      }
      return;
    }
    if (hasOutput) return;
    const arg = unwrapScalarWiden(rawArg);

    const outputDef = NODE_REGISTRY.get('output');
    if (!outputDef) return;

    // Multi-channel: { color: x, position: y, ... } — and/or `parts`.
    //
    // ONE Output node either way. A parts-only return leaves material 0 with
    // nothing wired, which is exactly what it means — the module shades the
    // meshes it names and leaves the rest on their authored materials — and it
    // re-emits parts-only, because an empty default emits no channels.
    if (t.isObjectExpression(arg)) {
      hasOutput = true;
      const outputId = generateId();
      rawNodes.push(createNode(outputId, outputDef, 'Output'));
      wireOutputChannels(outputId, arg, '_return_');
      buildPartMaterials(outputId, arg);
      return;
    }

    const outputId = generateId();
    rawNodes.push(createNode(outputId, outputDef, 'Output'));
    hasOutput = true;
    // Single-value: an inline `color(0x…)` is the color widget's stored value
    // (graphToCode's color-only bare-return form); anything else wires to
    // output.color as before.
    const storedColor = matchStoredChannelValue('color', arg);
    if (storedColor !== null) {
      applyStoredOutputValues(outputId, { color: storedColor });
      return;
    }
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

        // Skip the module-local helpers graphToCode emits above the shader
        // (`const hsl = Fn(...)`, the distance-field family — see
        // engine/moduleHelpers.ts, the ONE table both engines read). Their
        // bodies contain raw TSL primitives (mul/sub/clamp/…) which would
        // otherwise be parsed as standalone nodes, polluting the graph on every
        // code→graph round-trip.
        if (
          MODULE_HELPER_NAMES.has(varName) &&
          t.isCallExpression(init) &&
          t.isIdentifier(init.callee) &&
          init.callee.name === 'Fn'
        ) {
          path.skip();
          return;
        }

        // SDF Output emission (see the state block above).
        const sdfHelper = /^sdfOut\d+(Field|Color)$/.exec(varName);
        if (sdfHelper && t.isCallExpression(init) && t.isIdentifier(init.callee) && init.callee.name === 'Fn') {
          const arrow = init.arguments[0];
          if (arrow && (t.isArrowFunctionExpression(arrow) || t.isFunctionExpression(arrow))) {
            const target = ensureSdfOutput();
            helperReturnTargets.set(arrow, { nodeId: target, handle: sdfHelper[1] === 'Field' ? 'field' : 'color' });
          }
          return; // walk INTO the body — it is graph content
        }
        // The march IIFE: `const sdfOut1 = Fn(() => {…})();` — name AND shape,
        // so a user property that happens to be called `sdfOut1` (a plain
        // `uniform(…)` init) can never be mistaken for it.
        if (
          /^sdfOut\d+$/.test(varName) &&
          t.isCallExpression(init) && t.isCallExpression(init.callee) &&
          t.isIdentifier(init.callee.callee) && init.callee.callee.name === 'Fn'
        ) {
          const target = ensureSdfOutput();
          const sdfNode = rawNodes.find((n) => n.id === target)!;
          const values: Record<string, string | number> = {};
          const wireParam = (handle: string, arg: t.Node | undefined): void => {
            if (!arg) return;
            const lit = extractLiteral(arg);
            if (typeof lit === 'number') { values[handle] = lit; return; }
            if (t.isIdentifier(arg)) {
              const src = varToNodeId.get(arg.name) ?? ensureBareInputNode(arg.name, rawNodes, varToNodeId);
              if (src) addEdge(rawEdges, src, varToHandle.get(arg.name) ?? 'out', target, handle, 'float');
            }
          };
          path.get('init').traverse({
            CallExpression(inner) {
              const c = inner.node;
              if (t.isIdentifier(c.callee) && c.callee.name === 'Loop') {
                const a0 = c.arguments[0];
                // `Loop(int(<steps>), …)`
                wireParam('steps', t.isCallExpression(a0) && t.isIdentifier(a0.callee) && a0.callee.name === 'int' ? a0.arguments[0] : a0);
              } else if (t.isMemberExpression(c.callee) && t.isIdentifier(c.callee.property)) {
                if (c.callee.property.name === 'lessThan' && t.isIdentifier(c.callee.object) && c.callee.object.name === 'd') wireParam('epsilon', c.arguments[0]);
                if (c.callee.property.name === 'greaterThan' && t.isIdentifier(c.callee.object) && c.callee.object.name === 't') wireParam('maxDist', c.arguments[0]);
              }
            },
          });
          if (Object.keys(values).length) setNodeValues(sdfNode, values);
          path.skip();
          return;
        }
        if (sdfOutputId && /^sdfOut\d+(Hit|N)$/.test(varName) && (t.isMemberExpression(init) || t.isCallExpression(init))) {
          path.skip();
          return;
        }

        // const x = identifier (e.g. positionGeometry, or aliasing another var)
        if (t.isIdentifier(init)) {
          // `const positionLocal1 = p;` inside an SDF Output per-step function:
          // the march root. The flat body declared the same name from the real
          // `positionLocal` just above (roots are always emitted there too), so
          // the existing node IS the root — rebinding would mint a duplicate.
          if (init.name === 'p' && helperReturnTargets.size > 0) {
            if (!varToNodeId.has(varName)) varToNodeId.set(varName, ensureMarchPos());
            return;
          }
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
        // A return inside one of the SDF Output's per-step functions feeds the
        // node's socket, not the shader's output.
        const fnNode = path.getFunctionParent()?.node;
        const target = fnNode ? helperReturnTargets.get(fnNode) : undefined;
        if (target) {
          const ref = resolveReturnSource(unwrapScalarWiden(arg), rawNodes, rawEdges, varToNodeId, varToHandle, splitNodes, code, warnings);
          if (ref) addEdge(rawEdges, ref.nodeId, ref.handle, target.nodeId, target.handle);
          return;
        }
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
        // Imperative TSL — `Loop(n, () => {…})`, `If(c, () => {…}).Else(…)`,
        // `Switch(…)` — has no graph equivalent, and this visitor used to say
        // NOTHING about it: the statement produced no node, Babel then walked
        // INTO the callback and parsed its `const`s as top-level nodes (a
        // 96-step raymarch became ~60 flat nodes), and every accumulator
        // aliased to its initial value, so the re-emitted shader was a
        // constant. Skip the whole block, and say so. A body statement like
        // `acc.assign(x)` / `.addAssign` is the same silence one level down.
        const root = rootCallee(expr);
        if (root && IMPERATIVE_BLOCKS.has(root)) {
          warnings.push({
            message: `${root}(…) has no graph equivalent — the block and everything inside it were dropped. Loops, branches and .assign() live only in a hand-written module (see the shaderloader notes).`,
            line: expr.loc?.start.line,
            severity: 'warning',
          });
          path.skip();
          return;
        }
        if (
          t.isMemberExpression(expr.callee) &&
          t.isIdentifier(expr.callee.property) &&
          ASSIGN_METHODS.has(expr.callee.property.name)
        ) {
          const target = t.isIdentifier(expr.callee.object) ? expr.callee.object.name : 'value';
          warnings.push({
            message: `${target}.${expr.callee.property.name}(…) has no graph equivalent — it was dropped, so "${target}" keeps its initial value.`,
            line: expr.loc?.start.line,
            severity: 'warning',
          });
          return;
        }
        if (!t.isIdentifier(expr.callee) || expr.callee.name !== 'Discard') return;
        // `Discard(sdfOut1.w.lessThan(0.5))` is the SDF Output's miss cutout —
        // the node itself, not a user discard.
        if (sdfOutputId && expr.arguments[0] && /^sdfOut\d+$/.test(rootIdentifierOf(expr.arguments[0]) ?? '')) return;
        // The graph has ONE discard socket, so an unconditional `Discard()` and
        // a second condition cannot be represented. Both used to disappear in
        // silence — with the graph→code sync then writing the loss back into the
        // user's source on the next edit. Say so instead.
        if (expr.arguments.length === 0) {
          warnings.push({
            message: 'Unconditional Discard() has no graph equivalent — it was dropped.',
            severity: 'warning',
          });
          return;
        }
        if (pendingDiscardArg) {
          warnings.push({
            message:
              'Multiple Discard() statements — the Output node has one Discard input, so only the last is kept.',
            severity: 'warning',
          });
        }
        pendingDiscardArg = expr.arguments[0];
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { nodes: [], edges: [], errors: [{ message: msg }] };
  }

  // If nothing produced an output NODE, add an unconnected one. Asked of the
  // NODES rather than of `hasOutput`, because the two can disagree — a return
  // this parser consumed may still have produced no node — and a graph with no
  // Output is one the user cannot wire. (An existence check, not a "which one
  // is THE output" question, so `outputNodes` rather than a `find`.)
  if (outputNodes(rawNodes).length === 0 && !sdfOutputId) {
    const outputDef = NODE_REGISTRY.get('output');
    if (outputDef) {
      rawNodes.push(createNode(generateId(), outputDef, 'Output'));
    }
  }

  // Wire any deferred Discard(cond) into the output node's discard port.
  if (pendingDiscardArg) {
    // A module-level `Discard()` belongs to the MODULE, so it is the default
    // material's cutout — never one mesh's. It therefore lands on material 0's
    // bare `discard` handle, and never on a `m<n>:discard` one. (A per-mesh
    // cutout is a `discard` KEY inside that part, which `wireOutputChannels`
    // has already handled.)
    const outputNode = findDefaultOutput(rawNodes);
    if (outputNode) {
      // `Discard(float(<lit>))` is the discard widget's stored value (the
      // emitted form of a non-zero dial) — collapse it back into data.values
      // instead of materializing a Float node. Runs AFTER the return parse,
      // so merge with any values applyStoredOutputValues already attached.
      const storedDiscard = matchStoredChannelValue('discard', pendingDiscardArg);
      if (storedDiscard !== null) {
        const data = outputNode.data as Record<string, unknown>;
        data.values = {
          ...((data.values as Record<string, string | number>) ?? {}),
          discard: storedDiscard,
        };
        data.exposedPorts = Array.from(
          new Set([
            ...((data.exposedPorts as string[]) ?? OUTPUT_DEFAULT_EXPOSED),
            'discard',
          ]),
        );
      } else {
        const ref = resolveReturnSource(
          pendingDiscardArg, rawNodes, rawEdges, varToNodeId, varToHandle, splitNodes, code, warnings,
        );
        if (ref) {
          addEdge(rawEdges, ref.nodeId, ref.handle, outputNode.id, 'discard', 'float');
        }
      }
    }
  }

  return { nodes: rawNodes, edges: rawEdges, errors: warnings };
}

/** Push a typed animated edge, deriving its ID from the endpoints. */
/**
 * A `color(0xNNN)` literal → its `#rrggbb` string. Colour literals arrive from
 * `.fastshader` files and pasted source, i.e. ADVERSARIAL input: a raw
 * `Math.round(lit).toString(16)` of an out-of-range or negative value produces
 * a malformed hex (`#1000000`, `#0000-1`) that then reaches the swatch and the
 * `<input type=color>`. Anything outside a 24-bit colour degrades to black —
 * mirroring graphToCode's `hexLiteral` on the emit side.
 */
/** TSL statement-level constructs that build a control-flow block from a callback. */
const IMPERATIVE_BLOCKS = new Set(['Loop', 'If', 'Switch']);
/** The `.assign` family: a write to a `.toVar()` variable, meaningless in a DAG. */
const ASSIGN_METHODS = new Set([
  'assign', 'addAssign', 'subAssign', 'mulAssign', 'divAssign', 'modAssign',
]);

/**
 * The identifier at the ROOT of a call chain: `If(c, f).Else(g)` is a call on
 * the member `Else` of a call on `If`, so the plain callee check sees `Else`.
 */
function rootCallee(expr: t.CallExpression): string | null {
  let cur: t.Node = expr;
  for (let guard = 0; guard < 32; guard++) {
    if (t.isCallExpression(cur)) { cur = cur.callee; continue; }
    if (t.isMemberExpression(cur)) { cur = cur.object; continue; }
    return t.isIdentifier(cur) ? cur.name : null;
  }
  return null;
}

/** The identifier a call/member chain hangs off: `sdfOut1.w.lessThan(0.5)` → `sdfOut1`. */
function rootIdentifierOf(node: t.Node): string | null {
  let cur: t.Node = node;
  for (let guard = 0; guard < 32; guard++) {
    if (t.isCallExpression(cur)) { cur = cur.callee; continue; }
    if (t.isMemberExpression(cur)) { cur = cur.object; continue; }
    return t.isIdentifier(cur) ? cur.name : null;
  }
  return null;
}

function toHex6(lit: number): string {
  const n = Math.round(lit);
  return Number.isFinite(n) && n >= 0 && n <= 0xffffff
    ? '#' + n.toString(16).padStart(6, '0')
    : '#000000';
}

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
  // Anything that takes parameters, or whose defaultValues are CONSTRUCTOR
  // arguments (float(0.5), uniform(...)), must be declared explicitly so we
  // don't guess at the wrong shape.
  //
  // The Time node is the one exception: its `speed` default is a MODIFIER, not
  // a constructor argument, and a bare `time` identifier unambiguously means
  // speed 1. Without this exception, adding defaultValues to the time def
  // SILENTLY drops the Time node (and its edge) from `sin(time)`,
  // `mul(time, 1/6)`, `add(positionLocal, time, normalLocal)` — no error, no
  // warning. createNode seeds values from defaultValues, so the node created
  // here correctly starts at speed 1.
  if (def.inputs.length > 0) return undefined;
  if (def.defaultValues && def.type !== 'time') return undefined;
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

    // Collapse the 0–1 remap back into ONE noise node. Like the toVar/toConst
    // block above, this MUST run before the nested-chain recursion below, which
    // would otherwise build the Multiply and Add first and leave the noise node
    // orphaned behind them.
    //
    // MANDATORY, not tidiness: useSyncEngine's mergeMatch carries only id,
    // position, exposedPorts and materialSettings across a code→graph resync —
    // `data.values` comes wholly from this parse — so without the collapse every
    // code-panel Apply would silently reset the node to signed AND grow a junk
    // Multiply/Add pair.
    {
      const noiseCall = matchNoiseUnsignedRemap(callExpr);
      if (noiseCall) {
        // Delegate rather than build the node here, so the whole existing noise
        // path is reused — def lookup, cost, label, varToNodeId, and above all
        // processNoiseCall, which owns the `pos`/`scale` argument parsing (a
        // hand-rolled `arguments[0]` grab would store the mul-call node and
        // silently lose `scale`).
        processCall(
          noiseCall, varName,
          nodes, edges, varToNodeId, varToHandle, splitNodesMap, code, errors,
        );
        const id = varToNodeId.get(varName);
        const created = id ? nodes.find((n) => n.id === id) : undefined;
        if (created) setNodeValues(created, { signed: 0 });
        return;
      }
    }

    if (t.isIdentifier(callExpr.callee.object)) {
      objectVarName = callExpr.callee.object.name;
    } else if (t.isCallExpression(callExpr.callee.object)) {
      // Nested chain like `positionWorld.sub(cameraPosition).length()`. Recurse
      // on the inner call under a synthetic variable, then use that as the
      // chain receiver so the outer call can wire to it normally.
      // Unique per recursion level, NOT `nodes.length` — that was read BEFORE
      // the recursion pushed anything, so both levels of a three-deep chain
      // (`mx_noise_float(p).mul(0.5).add(0.5)`) minted the same synthetic name.
      // The middle node then overwrote the inner node's mapping before its own
      // receiver was wired, giving the middle node a SELF-EDGE: a cycle that
      // topologicalSort silently excludes, re-emitting the whole shader as
      // `return vec3(1, 0, 0)` — solid red — with `errors: []` to show for it.
      // General, not noise-specific: `sin(x).mul(2).add(1)` and
      // `positionWorld.sub(cameraPosition).length().mul(2)` did the same.
      const innerVar = `__chain${generateId()}`;
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

  // Detect the Time-speed pattern `time.mul(<numeric literal>)` — the exact
  // shape graphToCode emits for a Time node with speed !== 1.
  if (
    funcName === 'mul' &&
    objectVarName === 'time' &&
    !varToNodeId.has('time') &&
    callExpr.arguments.length === 1 &&
    tryParseTimeSpeed(callExpr, varName, nodes, edges, varToNodeId, varToHandle)
  ) {
    return;
  }

  // Detect the Append node: a vector CONSTRUCTOR that is not a plain
  // component-wise build. `append` emits `vec2|vec3|vec4(...)` — the very text a
  // Vec2/Vec3/Vec4 node emits — so the two are only separable by evidence, and
  // there are exactly two pieces of it:
  //
  //  - `isConcat` (fewer arguments than the constructor has components) means at
  //    least one argument carries several channels, which the VecN node
  //    STRUCTURALLY cannot hold: its ports are per-component floats. Parsing
  //    `vec3(uvVar, f)` as a Vec3 wired x=uvVar, y=f left z unwired, and the
  //    next graph→code pass re-emitted `vec3(uvVar, f, 0)` — four components in
  //    a three-slot constructor, i.e. a shader that no longer compiles.
  //  - `namedAppend` — the assigned variable's own name. graphToCode names an
  //    Append `append1`, a Vec3 `vec31`, so for code THIS APP emitted the name
  //    is the node's identity and a full-arity `vec3(a, b, c)` survives an Apply
  //    as an Append instead of degrading into a Vec3 (which is what happened to
  //    every 3- and 4-operand append). It carries no reference requirement: an
  //    unwired Append emits `vec2(0, 0)`, which has no ref to find.
  //
  // Deliberate limit: a HAND-WRITTEN full-arity `vec3(a, b, c)` under any other
  // name stays a Vec3 node. The two nodes emit identical text, so nothing in the
  // source can distinguish them — and keeping the component-wise form as VecN is
  // what leaves the built-in textures/presets (26 such calls) byte-identical.
  const VEC_CTOR_SIZE: Record<string, number> = { vec2: 2, vec3: 3, vec4: 4 };
  const appendCtorSize = VEC_CTOR_SIZE[funcName] ?? 0;
  if (appendCtorSize > 0 && callExpr.arguments.length >= 2 && callExpr.arguments.length <= appendCtorSize) {
    const isConcat = callExpr.arguments.length < appendCtorSize;
    const namedAppend = /^append\d*$/.test(varName);
    const hasVarRef = callExpr.arguments.some(
      (a) => t.isIdentifier(a) && varToNodeId.has(a.name)
    );
    const hasMemberRef = callExpr.arguments.some(
      (a) => t.isMemberExpression(a) && t.isIdentifier(a.object) && varToNodeId.has(a.object.name)
    );
    if (namedAppend || (isConcat && (hasVarRef || hasMemberRef))) {
      const appendDef = NODE_REGISTRY.get('append');
      if (appendDef) {
        const nodeId = generateId();
        const appendNode = createNode(nodeId, appendDef, varName);
        nodes.push(appendNode);
        varToNodeId.set(varName, nodeId);
        const ports = ['a', 'b', 'c', 'd'];
        for (let i = 0; i < callExpr.arguments.length; i++) {
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
          } else {
            const lit = extractLiteral(arg);
            if (typeof lit === 'number') setNodeValues(appendNode, { [ports[i]]: lit });
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

  // Colour uniform: `uniform(color(0xff0000))` → property_color. The
  // TSL_FUNCTION_TO_DEF map deliberately points bare `uniform` at
  // property_float (it owns the numeric form — see the map's comment in the
  // registry), so the colour form is recognised from the ARGUMENT shape here.
  // Without this branch the generic path would build a color node wired into a
  // property_float — a different graph than the one that emitted the code.
  if (funcName === 'uniform' && callExpr.arguments.length === 1) {
    const uArg = callExpr.arguments[0];
    if (t.isCallExpression(uArg) && t.isIdentifier(uArg.callee) && uArg.callee.name === 'color') {
      const colorDef = NODE_REGISTRY.get('property_color');
      const lit = uArg.arguments.length === 1 ? extractLiteral(uArg.arguments[0]) : undefined;
      if (colorDef && typeof lit === 'number') {
        const nodeId = generateId();
        const node = createNode(nodeId, colorDef, varName);
        setNodeValues(node, {
          hex: toHex6(lit),
          name: varName,
        });
        nodes.push(node);
        varToNodeId.set(varName, nodeId);
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
    // The Noise node models ONE argument (pos, optionally `pos.mul(scale)`),
    // but three/tsl's wrappers take more: mx_noise_*(pos, amplitude, pivot),
    // mx_fractal_noise_*(pos, octaves, lacunarity, diminish, amplitude),
    // mx_worley_noise_*(pos, jitter). processNoiseCall reads only args[0], so
    // a hand-written `mx_fractal_noise_float(p, 8)` used to come back out of
    // the next Apply as the 3-octave default with `errors: []` — a silent
    // rewrite of someone's shader. Warn instead; the node IS the right node,
    // it just cannot carry the extra parameters, so this stays NON-BLOCKING
    // (severity 'warning') and the Apply proceeds — useSyncEngine.ts:102
    // blocks on `errors.some(e => e.severity !== 'warning')`. graphToCode
    // never emits a multi-argument noise call and matchNoiseUnsignedRemap
    // refuses one, so this can only fire on hand-written / imported code,
    // never on a graph round-trip. Same reasoning as the guard at
    // matchNoiseUnsignedRemap.
    if (callExpr.arguments.length > 1) {
      const extra = callExpr.arguments.length - 1;
      errors.push({
        message: `${funcName}: ${extra} extra argument${extra > 1 ? 's' : ''} dropped — the Noise node stores only the position (and an optional scale multiplier).`,
        line: callExpr.loc?.start.line,
        severity: 'warning',
      });
    }
    processNoiseCall(callExpr, node, edges, varToNodeId, varToHandle);
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
    // Socket-growing calls carry more args than the two static registry ports —
    // synthesize the extra operand ports (c, d, …) so the whole
    // `add(a, b, c, d)` chain wires up instead of stopping at `b`.
    //
    // Gated on `growsOperands`, NOT `chainable`: `append` grows too (it is
    // `variadic`), and testing the fold flag here made a hand-typed
    // `append(f1, f2, f3)` drop its third argument silently — no edge, no error,
    // an orphaned source node, and `vec2(float1, float2)` back out. That is the
    // exact split `growsOperands`' own docblock warns about ("use this for
    // socket/layout questions; test `chainable` directly for fold semantics").
    const portIndex = inputIdx + i;
    // graphToCode's effectiveInputs caps operands at the node's own ceiling, so
    // any operand past it would be silently dropped on the next graph→code pass
    // — changing the computed value (worse for sub/div, and for `append` it
    // changes the vector's width). Stop here and warn instead of round-tripping
    // into a different expression. The number in the message is the node's REAL
    // cap, so `append` says 4 rather than quoting the global 64.
    const operandCap = Math.min(def.maxOperands ?? MAX_CHAIN_OPERANDS, MAX_CHAIN_OPERANDS);
    if (growsOperands(def) && portIndex >= operandCap) {
      errors.push({
        message: `"${funcName ?? def.type}" has more than ${operandCap} operands; the extras are ignored.`,
        line: callExpr.loc?.start.line,
        severity: 'warning',
      });
      break;
    }
    const port = def.inputs[portIndex]
      ?? (growsOperands(def)
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
          extractedValues[key] = toHex6(literalValue);
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
 * Match the exact 0–1 remap graphToCode emits for an unsigned noise node:
 * `<noiseFn>(<oneArg>).mul(0.5).add(0.5)`, returning the inner noise call.
 *
 * Deliberately narrow — each requirement rejects a real shape:
 *  - a bare Identifier callee on the noise call keeps the collapse off the one
 *    OTHER `.mul(0.5).add(0.5)` this codebase emits: dataRange's symlog tail,
 *    whose receiver is `<src>.sign().mul(...)`, a MemberExpression-callee call
 *    that dataVizNodes.test.ts asserts verbatim;
 *  - exactly ONE argument, because `mx_noise_float(p, 2)` would otherwise
 *    collapse into a clean-looking node with the amplitude silently DROPPED
 *    (processNoiseCall reads only args[0]) — a loud failure turned into a
 *    wrong render;
 *  - an inline CallExpression receiver, never a variable: `n.mul(0.5).add(0.5)`
 *    already parses into three real nodes, and a variable can have several
 *    consumers, so one flag could not represent "raw here, remapped there" —
 *    the same reasoning that keeps tryParseTimeSpeed off `mul(time1, 5)`;
 *  - the def must carry the range flag, since cellNoise/voronoi* are [0,1].
 *
 * The direct-call idiom `add(mul(base, 0.5), 0.5)` — what people actually write
 * by hand — cannot reach here at all: it takes the Identifier-callee path.
 *
 * Collapsing is SEMANTICS-PRESERVING (a hand-written chain in this exact shape
 * means precisely what the flag means), so unlike the Time-speed case it cannot
 * change what anyone's shader renders — only how many nodes it is drawn with.
 */
function matchNoiseUnsignedRemap(callExpr: t.CallExpression): t.CallExpression | undefined {
  const half = (call: t.CallExpression, method: string): t.CallExpression | undefined => {
    if (!t.isMemberExpression(call.callee) || !t.isIdentifier(call.callee.property)) return undefined;
    if (call.callee.property.name !== method) return undefined;
    if (call.arguments.length !== 1) return undefined;
    // Exact 0.5 — binary-exact, so no epsilon; `1 / 2` folds to it and collapses.
    if (foldNumericConstant(call.arguments[0] as t.Node) !== 0.5) return undefined;
    const recv = call.callee.object;
    return t.isCallExpression(recv) ? recv : undefined;
  };

  const mulCall = half(callExpr, 'add');
  if (!mulCall) return undefined;
  const noiseCall = half(mulCall, 'mul');
  if (!noiseCall) return undefined;
  if (!t.isIdentifier(noiseCall.callee) || noiseCall.arguments.length !== 1) return undefined;
  const def = TSL_FUNCTION_TO_DEF.get(noiseCall.callee.name);
  return def && hasNoiseRangeFlag(def.type) ? noiseCall : undefined;
}

/**
 * Detect `time.mul(<numeric literal>)` — the exact shape graphToCode emits for a
 * Time node whose `speed` multiplier is not 1 — and collapse it back into a
 * single Time node carrying `values.speed`. Returns true if it matched.
 *
 * `speed` is also an opt-in input socket, so the multiplier may instead be a
 * VARIABLE (`time.mul(speed1)`). That collapses too: the Time node gets an edge
 * into its `speed` port and the port is exposed, mirroring how processNoiseCall
 * wires a non-literal `scale`. Only a variable already bound to a node counts —
 * an unknown identifier falls through to a real Multiply, which is what it is.
 *
 * Deliberately narrow. The caller has already checked that the receiver is the
 * BARE `time` identifier (not a variable like `t` or `time1`), that `time` is
 * not shadowed by a user declaration, and that there is exactly one argument.
 * Here we additionally require a compile-time numeric constant. Together those
 * guards mean we never eat a user's real Multiply node:
 *   - `mul(time, 0.5)`   — the human idiom; pinned by codeToGraph.test.ts
 *   - `mul(time1, 5)`    — the Tests/ corpus writes this ~51 times, usually with
 *                          TWO muls sharing one time1, which a single Time node
 *                          could not represent
 *   - `t.mul(2)`         — variable receiver, not the bare identifier
 *   - `mul(t, speed)`    — non-literal multiplier; builtinTextures' Static Noise
 *                          and the time-using builtinPresets rely on this
 *   - `time.mul(0.5, 2)` — arity, matching tryParseUVTiling's discipline
 * `time.mul(0.5).mul(2)` collapses only its INNER call, leaving a real Multiply
 * outside — semantically correct, and a shape graphToCode never emits.
 */
function tryParseTimeSpeed(
  callExpr: t.CallExpression,
  varName: string,
  nodes: AppNode[],
  edges: AppEdge[],
  varToNodeId: Map<string, string>,
  varToHandle: Map<string, string>,
): boolean {
  const arg = callExpr.arguments[0];
  const speed = foldNumericConstant(arg);
  // A variable multiplier only collapses when it resolves to a real node.
  const wiredFrom =
    speed === undefined && t.isIdentifier(arg) ? varToNodeId.get(arg.name) : undefined;
  if (speed === undefined && !wiredFrom) return false;
  const timeDef = NODE_REGISTRY.get('time');
  if (!timeDef) return false;

  const nodeId = generateId();
  const node = createNode(nodeId, timeDef, varName);
  if (wiredFrom && t.isIdentifier(arg)) {
    addEdge(edges, wiredFrom, varToHandle.get(arg.name) ?? 'out', nodeId, 'speed');
    // The socket must be visible — an edge may never point at a hidden port.
    (node.data as { exposedPorts?: string[] }).exposedPorts = ['speed'];
  } else {
    // createNode already seeded values with timeDef.defaultValues; merge on top.
    setNodeValues(node, { speed: speed as number });
  }
  nodes.push(node);
  // Map only the DECLARED var name — never 'time'. ensureBareInputNode caches
  // under the bare name, so writing it here would alias two collapse sites with
  // different speeds onto one node.
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

  // The RGB-to-HSL node addresses its own components through REAL output
  // sockets, so `toHsl1.x` is that node's `h` handle — not a swizzle needing a
  // Split. Without this the round trip is unstable in the worst way: the code
  // and the picture stay correct while EVERY Apply splices a fresh Split
  // between toHsl and its consumers, so the graph grows without bound and a
  // byte-equality check still passes (a Split re-emits the same swizzle text).
  // `.w` has no HSL counterpart and falls through to the Split path below,
  // as does every other source type.
  const srcNode = nodes.find((n) => n.id === sourceId);
  if (srcNode?.data.registryType === 'toHsl') {
    const handle = TOHSL_COMPONENT_TO_HANDLE.get(component);
    if (handle) return { nodeId: sourceId, handle };
  }

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
  // A bare literal can itself be non-finite — `1e999` parses to Infinity. The
  // computed branches below already screen for this; without the same guard
  // here, an Infinity would be STORED in node values, and the fs:graph autosave
  // (JSON.stringify) rewrites it to `null`, which later coerces to a real 0.
  if (t.isNumericLiteral(node)) return Number.isFinite(node.value) ? node.value : undefined;
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
