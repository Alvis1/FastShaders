/**
 * Converts a shaderloader-compatible script module (.js) back into
 * FastShaders TSL code (Fn-wrapped) so it can be loaded into the editor.
 *
 * Reverses the transforms applied by tslToShaderModule.ts:
 *   - `export default function(params) {` → `const shader = Fn(() => {`
 *   - `const name = params.name;` → `const name = uniform(default);`
 *   - `export const schema = { ... }` → consumed for defaults, stripped
 *   - `{ colorNode: x }` → `{ color: x }` (strip Node suffix)
 *   - Adds Fn (and uniform if needed) back to the import line
 *   - Strips header comment block
 */

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

  const lines = scriptCode.split('\n');
  const outLines: string[] = [];

  // --- First pass: extract schema defaults ---
  const schemaDefaults = new Map<string, number>();
  let inSchema = false;
  let schemaBraceDepth = 0;
  for (const line of lines) {
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

  const hasProperties = schemaDefaults.size > 0;
  let insideFn = false;
  let fnBraceDepth = 0;
  let skipSchema = false;
  let schemaBraces = 0;
  let skipNestedFn = 0;

  for (const line of lines) {
    const trimmed = line.trim();

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
        for (const ch of trimmed) {
          if (ch === '{') skipNestedFn++;
          if (ch === '}') skipNestedFn--;
        }
        // Also track outer fnBraceDepth so the closing } count stays correct
        for (const ch of trimmed) {
          if (ch === '{') fnBraceDepth++;
          if (ch === '}') fnBraceDepth--;
        }
        continue;
      }
      if (/\bFn\s*\(/.test(trimmed)) {
        skipNestedFn = 0;
        for (const ch of trimmed) {
          if (ch === '{') skipNestedFn++;
          if (ch === '}') skipNestedFn--;
        }
        // Also track outer fnBraceDepth
        for (const ch of trimmed) {
          if (ch === '{') fnBraceDepth++;
          if (ch === '}') fnBraceDepth--;
        }
        if (skipNestedFn <= 0) skipNestedFn = 0;
        continue;
      }

      for (const ch of trimmed) {
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

      // Reverse `const name = params.name;` → `const name = uniform(default);`
      const paramsMatch = trimmed.match(/^const\s+(\w+)\s*=\s*params\.(\w+)\s*;?$/);
      if (paramsMatch && paramsMatch[1] === paramsMatch[2]) {
        const varName = paramsMatch[1];
        const defaultVal = schemaDefaults.get(varName) ?? 1.0;
        outLines.push(`${indent}const ${varName} = uniform(${defaultVal});`);
        continue;
      }

      // Reverse multi-channel return: { colorNode: x } → { color: x }.
      // Shorthand entries `{ colorNode }` are treated as `{ colorNode: colorNode }`
      // so the channel rename still applies.
      const objReturnMatch = trimmed.match(/^return\s*\{(.+)\}\s*;?$/);
      if (objReturnMatch) {
        const entries = objReturnMatch[1].split(',').map(entry => {
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
 */
function collapseMultilineReturns(scriptCode: string): string {
  return scriptCode.replace(
    /(^[ \t]*)return\s*\{([\s\S]*?)\}\s*;?/gm,
    (_, indent: string, body: string) => {
      const cleanBody = body
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean)
        .join(', ');
      return `${indent}return { ${cleanBody} };`;
    },
  );
}

/**
 * Split a comma-separated argument list on its *top-level* commas only —
 * commas nested inside (), [], or {} stay with their group. Used to pull the
 * discard conditions and color expression back out of a `__pixel(...)` call.
 */
function splitTopLevelArgs(s: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
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
  let depth = 1;
  let i = bodyStart;
  while (i < scriptCode.length && depth > 0) {
    const ch = scriptCode[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  if (depth !== 0) return scriptCode;
  const braceEnd = i - 1;

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
    let depth = 1;
    let i = bodyStart;
    while (i < scriptCode.length && depth > 0) {
      const ch = scriptCode[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    if (depth !== 0) continue;
    const bodyEnd = i - 1;
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
