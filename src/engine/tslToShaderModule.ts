/**
 * Converts graph-generated TSL code (Fn-wrapped) into a shader module
 * compatible with the a-frame-shaderloader component.
 *
 * The shaderloader expects ES modules with:
 *   - Standard bare imports: `import { ... } from 'three/tsl'`
 *   - A default export that is either a function returning a TSL node
 *     (simple API) or returning an object with { colorNode, positionNode, ... }
 *     (object API).
 *   - An optional `export const schema = { ... }` describing property uniforms
 *     that the shaderloader creates and passes to the function as `params`.
 *
 * The shaderloader handles TDZ fixes and missing import injection at runtime,
 * so this module outputs clean, readable code without workarounds.
 */

import { CHANNEL_TO_PROP as CHANNEL_TO_NODE_PROP } from './tslCodeProcessor';
import type { MaterialSettings } from '@/types';

export interface PropertyInfo {
  name: string;
  type: 'float';
  defaultValue: number;
}

export function tslToShaderModule(
  tslCode: string,
  materialSettings?: MaterialSettings,
  properties?: PropertyInfo[],
): string {
  const lines = tslCode.split('\n');
  const outLines: string[] = [];
  let insideFn = false;
  let fnBraceDepth = 0;
  let skippedExportDefault = false;
  let needsPositionImports = false;

  const displacementMode = materialSettings?.displacementMode ?? 'normal';

  // Build a set of property names for uniform replacement
  const propertyNames = new Set((properties ?? []).map(p => p.name));
  const hasProperties = propertyNames.size > 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // --- Transform import lines ---
    // Remove 'Fn' from three/tsl imports
    if (/^\s*import\s*\{[^}]+\}\s*from\s*['"]three\/tsl['"]/.test(trimmed)) {
      const names = trimmed
        .match(/\{([^}]+)\}/)![1]
        .split(',')
        .map(n => n.trim())
        .filter(n => n && n !== 'Fn');
      if (names.length > 0) {
        outLines.push(`import { ${names.join(', ')} } from 'three/tsl';`);
      }
      continue;
    }

    // Pass through other imports (three, tsl-textures) unchanged
    if (/^\s*import\s/.test(trimmed)) {
      outLines.push(line);
      continue;
    }

    // --- Detect Fn wrapper start ---
    if (!insideFn && /^\s*const\s+\w+\s*=\s*Fn\(\(\)\s*=>\s*\{/.test(trimmed)) {
      insideFn = true;
      fnBraceDepth = 1;

      // Emit schema export before the function if properties exist
      if (hasProperties) {
        const schemaEntries = (properties ?? []).map(p =>
          `  ${p.name}: { type: '${p.type}', default: ${p.defaultValue} }`
        );
        outLines.push('');
        outLines.push('export const schema = {');
        outLines.push(schemaEntries.join(',\n'));
        outLines.push('};');
        outLines.push('');
        outLines.push('export default function(params) {');
      } else {
        outLines.push('export default function() {');
      }
      continue;
    }

    // --- Inside Fn body ---
    if (insideFn) {
      // Track brace depth
      for (const ch of trimmed) {
        if (ch === '{') fnBraceDepth++;
        if (ch === '}') fnBraceDepth--;
      }

      // Closing `});` of the Fn wrapper
      if (fnBraceDepth <= 0) {
        outLines.push('}');
        insideFn = false;
        continue;
      }

      // Replace property uniform declarations with params references
      if (hasProperties) {
        const uniformMatch = trimmed.match(/^const\s+(\w+)\s*=\s*uniform\([^)]*\)\s*;?\s*$/);
        if (uniformMatch && propertyNames.has(uniformMatch[1])) {
          const indent = line.match(/^(\s*)/)?.[1] ?? '';
          outLines.push(`${indent}const ${uniformMatch[1]} = params.${uniformMatch[1]};`);
          continue;
        }
      }

      // Convert multi-channel return: { color: x } → { colorNode: x }
      const objReturnMatch = trimmed.match(/^return\s*\{(.+)\}\s*;?$/);
      if (objReturnMatch) {
        const entries = objReturnMatch[1].split(',').map(prop => {
          const colonIdx = prop.indexOf(':');
          if (colonIdx === -1) return prop.trim();
          const key = prop.slice(0, colonIdx).trim();
          const val = prop.slice(colonIdx + 1).trim();
          const nodeProp = CHANNEL_TO_NODE_PROP[key];
          if (key === 'position' && nodeProp) {
            needsPositionImports = true;
            const displacement = displacementMode === 'normal'
              ? `normalLocal.mul(${val})`
              : val;
            return `${nodeProp}: positionLocal.add(${displacement})`;
          }
          return nodeProp ? `${nodeProp}: ${val}` : `${key}: ${val}`;
        });
        // Determine indentation from original line
        const indent = line.match(/^(\s*)/)?.[1] ?? '';
        outLines.push(`${indent}return { ${entries.join(', ')} };`);
        continue;
      }

      // All other lines inside Fn body — pass through
      outLines.push(line);
      continue;
    }

    // --- Outside Fn body ---
    // Skip `export default shader;` (we already have `export default function`)
    if (/^\s*export\s+default\s+\w+\s*;/.test(trimmed)) {
      skippedExportDefault = true;
      continue;
    }

    // Skip blank lines between closing `}` and removed `export default`
    if (skippedExportDefault && trimmed === '') continue;

    outLines.push(line);
  }

  // Remove 'uniform' from three/tsl import if all uniform calls were replaced by params
  if (hasProperties) {
    const hasRemainingUniform = outLines.some(l =>
      !/^\s*import/.test(l) && /\buniform\s*\(/.test(l)
    );
    if (!hasRemainingUniform) {
      for (let i = 0; i < outLines.length; i++) {
        if (/^\s*import\s*\{[^}]+\}\s*from\s*['"]three\/tsl['"]/.test(outLines[i])) {
          const match = outLines[i].match(/\{([^}]+)\}/);
          if (match) {
            const names = match[1].split(',').map(n => n.trim()).filter(n => n && n !== 'uniform');
            if (names.length > 0) {
              outLines[i] = `import { ${names.join(', ')} } from 'three/tsl';`;
            } else {
              outLines[i] = '';
            }
          }
          break;
        }
      }
    }
  }

  // Inject positionLocal/normalLocal into three/tsl import if position wrapping was applied
  if (needsPositionImports) {
    for (let i = 0; i < outLines.length; i++) {
      if (/^\s*import\s*\{[^}]+\}\s*from\s*['"]three\/tsl['"]/.test(outLines[i])) {
        const match = outLines[i].match(/\{([^}]+)\}/);
        if (match) {
          const names = match[1].split(',').map(n => n.trim()).filter(Boolean);
          if (!names.includes('positionLocal')) names.push('positionLocal');
          if (displacementMode === 'normal' && !names.includes('normalLocal')) {
            names.push('normalLocal');
          }
          outLines[i] = `import { ${names.join(', ')} } from 'three/tsl';`;
        }
        break;
      }
    }
  }

  // Clean up trailing blank lines
  while (outLines.length > 0 && outLines[outLines.length - 1].trim() === '') {
    outLines.pop();
  }

  return outLines.join('\n') + '\n';
}
