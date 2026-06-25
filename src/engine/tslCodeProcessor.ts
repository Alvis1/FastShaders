/**
 * Shared TSL code processing utilities used by tslToPreviewHTML and tslToShaderModule.
 * Handles import extraction, TDZ fix, body parsing, and channel resolution.
 */

import type { MaterialSettings } from '@/types';

/** A-Frame geometry component strings with high segment counts for TSL effects */
export const AFRAME_GEO: Record<string, string> = {
  sphere: 'primitive: sphere; radius: 1; segmentsWidth: 64; segmentsHeight: 64',
  box: 'primitive: box; width: 1.4; height: 1.4; depth: 1.4',
  plane: 'primitive: plane; width: 2; height: 2',
};

export const CHANNEL_TO_PROP: Record<string, string> = {
  color: 'colorNode',
  emissive: 'emissiveNode',
  normal: 'normalNode',
  position: 'positionNode',
  opacity: 'opacityNode',
  roughness: 'roughnessNode',
};

export interface TSLImports {
  tslNames: string[];
}

export interface ProcessedBody {
  defLines: string[];
  channels: Record<string, string>;
}

/** Collect imported names from 'three/tsl'. */
export function collectImports(tslCode: string, excludeFn = false): TSLImports {
  const tslNames: string[] = [];

  const tslImportRe = /import\s*\{([^}]+)\}\s*from\s*['"]three\/tsl['"]/g;
  let m: RegExpExecArray | null;
  while ((m = tslImportRe.exec(tslCode)) !== null) {
    for (const name of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
      if (excludeFn && name === 'Fn') continue;
      if (!tslNames.includes(name)) tslNames.push(name);
    }
  }

  return { tslNames };
}

/** Extract the body of the Fn(() => { ... }); wrapper. */
export function extractFnBody(tslCode: string, tslNames: string[]): string {
  const fnStart = tslCode.indexOf('Fn(() => {');
  const fnEnd = tslCode.lastIndexOf('});');
  let body = '';
  if (fnStart !== -1 && fnEnd !== -1) {
    body = tslCode.slice(fnStart + 'Fn(() => {'.length, fnEnd).trim();
  }
  if (!body) {
    body = 'return vec3(1, 0, 0);';
    if (!tslNames.includes('vec3')) tslNames.push('vec3');
  }
  return body;
}

/**
 * Fix TDZ (Temporal Dead Zone) issues in generated code:
 * 1. Remove self-referencing bare declarations (const X = X;)
 * 2. Rename local variables that shadow imported function names
 * 3. Fix bare numeric first-arg in MaterialX noise calls
 */
export function fixTDZ(body: string, tslNames: string[]): string {
  let processedBody = body;
  const importedNames = new Set(tslNames);

  // 1. Remove self-referencing bare declarations: const X = X;
  for (const name of importedNames) {
    const selfRefRe = new RegExp(
      `^[ \\t]*const\\s+${name}\\s*=\\s*${name}\\s*;[ \\t]*$`, 'gm'
    );
    processedBody = processedBody.replace(selfRefRe, '');
  }

  // 2. Rename local variables that shadow imported function names
  const declRe = /\bconst\s+(\w+)\s*=/g;
  const conflicting = new Set<string>();
  let dm: RegExpExecArray | null;
  while ((dm = declRe.exec(processedBody)) !== null) {
    if (importedNames.has(dm[1])) {
      conflicting.add(dm[1]);
    }
  }
  for (const name of conflicting) {
    processedBody = processedBody.replace(
      new RegExp(`\\b${name}\\b(?!\\s*[:(])`, 'g'),
      `_${name}`,
    );
  }

  // 3. Fix bare numeric first-arg in MaterialX noise calls — default to uv()
  processedBody = processedBody.replace(
    /\b(mx_\w+)\(\s*0\s*\)/g,
    '$1(uv())',
  );
  processedBody = processedBody.replace(
    /\b(mx_\w+)\(\s*0\s*,/g,
    '$1(uv(),',
  );
  if (processedBody.includes('uv(') && !tslNames.includes('uv')) {
    tslNames.push('uv');
  }

  return processedBody;
}

/** Parse processed body into definition lines and output channels. */
export function parseBody(
  processedBody: string,
  tslNames: string[],
): ProcessedBody {
  const defLines: string[] = [];
  const channels: Record<string, string> = {};

  for (const rawLine of processedBody.split('\n')) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const objReturn = trimmed.match(/^return\s*\{(.+)\}\s*;?$/);
    const simpleReturn = trimmed.match(/^return\s+(.+);$/);

    if (objReturn) {
      for (const prop of objReturn[1].split(',')) {
        const colonIdx = prop.indexOf(':');
        if (colonIdx !== -1) {
          const key = prop.slice(0, colonIdx).trim();
          const val = prop.slice(colonIdx + 1).trim();
          if (key && val) channels[key] = val;
        }
      }
    } else if (simpleReturn) {
      channels['color'] = simpleReturn[1].trim();
    } else {
      defLines.push(rawLine);
    }
  }

  if (Object.keys(channels).length === 0) {
    channels['color'] = 'vec3(1, 0, 0)';
    if (!tslNames.includes('vec3')) tslNames.push('vec3');
  }

  return { defLines, channels };
}

/** THREE.FrontSide=0, THREE.BackSide=1, THREE.DoubleSide=2 */
export const SIDE_VALUES: Record<string, number> = {
  front: 0,
  back: 1,
  double: 2,
};

export interface ShaderModuleProperty {
  name: string;
  defaultValue: number;
}

export interface BuildShaderModuleOptions {
  materialSettings?: MaterialSettings;
  /**
   * Comment lines emitted above the import statements. The standalone `.js`
   * export uses this for its usage header; the live preview omits it.
   */
  header?: string[];
  /**
   * Declared float properties. When provided (export), the schema uses each
   * property's `defaultValue` and only `const NAME = uniform(V)` declarations
   * whose name matches a property are rewritten to `const NAME = params.NAME`.
   * When omitted (preview), every `uniform(V)` declaration is auto-detected and
   * its literal `V` becomes the schema default.
   */
  properties?: ShaderModuleProperty[];
}

/**
 * Convert Fn-wrapped editor TSL into a shaderloader-compatible ES module. This
 * is the SINGLE source of truth shared by the live preview (tslToPreviewHTML)
 * and the `.js` export (tslToShaderModule) — they must never diverge, because
 * any divergence means the export ships a shader that differs from what the
 * user previewed.
 *
 * The shaderloader calls the default export as a *plain function* (no active
 * TSL stack) and assigns `material.colorNode = result.colorNode` directly, so
 * two rules are non-negotiable and historically easy to break with ad-hoc
 * per-line string surgery (which is exactly what produced the struct-as-
 * colorNode export bug):
 *
 *   1. Object returns (`{ color, position, ... }`) MUST be parsed per channel.
 *      `parseBody` matches the object-form return before the bare-value form so
 *      a `{ ... }` literal is never swallowed whole into a single color slot —
 *      assigning a struct to `colorNode` makes the renderer read uninitialised
 *      memory (random color each reload) and drops every other channel.
 *   2. `Discard()` needs an active stack, so the color channel is routed
 *      through a tiny `__pixel` Fn. Its discard conditions and color node are
 *      passed as explicit Fn *parameters*, never closure-captured: Three.js
 *      r173 (where first diagnosed; the bundled A-Frame build is now r184) did not propagate closure-captured
 *      derived nodes into an Fn body invoked from an outer plain function,
 *      which would otherwise resolve the color to a default (solid red).
 */
export function buildShaderModule(
  tslCode: string,
  options: BuildShaderModuleOptions = {},
): string {
  const { materialSettings, header, properties } = options;

  const { tslNames } = collectImports(tslCode, true);
  const body = extractFnBody(tslCode, tslNames);
  const processedBody = fixTDZ(body, tslNames);
  const { defLines, channels } = parseBody(processedBody, tslNames);

  // Ensure positionLocal (and normalLocal for normal-based displacement) are available.
  const displacementMode = materialSettings?.displacementMode ?? 'normal';
  if (channels.position) {
    if (!tslNames.includes('positionLocal')) tslNames.push('positionLocal');
    if (displacementMode === 'normal' && !tslNames.includes('normalLocal')) {
      tslNames.push('normalLocal');
    }
  }

  // --- Property uniforms → params + schema --------------------------------
  //
  // Rewriting `const X = uniform(N)` to `const X = params.X` (plus an explicit
  // `schema`) makes the shaderloader create the uniforms up-front and pass them
  // in, so the live overlay's `_propertyUniforms.X.value = …` reaches the
  // material instead of mutating a throwaway anonymous uniform.
  const explicit = !!(properties && properties.length > 0);
  const propDefaults = new Map<string, number>(
    (properties ?? []).map((p) => [p.name, p.defaultValue]),
  );
  const schemaEntries: Record<string, number> = {};
  // Export mode declares the full schema up-front: a property node may exist
  // without being wired into the output, so its `uniform()` line can be absent.
  if (explicit) {
    for (const p of properties!) schemaEntries[p.name] = p.defaultValue;
  }
  const uniformLineRe = /^(\s*)const\s+(\w+)\s*=\s*uniform\(\s*(-?\d+(?:\.\d+)?)\s*\)\s*;?\s*$/;
  const rewrittenDefLines = defLines.map((line) => {
    const m = line.match(uniformLineRe);
    if (!m) return line;
    const [, indent, name, rawVal] = m;
    // Export: only convert uniforms that correspond to a declared property.
    if (explicit && !propDefaults.has(name)) return line;
    if (!explicit) {
      const v = parseFloat(rawVal);
      schemaEntries[name] = isNaN(v) ? 0 : v;
    }
    return `${indent}const ${name} = params.${name};`;
  });
  const hasParams = Object.keys(schemaEntries).length > 0;

  // --- Pull Discard(...) out for the __pixel wrapper ----------------------
  const discardLines: string[] = [];
  const nonDiscardLines: string[] = [];
  for (const line of rewrittenDefLines) {
    if (/^\s*Discard\(/.test(line)) discardLines.push(line);
    else nonDiscardLines.push(line);
  }
  const hasDiscard = discardLines.length > 0;
  if (hasDiscard && !tslNames.includes('Fn')) tslNames.push('Fn');

  const discardConds = discardLines
    .map((l) => {
      const m = l.match(/^\s*Discard\(\s*([\s\S]+?)\s*\)\s*;?\s*$/);
      return m ? m[1].trim() : '';
    })
    .filter(Boolean);
  const pixelCallArgs = hasDiscard
    ? [...discardConds, channels.color ?? 'vec3(1, 0, 0)']
    : [];

  // --- Build the return object (node property names per channel) ----------
  const returnProps: string[] = [];
  for (const [ch, ref] of Object.entries(channels)) {
    const prop = CHANNEL_TO_PROP[ch];
    if (!prop) continue;
    if (ch === 'position') {
      const displacement = displacementMode === 'normal'
        ? `normalLocal.mul(${ref})`
        : ref;
      returnProps.push(`${prop}: positionLocal.add(${displacement})`);
    } else if (ch === 'color' && hasDiscard) {
      returnProps.push(`${prop}: __pixel(${pixelCallArgs.join(', ')})`);
    } else {
      returnProps.push(`${prop}: ${ref}`);
    }
  }

  if (materialSettings?.transparent) returnProps.push('transparent: true');
  if (materialSettings?.side) {
    returnProps.push(`side: ${SIDE_VALUES[materialSettings.side] ?? 0}`);
  }
  if (materialSettings?.alphaTest) {
    returnProps.push(`alphaTest: ${materialSettings.alphaTest}`);
  }

  // --- The __pixel Fn: conditions + color as explicit params (see rule 2) -
  const pixelFnLines: string[] = [];
  if (hasDiscard) {
    const fnParams = [...discardConds.map((_, i) => `__c${i}`), '__color'];
    pixelFnLines.push(`  const __pixel = Fn(([${fnParams.join(', ')}]) => {`);
    discardConds.forEach((_, i) => pixelFnLines.push(`    Discard(__c${i});`));
    pixelFnLines.push('    return __color;');
    pixelFnLines.push('  });');
  }

  // --- Explicit schema export so original defaults survive ----------------
  const schemaLines: string[] = [];
  if (hasParams) {
    schemaLines.push('export const schema = {');
    for (const [name, def] of Object.entries(schemaEntries)) {
      schemaLines.push(`  ${name}: { type: 'number', default: ${def} },`);
    }
    schemaLines.push('};');
    schemaLines.push('');
  }

  const imports = tslNames.length > 0
    ? [`import { ${tslNames.join(', ')} } from 'three/tsl';`]
    : [];

  const lines = [
    ...(header && header.length ? [...header, ''] : []),
    ...imports,
    '',
    ...schemaLines,
    `export default function(${hasParams ? 'params' : ''}) {`,
    ...nonDiscardLines.map((l) => '  ' + l.trimStart()),
    ...pixelFnLines,
    `  return { ${returnProps.join(', ')} };`,
    '}',
  ];

  return lines.join('\n') + '\n';
}
