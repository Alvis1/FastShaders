/**
 * Shared TSL code processing utilities used by both tslToPreviewHTML and tslToAFrame.
 * Handles import extraction, TDZ fix, body parsing, and channel resolution.
 */

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
