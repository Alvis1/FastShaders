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
  // Pre-pass: inline the `const __pixel = Fn(() => { Discard(...); return X; });`
  // wrapper that tslToShaderModule / convertToShaderModule emit to give
  // `Discard()` an active TSL stack. Without this, the generic nested-Fn-skip
  // logic below swallows the wrapper whole — the Discard line is lost and the
  // `__pixel()` call in the return ends up dangling.
  scriptCode = inlinePixelWrapper(scriptCode);

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

      // Reverse multi-channel return: { colorNode: x } → { color: x }
      const objReturnMatch = trimmed.match(/^return\s*\{(.+)\}\s*;?$/);
      if (objReturnMatch) {
        const entries = objReturnMatch[1].split(',').map(entry => {
          const colonIdx = entry.indexOf(':');
          if (colonIdx === -1) return entry.trim();
          const key = entry.slice(0, colonIdx).trim();
          const val = entry.slice(colonIdx + 1).trim();
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
 * Inline the discard-Fn wrapper. The emitters produce:
 *
 *   const __pixel = Fn(() => {
 *     Discard(cond);
 *     return colorVar;
 *   });
 *   return { colorNode: __pixel(), ... };
 *
 * which reverses to:
 *
 *   Discard(cond);
 *   return { colorNode: colorVar, ... };
 *
 * before the rest of scriptToTSL runs. Multiple Discard lines and arbitrary
 * indentation are tolerated. The `return X;` line inside the wrapper supplies
 * the value that replaces every `__pixel()` reference downstream. If we can't
 * find a well-formed wrapper we leave the script untouched — the generic
 * passthrough still produces a parseable (if non-functional) result.
 */
function inlinePixelWrapper(scriptCode: string): string {
  const wrapperRe =
    /^([ \t]*)const\s+__pixel\s*=\s*Fn\(\(\)\s*=>\s*\{([\s\S]*?)\}\s*\)\s*;?[ \t]*$/m;
  const match = wrapperRe.exec(scriptCode);
  if (!match) return scriptCode;

  const indent = match[1];
  const body = match[2];

  const discardLines: string[] = [];
  let returnRef: string | null = null;
  for (const rawLine of body.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (/^Discard\(/.test(trimmed)) {
      discardLines.push(`${indent}${trimmed}`);
      continue;
    }
    const ret = trimmed.match(/^return\s+(.+?);?$/);
    if (ret) {
      returnRef = ret[1].trim();
      continue;
    }
    // Unrecognized line — bail out, fall through to the original behaviour.
    return scriptCode;
  }

  // Replace the wrapper with the bare Discard lines (still inside the outer
  // function body) so the line-by-line passthrough re-emits them verbatim.
  let out = scriptCode.replace(match[0], discardLines.join('\n'));

  // Then swap every `__pixel()` reference for the captured return value.
  if (returnRef) {
    out = out.replace(/\b__pixel\(\)/g, returnRef);
  }

  return out;
}
