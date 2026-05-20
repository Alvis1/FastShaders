/**
 * Converts graph-generated TSL code (Fn-wrapped) into a shader module
 * compatible with the a-frame-shaderloader component.
 *
 * The shaderloader expects ES modules with:
 *   - Standard bare imports: `import { ... } from 'three/tsl'`
 *   - A default export that is either a function returning a TSL node
 *     (simple API) or returning an object with { colorNode, positionNode, ... }
 *     (object API).
 *
 * The shaderloader handles TDZ fixes, missing import injection, and
 * auto-detects `const NAME = uniform(VALUE)` patterns to create property
 * uniforms at runtime — no explicit schema or params needed in the module.
 */

import { CHANNEL_TO_PROP as CHANNEL_TO_NODE_PROP } from './tslCodeProcessor';
import type { MaterialSettings } from '@/types';

export interface PropertyInfo {
  name: string;
  type: 'float';
  defaultValue: number;
}

// CDN base for the a-frame-shaderloader project
const CDN_BASE = 'https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js';

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
  // Track Discard(...) lines so we can wrap them in an Fn after the function
  // body is laid out — see the post-processing pass below. `Discard()` uses
  // `.toStack()` which only attaches to an active TSL execution stack, and
  // unwrapping the original `Fn(...)` into a plain `function(params)` leaves
  // no stack — so without this fix, live uniform changes can't move the
  // discard threshold and the call is a silent no-op.
  const discardLines: string[] = [];
  let discardColorRef: string | null = null;

  const props = properties ?? [];
  const propNames = new Set(props.map(p => p.name));
  const hasProps = props.length > 0;
  let uniformCallsTotal = 0;
  let uniformCallsReplaced = 0;

  const displacementMode = materialSettings?.displacementMode ?? 'normal';

  // Usage header
  outLines.push('// TSL Shader Module — for use with a-frame-shaderloader');
  outLines.push('//');
  outLines.push('// HTML setup:');
  outLines.push(`//   <script src="${CDN_BASE}/aframe-171-a-0.1.min.js"><${''}/script>`);
  outLines.push(`//   <script src="${CDN_BASE}/a-frame-shaderloader-0.3.js"><${''}/script>`);
  if (hasProps) {
    const propExample = props.map(p => `${p.name}: ${p.defaultValue}`).join('; ');
    outLines.push(`//   <a-entity shader="src: shader.js; ${propExample}"></a-entity>`);
    outLines.push('//');
    outLines.push('// Properties can be updated at runtime:');
    for (const p of props) {
      outLines.push(`//   el.setAttribute('shader', { ${p.name}: value });`);
    }
  } else {
    outLines.push('//   <a-entity shader="src: shader.js"></a-entity>');
  }
  outLines.push('//');
  outLines.push('// Also usable directly with Three.js — import from \'three/tsl\'');
  outLines.push('');

  for (const line of lines) {
    const trimmed = line.trim();

    // --- Transform import lines ---
    // Remove 'Fn' from three/tsl imports (uniform removal deferred to post-processing)
    if (/^\s*import\s*\{[^}]+\}\s*from\s*['"]three\/tsl['"]/.test(trimmed)) {
      const importMatch = trimmed.match(/\{([^}]+)\}/);
      if (!importMatch) continue;
      const names = importMatch[1]
        .split(',')
        .map(n => n.trim())
        .filter(n => n && n !== 'Fn');
      if (names.length > 0) {
        outLines.push(`import { ${names.join(', ')} } from 'three/tsl';`);
      }
      continue;
    }

    // Pass through other imports (e.g. raw 'three') unchanged
    if (/^\s*import\s/.test(trimmed)) {
      outLines.push(line);
      continue;
    }

    // --- Detect Fn wrapper start ---
    if (!insideFn && /^\s*const\s+\w+\s*=\s*Fn\(\(\)\s*=>\s*\{/.test(trimmed)) {
      insideFn = true;
      fnBraceDepth = 1;
      // Emit property schema so the shaderloader knows defaults
      if (hasProps) {
        outLines.push('export const schema = {');
        for (const prop of props) {
          outLines.push(`  ${prop.name}: { type: 'number', default: ${prop.defaultValue} },`);
        }
        outLines.push('};');
        outLines.push('');
      }
      outLines.push(hasProps ? 'export default function(params) {' : 'export default function() {');
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

      // Replace `const NAME = uniform(VALUE)` with `const NAME = params.NAME` for properties
      const uniformMatch = trimmed.match(/^const\s+(\w+)\s*=\s*uniform\(([^)]*)\)\s*;?$/);
      if (uniformMatch) {
        uniformCallsTotal++;
        const varName = uniformMatch[1];
        if (propNames.has(varName)) {
          uniformCallsReplaced++;
          const indent = line.match(/^(\s*)/)?.[1] ?? '';
          outLines.push(`${indent}const ${varName} = params.${varName};`);
          continue;
        }
      }

      // Capture bare `Discard(cond);` calls and drop them from the body —
      // they'll be re-emitted inside an Fn wrapper below.
      if (/^Discard\(/.test(trimmed)) {
        discardLines.push(line);
        continue;
      }

      // Single-value return: `return foo;` — when Discard is present, wrap the
      // color in __pixel() and convert to object API. Without this, single-
      // channel shaders (only color wired) would still drop the Discard.
      const simpleReturnMatch = trimmed.match(/^return\s+(.+);$/);
      if (simpleReturnMatch && discardLines.length > 0) {
        const val = simpleReturnMatch[1].trim();
        discardColorRef = val;
        const indent = line.match(/^(\s*)/)?.[1] ?? '';
        outLines.push(`${indent}const __pixel = Fn(() => {`);
        for (const dl of discardLines) {
          outLines.push(indent + '  ' + dl.trimStart());
        }
        outLines.push(`${indent}  return ${val};`);
        outLines.push(`${indent}});`);
        // Promote to object API so material settings can still be threaded
        // through the same return path the object-return branch uses.
        const extras: string[] = [];
        if (materialSettings?.transparent) extras.push('transparent: true');
        if (materialSettings?.side) {
          const sideValues: Record<string, number> = { front: 0, back: 1, double: 2 };
          extras.push(`side: ${sideValues[materialSettings.side] ?? 0}`);
        }
        if (materialSettings?.alphaTest) {
          extras.push(`alphaTest: ${materialSettings.alphaTest}`);
        }
        const props = ['colorNode: __pixel()', ...extras].join(', ');
        outLines.push(`${indent}return { ${props} };`);
        continue;
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
          // When Discard is present, swap the color value for __pixel() — the
          // original color expression is computed inside the Fn body below.
          if (key === 'color' && discardLines.length > 0) {
            discardColorRef = val;
            return nodeProp ? `${nodeProp}: __pixel()` : `${key}: __pixel()`;
          }
          return nodeProp ? `${nodeProp}: ${val}` : `${key}: ${val}`;
        });
        // Inject material settings into the return object
        if (materialSettings?.transparent) {
          entries.push('transparent: true');
        }
        if (materialSettings?.side) {
          const sideValues: Record<string, number> = { front: 0, back: 1, double: 2 };
          entries.push(`side: ${sideValues[materialSettings.side] ?? 0}`);
        }
        if (materialSettings?.alphaTest) {
          entries.push(`alphaTest: ${materialSettings.alphaTest}`);
        }
        const indent = line.match(/^(\s*)/)?.[1] ?? '';
        // Emit the __pixel Fn just before the return so the discard runs
        // inside an active TSL stack.
        if (discardLines.length > 0 && discardColorRef) {
          outLines.push(`${indent}const __pixel = Fn(() => {`);
          for (const dl of discardLines) {
            outLines.push(indent + '  ' + dl.trimStart());
          }
          outLines.push(`${indent}  return ${discardColorRef};`);
          outLines.push(`${indent}});`);
        }
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

  // Post-process the three/tsl import line
  for (let i = 0; i < outLines.length; i++) {
    if (/^\s*import\s*\{[^}]+\}\s*from\s*['"]three\/tsl['"]/.test(outLines[i])) {
      const match = outLines[i].match(/\{([^}]+)\}/);
      if (match) {
        const names = match[1].split(',').map(n => n.trim()).filter(Boolean);

        // Remove 'uniform' if all uniform() calls were replaced with params
        if (uniformCallsTotal > 0 && uniformCallsReplaced === uniformCallsTotal) {
          const idx = names.indexOf('uniform');
          if (idx !== -1) names.splice(idx, 1);
        }

        // Inject positionLocal/normalLocal if position wrapping was applied
        if (needsPositionImports) {
          if (!names.includes('positionLocal')) names.push('positionLocal');
          if (displacementMode === 'normal' && !names.includes('normalLocal')) {
            names.push('normalLocal');
          }
        }

        // Re-inject Fn when Discard wrapping requires it (the import-line
        // pass earlier stripped Fn unconditionally because the canonical
        // shader format wraps everything in Fn — we strip that wrapper and
        // emit a plain function, but the discard fix needs Fn back).
        if (discardLines.length > 0 && !names.includes('Fn')) {
          names.push('Fn');
        }

        outLines[i] = `import { ${names.join(', ')} } from 'three/tsl';`;
      }
      break;
    }
  }

  // Clean up trailing blank lines
  while (outLines.length > 0 && outLines[outLines.length - 1].trim() === '') {
    outLines.pop();
  }

  return outLines.join('\n') + '\n';
}
