/**
 * Converts a shaderloader-compatible script module (.js) back into
 * FastShaders TSL code (Fn-wrapped) so it can be loaded into the editor.
 *
 * Reverses the transforms applied by tslToShaderModule.ts:
 *   - `export default function(params) {` → `const shader = Fn(() => {`
 *   - every `params.name` reference → a `const name = uniform(default);` hoisted
 *     to the top of the Fn body, plus the reference rewritten to bare `name`
 *     (AST-driven — see hoistParamUniforms)
 *   - `export const schema = { ... }` → consumed for defaults, stripped
 *   - `{ colorNode: x }` → `{ color: x }` (strip Node suffix)
 *   - Adds Fn (and uniform if needed) back to the import line
 *   - Strips header comment block
 */

import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';

// Handle babel traverse CJS/ESM interop
const traverse = (typeof (_traverse as unknown as { default?: unknown }).default === 'function'
  ? (_traverse as unknown as { default: typeof _traverse }).default
  : _traverse) as typeof _traverse;

const NODE_PROP_TO_CHANNEL: Record<string, string> = {
  colorNode: 'color',
  emissiveNode: 'emissive',
  normalNode: 'normal',
  positionNode: 'position',
  opacityNode: 'opacity',
  roughnessNode: 'roughness',
};

/** Material settings keys injected by tslToShaderModule that should be stripped */
const MATERIAL_KEYS = new Set(['transparent', 'side', 'alphaTest']);

export function scriptToTSL(scriptCode: string): string {
  // Already editor-shaped TSL — a top-level `Fn(...)` wrapper with no
  // shaderloader `export default function` module wrapper. The conversion
  // loop below only recognises the module shape and treats everything else
  // at module scope as stray lines, so converting raw TSL would silently
  // drop the whole shader body. Pass it through unchanged instead —
  // codeToGraph parses this form directly (it's the TSL panel's format).
  // Modules that merely *contain* nested Fn wrappers (e.g. the __pixel
  // discard form) still have the `export default function` wrapper and take
  // the conversion path.
  if (
    !/^\s*export\s+default\s+function\s*\(/m.test(scriptCode) &&
    /\bFn\s*\(/.test(scriptCode)
  ) {
    return scriptCode;
  }

  // Pre-pass: collapse multi-line `import { ... } from '...'` statements onto a
  // single line. Hand-authored shaderloader scripts often spread the import
  // across many lines, but the line-by-line passthrough below only recognises
  // the single-line form — without this, the body of the import is dropped and
  // the editor sees an unterminated `import {`.
  scriptCode = collapseMultilineImports(scriptCode);

  // Pre-pass: collapse multi-line `return { ... };` statements onto a single
  // line so the per-line objReturn handler below can rename channel keys
  // (`colorNode → color`, etc.). Hand-authored scripts often split the return
  // object across many lines; without this, the keys leak through verbatim and
  // codeToGraph wires them to handles that don't exist on the Output node.
  scriptCode = collapseMultilineReturns(scriptCode);

  // Pre-pass: inline the emitter's param-passing `__pixel` Fn — the current
  // discard form, where the conditions and color node are passed as Fn args
  // (see buildShaderModule). Reverses it to bare `Discard(cond);` statements
  // plus the original color expression. Must run before inlineIIFEAssignments,
  // which only recognises the empty-param closure form.
  scriptCode = inlinePixelFn(scriptCode);

  // Pre-pass: inline IIFE-style Fn wrappers used to give Discard/If an active
  // TSL stack — `const X = Fn(() => { ...Discard/If...; return Y; })();`. The
  // legacy `__pixel` closure form is one case; hand-authored scripts may
  // also wrap `colorNode` or any other channel binding the same way. Without
  // this, the generic nested-Fn skip below swallows the wrapper whole.
  scriptCode = inlineIIFEAssignments(scriptCode);

  const schemaDefaults = extractSchemaDefaults(scriptCode);

  // Pre-pass: turn `params.X` references into hoisted uniform locals. Only the
  // exact `const X = params.X;` shape used to be reversed, so any other position
  // — most commonly an inline call argument, `mul(time, params.Bands)` —
  // survived into the TSL as a member expression codeToGraph cannot represent,
  // silently pinning the port to its default.
  const params = hoistParamUniforms(scriptCode, schemaDefaults);
  scriptCode = params.code;

  const lines = scriptCode.split('\n');
  // Brace/paren depth is tracked against a masked copy so a `{`, `}` or `"` in
  // a string literal or comment can't move it — a stray `"a } b"` used to close
  // the shader function early and silently drop the rest of the body. The mask
  // preserves length and newlines, so it stays line-aligned with `lines`.
  const maskedLines = maskNonCode(scriptCode).split('\n');
  const outLines: string[] = [];

  // A hoisted param needs `uniform` imported even when the module ships no
  // schema block (defaults then fall back to 1.0, as they always have).
  const hasProperties = schemaDefaults.size > 0 || params.hoisted.length > 0;
  let insideFn = false;
  let fnBraceDepth = 0;
  let skipSchema = false;
  let schemaBraces = 0;
  let skipNestedFn = 0;
  let keepHelper = false;
  let helperBraces = 0;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const trimmed = line.trim();
    /** Same line with string/comment contents blanked — count braces on this. */
    const maskedTrimmed = (maskedLines[li] ?? line).trim();

    // Skip header comments
    if (!insideFn && trimmed.startsWith('//')) continue;

    // Skip blank lines before content starts
    if (!insideFn && outLines.length === 0 && trimmed === '') continue;

    // Skip schema block (already consumed)
    if (/^export\s+const\s+schema\s*=\s*\{/.test(trimmed)) {
      skipSchema = true;
      schemaBraces = 0;
      for (const ch of trimmed) {
        if (ch === '{') schemaBraces++;
        if (ch === '}') schemaBraces--;
      }
      if (schemaBraces <= 0) skipSchema = false;
      continue;
    }
    if (skipSchema) {
      for (const ch of trimmed) {
        if (ch === '{') schemaBraces++;
        if (ch === '}') schemaBraces--;
      }
      if (schemaBraces <= 0) skipSchema = false;
      continue;
    }

    // Skip blank lines between schema and function
    if (!insideFn && outLines.length > 0 && trimmed === '' &&
        outLines[outLines.length - 1].trim() === '') continue;

    // --- Transform import lines ---
    if (/^\s*import\s*\{[^}]+\}\s*from\s*['"]three\/tsl['"]/.test(trimmed)) {
      const importMatch = trimmed.match(/\{([^}]+)\}/);
      if (importMatch) {
        const names = importMatch[1].split(',').map(n => n.trim()).filter(Boolean);
        if (!names.includes('Fn')) names.unshift('Fn');
        if (hasProperties && !names.includes('uniform')) names.push('uniform');
        // Remove positionLocal/normalLocal that were injected for displacement
        const filtered = names.filter(n => n !== 'positionLocal' && n !== 'normalLocal');
        outLines.push(`import { ${filtered.join(', ')} } from "three/tsl";`);
      }
      continue;
    }

    // Pass through other imports
    if (/^\s*import\s/.test(trimmed)) {
      outLines.push(line);
      continue;
    }

    // Preserve module-scope helper Fns (hsl/toHsl) emitted before the main
    // shader. codeToGraph skips their *definition* (path.skip), but the editor
    // code + live preview still need them present so the `hsl(...)` call
    // resolves — dropping them would re-introduce the helper-drop bug on the
    // .js → editor direction.
    if (!insideFn && !keepHelper &&
        /^\s*const\s+(hsl|toHsl)\s*=\s*Fn\(/.test(trimmed)) {
      keepHelper = true;
      helperBraces = 0;
      for (const ch of line) {
        if (ch === '{') helperBraces++;
        if (ch === '}') helperBraces--;
      }
      outLines.push(line);
      if (helperBraces <= 0) keepHelper = false;
      continue;
    }
    if (keepHelper) {
      for (const ch of line) {
        if (ch === '{') helperBraces++;
        if (ch === '}') helperBraces--;
      }
      outLines.push(line);
      if (helperBraces <= 0) keepHelper = false;
      continue;
    }

    // --- Detect function start ---
    if (!insideFn && /^export\s+default\s+function\s*\(/.test(trimmed)) {
      insideFn = true;
      fnBraceDepth = 1;
      outLines.push('const shader = Fn(() => {');
      continue;
    }

    // --- Inside function body ---
    if (insideFn) {
      // Skip nested Fn(() => { ... }) artifacts from unknown-node round-tripping.
      // These appear when graphToCode emits an unknown node's rawExpression containing
      // the original Fn wrapper, and tslToShaderModule passes it through verbatim.
      if (skipNestedFn > 0) {
        for (const ch of maskedTrimmed) {
          if (ch === '{') skipNestedFn++;
          if (ch === '}') skipNestedFn--;
        }
        // Also track outer fnBraceDepth so the closing } count stays correct
        for (const ch of maskedTrimmed) {
          if (ch === '{') fnBraceDepth++;
          if (ch === '}') fnBraceDepth--;
        }
        continue;
      }
      if (/\bFn\s*\(/.test(maskedTrimmed)) {
        skipNestedFn = 0;
        for (const ch of maskedTrimmed) {
          if (ch === '{') skipNestedFn++;
          if (ch === '}') skipNestedFn--;
        }
        // Also track outer fnBraceDepth
        for (const ch of maskedTrimmed) {
          if (ch === '{') fnBraceDepth++;
          if (ch === '}') fnBraceDepth--;
        }
        if (skipNestedFn <= 0) skipNestedFn = 0;
        continue;
      }

      for (const ch of maskedTrimmed) {
        if (ch === '{') fnBraceDepth++;
        if (ch === '}') fnBraceDepth--;
      }

      // Closing brace
      if (fnBraceDepth <= 0) {
        outLines.push('});');
        outLines.push('');
        outLines.push('export default shader;');
        insideFn = false;
        continue;
      }

      const indent = line.match(/^(\s*)/)?.[1] ?? '';

      // Reverse multi-channel return: { colorNode: x } → { color: x }.
      // Shorthand entries `{ colorNode }` are treated as `{ colorNode: colorNode }`
      // so the channel rename still applies.
      const objReturnMatch = trimmed.match(/^return\s*\{(.+)\}\s*;?$/);
      if (objReturnMatch) {
        // Top-level commas only: a plain `.split(',')` tears a nested call apart
        // (`colorNode: mix(a, b, c)` → `mix(a` / `b` / `c)`), and each fragment
        // then looks like an ES6 shorthand property and gets echoed as `x: x`.
        const entries = splitTopLevelArgs(objReturnMatch[1]).map(entry => {
          const trimmedEntry = entry.trim();
          if (!trimmedEntry) return null;
          const colonIdx = trimmedEntry.indexOf(':');
          let key: string;
          let val: string;
          if (colonIdx === -1) {
            key = trimmedEntry;
            val = trimmedEntry;
          } else {
            key = trimmedEntry.slice(0, colonIdx).trim();
            val = trimmedEntry.slice(colonIdx + 1).trim();
          }
          // Strip material settings keys
          if (MATERIAL_KEYS.has(key)) return null;
          // Reverse positionNode: positionLocal.add(normalLocal.mul(x)) → position: x
          if (key === 'positionNode') {
            const normalDisp = val.match(/^positionLocal\.add\(normalLocal\.mul\((.+)\)\)$/);
            if (normalDisp) return `position: ${normalDisp[1]}`;
            const offsetDisp = val.match(/^positionLocal\.add\((.+)\)$/);
            if (offsetDisp) return `position: ${offsetDisp[1]}`;
          }
          const channel = NODE_PROP_TO_CHANNEL[key];
          return channel ? `${channel}: ${val}` : `${key}: ${val}`;
        }).filter(Boolean);
        outLines.push(`${indent}return { ${entries.join(', ')} };`);
        continue;
      }

      outLines.push(line);
      continue;
    }

    // Outside function — skip stray lines (already emitted export default shader above)
  }

  // Clean up trailing blank lines
  while (outLines.length > 0 && outLines[outLines.length - 1].trim() === '') {
    outLines.pop();
  }

  return outLines.join('\n') + '\n';
}

/**
 * Collapse `import { a, b, c } from '...';` statements that span multiple
 * lines into a single line, normalising whitespace around the specifiers.
 * Only touches imports — other multi-line constructs are left alone.
 */
function collapseMultilineImports(scriptCode: string): string {
  return scriptCode.replace(
    /import\s*\{([\s\S]*?)\}\s*from\s*(['"][^'"]+['"])\s*;?/g,
    (_, names: string, from: string) => {
      const cleanNames = names
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
        .join(', ');
      return `import { ${cleanNames} } from ${from};`;
    },
  );
}

/**
 * Collapse multi-line `return { ... };` statements onto a single line so the
 * objReturn handler in scriptToTSL can rewrite channel keys uniformly.
 *
 * Brace-balanced by construction. The obvious `return\s*\{([\s\S]*?)\}` regex
 * is wrong twice over, and both failures corrupt real shaders silently:
 *
 *   - Non-greedy `*?` stops at the FIRST `}`, so any nested brace — an
 *     object-literal argument like `mx_noise_float({ scale: 2 })` — ends the
 *     match early and injects `};` mid-argument-list.
 *   - Joining the body without stripping comments lets a trailing `// note`
 *     swallow the closing `};`, because the collapse removes the newline that
 *     used to terminate the comment.
 *
 * So: mask comments/strings, walk braces to the real closer, strip comments out
 * of the body, and split on TOP-LEVEL commas only (a plain `.split(',')` would
 * tear `mix(a, b, c)` into pieces).
 */
function collapseMultilineReturns(scriptCode: string): string {
  const masked = maskNonCode(scriptCode);
  const headRe = /(^[ \t]*)return\s*\{/gm;
  const edits: Array<{ start: number; end: number; text: string }> = [];

  let m: RegExpExecArray | null;
  while ((m = headRe.exec(masked)) !== null) {
    const indent = m[1];
    const bodyStart = m.index + m[0].length; // just past the `{`
    const bodyEnd = findMatchingBrace(masked, bodyStart);
    if (bodyEnd === -1) continue;

    // Consume optional trailing whitespace + `;` so the rewrite replaces the
    // whole statement rather than leaving a stray terminator behind.
    let p = bodyEnd + 1;
    while (p < masked.length && /[ \t]/.test(masked[p])) p++;
    if (masked[p] === ';') p++;

    const body = stripComments(scriptCode.slice(bodyStart, bodyEnd));
    const cleanBody = splitTopLevelArgs(body)
      .map((e) => e.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join(', ');

    edits.push({ start: m.index, end: p, text: `${indent}return { ${cleanBody} };` });
    // Skip past the statement we just consumed so a nested `return {` inside it
    // can't produce an overlapping edit.
    headRe.lastIndex = p;
  }

  let out = scriptCode;
  for (let k = edits.length - 1; k >= 0; k--) {
    const e = edits[k];
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/**
 * Pull `default:` values out of the module's `export const schema = { ... }`
 * block. Read before any pre-pass runs, since the hoist needs them and the
 * pre-passes never touch the schema block.
 */
function extractSchemaDefaults(scriptCode: string): Map<string, number> {
  const schemaDefaults = new Map<string, number>();
  let inSchema = false;
  let schemaBraceDepth = 0;
  for (const line of scriptCode.split('\n')) {
    const trimmed = line.trim();
    if (/^export\s+const\s+schema\s*=\s*\{/.test(trimmed)) {
      inSchema = true;
      schemaBraceDepth = 0;
      for (const ch of trimmed) {
        if (ch === '{') schemaBraceDepth++;
        if (ch === '}') schemaBraceDepth--;
      }
      // Single-line schema
      if (schemaBraceDepth <= 0) {
        const propMatches = trimmed.matchAll(/(\w+)\s*:\s*\{[^}]*default\s*:\s*([^,}]+)/g);
        for (const m of propMatches) {
          const val = parseFloat(m[2].trim());
          if (!isNaN(val)) schemaDefaults.set(m[1], val);
        }
        inSchema = false;
      }
      continue;
    }
    if (inSchema) {
      for (const ch of trimmed) {
        if (ch === '{') schemaBraceDepth++;
        if (ch === '}') schemaBraceDepth--;
      }
      // Extract: name: { type: 'number', default: 1.5 },
      const propMatch = trimmed.match(/^(\w+)\s*:\s*\{[^}]*default\s*:\s*([^,}]+)/);
      if (propMatch) {
        const val = parseFloat(propMatch[2].trim());
        if (!isNaN(val)) schemaDefaults.set(propMatch[1], val);
      }
      if (schemaBraceDepth <= 0) inSchema = false;
      continue;
    }
  }
  return schemaDefaults;
}

/**
 * Rewrite every `params.<name>` reference in the default-exported function into
 * a `const <name> = uniform(<schema default>);` hoisted to the top of its body.
 *
 * Parsed, not pattern-matched. What's being rewritten is a *binding*, and the
 * distinctions that decide correctness are all structural ones a regex cannot
 * see: `params.X` in code vs. in a string or comment; `const X = params.X;` vs.
 * the same line carrying a trailing comment; a `let`/`var`/comma declarator; a
 * reference sitting above its own declaration. Every one of those, guessed
 * textually, silently emits TSL that throws (`const X = X;`) or names a local
 * that was never declared — worse than the untouched `params.X` this is meant
 * to fix. The AST answers them directly.
 *
 * Only OFFSETS come from the AST; the text is spliced. Regenerating from the
 * AST would reformat the module out from under the line-oriented passes that
 * run after this one.
 *
 * Returns the untouched source (and no hoists) on anything unexpected — an
 * unparseable module, a missing/destructured `params`, a name collision — so a
 * shape this can't model degrades to the old behaviour rather than to broken
 * output.
 */
function hoistParamUniforms(
  scriptCode: string,
  schemaDefaults: Map<string, number>,
): { code: string; hoisted: string[] } {
  const unchanged = { code: scriptCode, hoisted: [] as string[] };

  let ast: t.File;
  try {
    ast = parse(scriptCode, {
      sourceType: 'module',
      plugins: ['typescript'],
      errorRecovery: true,
    });
  } catch {
    return unchanged;
  }

  // Locate `export default function (params) { ... }` and its parameter name.
  let fn: t.FunctionDeclaration | t.FunctionExpression | null = null;
  for (const stmt of ast.program.body) {
    if (!t.isExportDefaultDeclaration(stmt)) continue;
    const d = stmt.declaration;
    if (t.isFunctionDeclaration(d) || t.isFunctionExpression(d)) fn = d;
  }
  if (!fn || fn.params.length !== 1 || !t.isIdentifier(fn.params[0])) return unchanged;
  const fnParam = fn.params[0];
  const paramsName = fnParam.name;
  const bodyStart = fn.body.start;
  if (bodyStart == null) return unchanged;

  // Every `params.X` inside the function, and every declarator of the shape
  // `const X = params.X;` (which the hoist replaces outright).
  const refs: Array<{ start: number; end: number; name: string }> = [];
  const order: string[] = [];
  const seen = new Set<string>();
  // A list, not a name-keyed map: the same param may be self-declared in more
  // than one scope, and every one of those declarations has to be dealt with.
  const selfDecls: Array<{
    name: string;
    declarator: t.VariableDeclarator;
    parent: t.VariableDeclaration;
  }> = [];
  const declared = new Set<string>();

  const readParamRef = (node: t.Node): string | null => {
    if (!t.isMemberExpression(node) || node.computed) return null;
    if (!t.isIdentifier(node.object) || node.object.name !== paramsName) return null;
    if (!t.isIdentifier(node.property)) return null;
    return node.property.name;
  };

  /**
   * Is this `params` OUR params? Resolved through scope rather than by nearest
   * enclosing function: a reference nested in an inner arrow still binds to the
   * outer parameter, while a helper that declares its own `params` shadows it.
   */
  const bindsOurParams = (path: { scope: { getBinding(n: string): { identifier: t.Node } | undefined } }): boolean =>
    path.scope.getBinding(paramsName)?.identifier === fnParam;

  try {
    traverse(ast, {
      // Any binding anywhere in the module — imports, functions, every declarator
      // (including destructured and comma-separated ones). A param whose name is
      // already bound cannot be hoisted under that name without shadowing or
      // double-declaring it.
      ImportDeclaration(path) {
        for (const s of path.node.specifiers) declared.add(s.local.name);
      },
      FunctionDeclaration(path) {
        if (path.node.id) declared.add(path.node.id.name);
      },
      VariableDeclarator(path) {
        const isSelfDecl =
          t.isIdentifier(path.node.id) &&
          path.node.init != null &&
          readParamRef(path.node.init) === path.node.id.name &&
          bindsOurParams(path);
        if (isSelfDecl) {
          selfDecls.push({
            name: (path.node.id as t.Identifier).name,
            declarator: path.node,
            parent: path.parent as t.VariableDeclaration,
          });
          return;
        }
        for (const name of Object.keys(t.getBindingIdentifiers(path.node))) declared.add(name);
      },
      MemberExpression(path) {
        const name = readParamRef(path.node);
        if (name == null) return;
        if (!bindsOurParams(path)) return; // a helper that shadows `params`
        if (path.node.start == null || path.node.end == null) return;
        refs.push({ start: path.node.start, end: path.node.end, name });
        if (!seen.has(name)) { seen.add(name); order.push(name); }
      },
    });
  } catch {
    // `errorRecovery` lets parse() return an AST for source it could only
    // partially understand; building scope over one of those throws (a
    // duplicate declaration, say). The import must survive that — the editor
    // still needs to show the user their text so they can fix it.
    return unchanged;
  }

  if (!order.length) return unchanged;

  // `Fn` and `uniform` are injected into the import line by the caller, so a
  // param named either of those would collide once emitted.
  const blocked = new Set(
    order.filter((n) => declared.has(n) || n === 'Fn' || n === 'uniform'),
  );
  const hoisted = order.filter((n) => !blocked.has(n));
  if (!hoisted.length) return unchanged;

  type Edit = { start: number; end: number; text: string };

  /** Source text of [start, end) with any `params.X` inside it resolved to `X`. */
  const rewriteWithin = (start: number, end: number): string => {
    let text = scriptCode.slice(start, end);
    const inner = refs
      .filter((r) => r.start >= start && r.end <= end && !blocked.has(r.name))
      .sort((a, b) => b.start - a.start);
    for (const r of inner) {
      text = text.slice(0, r.start - start) + r.name + text.slice(r.end - start);
    }
    return text;
  };

  // Drop `const X = params.X;` — the hoist supersedes it, and leaving it would
  // rewrite into the self-reference `const X = X;`.
  //
  // Rewritten one STATEMENT at a time, from its surviving declarators. Excising
  // declarators individually looks simpler but is wrong: neighbours both claim
  // the comma between them, so `const A = params.A, B = params.B;` yields two
  // overlapping ranges, and the second splice lands on text the first already
  // moved.
  const hoistedSet = new Set(hoisted);
  const dropped = new Map<t.VariableDeclaration, Set<t.VariableDeclarator>>();
  for (const s of selfDecls) {
    if (!hoistedSet.has(s.name)) continue;
    let set = dropped.get(s.parent);
    if (!set) { set = new Set(); dropped.set(s.parent, set); }
    set.add(s.declarator);
  }

  const rewritten: Edit[] = [];
  for (const [parent, drop] of dropped) {
    if (parent.start == null || parent.end == null) continue;
    const survivors = parent.declarations.filter((d) => !drop.has(d));
    if (!survivors.length) {
      rewritten.push({ start: parent.start, end: parent.end, text: '' });
      continue;
    }
    if (survivors.some((d) => d.start == null || d.end == null)) continue;
    const parts = survivors.map((d) => rewriteWithin(d.start as number, d.end as number));
    rewritten.push({
      start: parent.start,
      end: parent.end,
      text: `${parent.kind} ${parts.join(', ')};`,
    });
  }

  // A `params.X` inside a statement rewritten above is already handled by that
  // statement's replacement text; emitting a second edit for it would overlap.
  const edits: Edit[] = rewritten.slice();
  for (const r of refs) {
    if (blocked.has(r.name)) continue;
    if (rewritten.some((rm) => r.start >= rm.start && r.end <= rm.end)) continue;
    edits.push({ start: r.start, end: r.end, text: r.name });
  }

  const hoistText = hoisted
    .map((n) => `\n  const ${n} = uniform(${schemaDefaults.get(n) ?? 1.0});`)
    .join('');
  edits.push({ start: bodyStart + 1, end: bodyStart + 1, text: hoistText });

  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = scriptCode;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { code: out, hoisted };
}

/**
 * Split a comma-separated argument list on its *top-level* commas only —
 * commas nested inside (), [], or {} stay with their group. Used to pull the
 * discard conditions and color expression back out of a `__pixel(...)` call.
 */
function splitTopLevelArgs(s: string): string[] {
  // Depth is counted on the mask so a bracket or comma inside a string literal
  // or comment can't move it — `foo("}")` must stay one argument.
  const masked = maskNonCode(s);
  const args: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      args.push(s.slice(last, i).trim());
      last = i + 1;
    }
  }
  const tail = s.slice(last).trim();
  if (tail) args.push(tail);
  return args;
}

/** Per-character source classes produced by classifySource. */
const CLS_CODE = 0;
/** Inside a `//` or block comment, including its delimiters. */
const CLS_COMMENT = 1;
/** Inside a string/template literal, excluding the surrounding quotes. */
const CLS_STRING = 2;

/**
 * Classify every character of a JS source as code, comment, or string body.
 *
 * Both `maskNonCode` and `stripComments` derive from this single scan, so the
 * two can't disagree about where a comment ends — which matters because a `}`,
 * a `,` or a `//` sitting inside a comment or a string must never steer a
 * brace/argument scan.
 *
 * A line comment stops *before* its terminating newline, so stripping one
 * leaves the line break intact. Regex literals are not modelled: TSL shader
 * bodies don't contain them, and `/` in any other position is division, which
 * this scanner already treats as code.
 */
function classifySource(src: string): Uint8Array {
  const cls = new Uint8Array(src.length);
  type State = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tmpl';
  let state: State = 'code';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { cls[i] = cls[i + 1] = CLS_COMMENT; i += 2; state = 'line'; continue; }
      if (c === '/' && d === '*') { cls[i] = cls[i + 1] = CLS_COMMENT; i += 2; state = 'block'; continue; }
      if (c === "'") { state = 'sq'; i++; continue; }
      if (c === '"') { state = 'dq'; i++; continue; }
      if (c === '`') { state = 'tmpl'; i++; continue; }
      i++;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; i++; continue; }
      cls[i] = CLS_COMMENT;
      i++;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { cls[i] = cls[i + 1] = CLS_COMMENT; i += 2; state = 'code'; continue; }
      cls[i] = CLS_COMMENT;
      i++;
      continue;
    }
    // String-ish states: sq / dq / tmpl.
    if (c === '\\') { cls[i] = CLS_STRING; if (i + 1 < src.length) cls[i + 1] = CLS_STRING; i += 2; continue; }
    const closes = (state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tmpl' && c === '`');
    if (closes) { state = 'code'; i++; continue; }
    cls[i] = CLS_STRING;
    i++;
    continue;
  }
  return cls;
}

/**
 * Blank the *contents* of comments and string literals with spaces, preserving
 * the source's length and its newlines. Index-based scans (head matching, brace
 * balancing) run over the mask and then slice the original at the same offsets.
 */
function maskNonCode(src: string): string {
  const cls = classifySource(src);
  const out = src.split('');
  for (let i = 0; i < out.length; i++) {
    if (cls[i] !== CLS_CODE && out[i] !== '\n') out[i] = ' ';
  }
  return out.join('');
}

/**
 * Remove comments, leaving code and string literals untouched. Each comment run
 * collapses to a single space so neighbouring tokens can't glue together
 * (`a/*c*​/b` → `a b`, never `ab`).
 */
function stripComments(src: string): string {
  const cls = classifySource(src);
  let out = '';
  for (let i = 0; i < src.length; i++) {
    if (cls[i] !== CLS_COMMENT) { out += src[i]; continue; }
    while (i < src.length && cls[i] === CLS_COMMENT) i++;
    out += ' ';
    i--;
  }
  return out;
}

/**
 * Given an index just past an opening `{`, return the index of its matching
 * `}` (brace-balanced), or -1 if unbalanced. Shared by the Fn-unwrapping passes
 * (`inlinePixelFn`, `inlineIIFEAssignments`) so they can't drift on how a block
 * end is located.
 */
function findMatchingBrace(src: string, afterOpenBrace: number): number {
  let depth = 1;
  for (let i = afterOpenBrace; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Reverse the emitter's param-passing discard wrapper:
 *
 *   const __pixel = Fn(([__c0, __c1, ..., __color]) => {
 *     Discard(__c0);
 *     Discard(__c1);
 *     return __color;
 *   });
 *   return { colorNode: __pixel(condA, condB, ..., colorExpr), ... };
 *
 * The real conditions and color expression live in the *call arguments* (the
 * Fn body only references placeholder params, so closure capture is avoided —
 * see buildShaderModule's rule 2). Reversing therefore correlates the call
 * args back to the params: every arg but the last becomes a bare
 * `Discard(arg);` statement at the definition site, and the call itself is
 * replaced by the final (color) argument.
 *
 * Bails (leaves the text untouched) on any unexpected shape so a malformed
 * wrapper degrades to the generic nested-Fn skip rather than corrupting the
 * output.
 */
function inlinePixelFn(scriptCode: string): string {
  const headRe = /([ \t]*)const\s+__pixel\s*=\s*Fn\(\(\[([^\]]*)\]\)\s*=>\s*\{/;
  const head = headRe.exec(scriptCode);
  if (!head) return scriptCode;

  const indent = head[1];
  const params = head[2].split(',').map((p) => p.trim()).filter(Boolean);
  if (params.length < 1) return scriptCode;

  // Find the matching `}` of the arrow body.
  const bodyStart = head.index + head[0].length;
  const braceEnd = findMatchingBrace(scriptCode, bodyStart);
  if (braceEnd === -1) return scriptCode;

  // After `}` expect `)` (closes the Fn call) then optional `;`.
  let p = braceEnd + 1;
  while (p < scriptCode.length && /\s/.test(scriptCode[p])) p++;
  if (scriptCode[p] !== ')') return scriptCode;
  p++;
  while (p < scriptCode.length && /[ \t]/.test(scriptCode[p])) p++;
  if (scriptCode[p] === ';') p++;
  const defEnd = p;

  // Locate the `__pixel(...)` call that follows the definition and balance its
  // parens (arguments may themselves contain nested calls).
  const callStart = scriptCode.indexOf('__pixel(', defEnd);
  if (callStart === -1) return scriptCode;
  const argsStart = callStart + '__pixel('.length;
  let cdepth = 1;
  let j = argsStart;
  while (j < scriptCode.length && cdepth > 0) {
    const ch = scriptCode[j];
    if (ch === '(') cdepth++;
    else if (ch === ')') cdepth--;
    if (cdepth === 0) break;
    j++;
  }
  if (cdepth !== 0) return scriptCode;
  const argsStr = scriptCode.slice(argsStart, j);
  const callEnd = j + 1; // include the closing ')'

  const args = splitTopLevelArgs(argsStr);
  // One arg per param: trailing arg is the color, the rest are conditions.
  if (args.length !== params.length) return scriptCode;
  const condArgs = args.slice(0, -1);
  const colorArg = args[args.length - 1];

  const discardText = condArgs.map((c) => `${indent}Discard(${c});`).join('\n');

  // Apply both edits from the later offset first so the earlier one stays valid.
  let out = scriptCode.slice(0, callStart) + colorArg + scriptCode.slice(callEnd);
  out = out.slice(0, head.index) + discardText + out.slice(defEnd);
  return out;
}

/**
 * Inline IIFE-style Fn wrappers — `const X = Fn(() => { ...body...; return Y; })();` —
 * so that the discard/control-flow statements survive into the outer scope
 * and references to `X` resolve to the IIFE's return value.
 *
 * Two emitter-produced forms drive this:
 *
 *   // emitted by tslToShaderModule for the color channel with discard
 *   const __pixel = Fn(() => {
 *     Discard(cond);
 *     return colorVar;
 *   });
 *   return { colorNode: __pixel(), ... };
 *
 *   // emitted by hand-authored scripts that want a Discard inside an If
 *   const colorNode = Fn(() => {
 *     If(cond, () => { Discard(); });
 *     return baseColor;
 *   })();
 *   return { colorNode, positionNode };
 *
 * The first reverses to bare `Discard(cond);` plus a `__pixel()` → `colorVar`
 * substitution. The second reverses to `Discard(cond);` (with the If
 * collapsed) plus a `const colorNode = baseColor;` alias so downstream lookups
 * still see `colorNode`. Bodies that mix in any other statement kind cause us
 * to bail on that wrapper and leave it untouched.
 */
function inlineIIFEAssignments(scriptCode: string): string {
  // Use a brace-counter rather than a regex so nested `Fn(() => { ... If(...,
  // () => { Discard(); }) ... })` blocks find the correct closing brace. A
  // single lazy regex would stop at the first inner `}`.
  const headRe = /^([ \t]*)const\s+(\w+)\s*=\s*Fn\(\(\)\s*=>\s*\{/gm;
  const callSubstitutions = new Map<string, string>();
  const edits: Array<{ start: number; end: number; text: string }> = [];

  let m: RegExpExecArray | null;
  while ((m = headRe.exec(scriptCode)) !== null) {
    const indent = m[1];
    const name = m[2];
    const matchStart = m.index;
    const bodyStart = m.index + m[0].length;

    // Find matching closing brace of the arrow body.
    const bodyEnd = findMatchingBrace(scriptCode, bodyStart);
    if (bodyEnd === -1) continue;
    const body = scriptCode.slice(bodyStart, bodyEnd);

    // After the `}`, expect `)` closing the Fn call, optional `()` for IIFE,
    // optional `;`, then end-of-line.
    let p = bodyEnd + 1;
    while (p < scriptCode.length && /\s/.test(scriptCode[p])) p++;
    if (scriptCode[p] !== ')') continue;
    p++;

    let iife = false;
    let probe = p;
    while (probe < scriptCode.length && /\s/.test(scriptCode[probe])) probe++;
    if (scriptCode[probe] === '(') {
      let inner = probe + 1;
      while (inner < scriptCode.length && /\s/.test(scriptCode[inner])) inner++;
      if (scriptCode[inner] === ')') {
        iife = true;
        p = inner + 1;
      }
    }
    while (p < scriptCode.length && /[ \t]/.test(scriptCode[p])) p++;
    if (scriptCode[p] === ';') p++;
    while (p < scriptCode.length && /[ \t]/.test(scriptCode[p])) p++;
    const matchEnd = p;

    // Collapse `If(cond, () => { Discard(); });` into bare `Discard(cond);`.
    // Lazy condition match stops at the first top-level comma — fine for
    // simple conditions like `dist.gt(x)`.
    const collapsedBody = body.replace(
      /If\(([\s\S]+?),\s*\(\)\s*=>\s*\{[\s\S]*?Discard\(\)\s*;?[\s\S]*?\}\s*\)\s*;?/g,
      'Discard($1);',
    );

    const outerLines: string[] = [];
    let returnRef: string | null = null;
    let bail = false;
    for (const rawLine of collapsedBody.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      if (/^Discard\(/.test(trimmed)) {
        outerLines.push(`${indent}${trimmed}`);
        continue;
      }
      const ret = trimmed.match(/^return\s+(.+?);?$/);
      if (ret) {
        returnRef = ret[1].trim();
        continue;
      }
      bail = true;
      break;
    }
    if (bail) continue;

    let replacement: string;
    if (iife) {
      const alias = returnRef ? `${indent}const ${name} = ${returnRef};` : '';
      replacement = [...outerLines, alias].filter(Boolean).join('\n');
    } else {
      if (returnRef) callSubstitutions.set(name, returnRef);
      replacement = outerLines.join('\n');
    }

    edits.push({ start: matchStart, end: matchEnd, text: replacement });
  }

  // Apply edits in reverse so offsets stay valid.
  let out = scriptCode;
  for (let k = edits.length - 1; k >= 0; k--) {
    const e = edits[k];
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }

  for (const [name, value] of callSubstitutions) {
    out = out.replace(new RegExp(`\\b${name}\\(\\)`, 'g'), value);
  }

  return out;
}
