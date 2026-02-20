import * as THREE from 'three';
import * as tslTextures from 'tsl-textures';

interface ScriptResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  colorNode: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  normalNode: any;
  success: boolean;
  error?: string;
}

/**
 * Detect whether code uses tsl-textures or direct material assignment style
 * (as opposed to the graph-generated Fn() wrapper style).
 */
export function isTSLTexturesCode(code: string): boolean {
  return /model\.material\.\w+Node\s*=/.test(code);
}

/**
 * Evaluate tsl-textures style code and return the resulting TSL nodes.
 *
 * Supported patterns:
 *   import * as THREE from "three";
 *   import { polkaDots } from "tsl-textures";
 *   model.material.colorNode = polkaDots({ ... });
 */
export function evaluateTSLScript(code: string): ScriptResult {
  try {
    const argNames: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const argValues: any[] = [];

    // Handle: import * as THREE from "three"
    const threeStarMatch = /import\s+\*\s+as\s+(\w+)\s+from\s*['"]three['"]/.exec(code);
    if (threeStarMatch) {
      argNames.push(threeStarMatch[1]);
      argValues.push(THREE);
    }

    // Handle: import { Color, Vector3 } from "three"
    const threeNamedMatch = /import\s*\{([^}]+)\}\s*from\s*['"]three['"]/.exec(code);
    if (threeNamedMatch) {
      const names = threeNamedMatch[1].split(',').map(s => s.trim()).filter(Boolean);
      for (const name of names) {
        argNames.push(name);
        argValues.push((THREE as Record<string, unknown>)[name]);
      }
    }

    // Handle: import { polkaDots, marble } from "tsl-textures"
    const tslNamedRegex = /import\s*\{([^}]+)\}\s*from\s*['"]tsl-textures['"]/g;
    let tslMatch;
    while ((tslMatch = tslNamedRegex.exec(code)) !== null) {
      const names = tslMatch[1].split(',').map(s => s.trim()).filter(Boolean);
      for (const name of names) {
        if (!argNames.includes(name)) {
          argNames.push(name);
          argValues.push((tslTextures as Record<string, unknown>)[name]);
        }
      }
    }

    // Handle: import * as tslTex from "tsl-textures"
    const tslStarMatch = /import\s+\*\s+as\s+(\w+)\s+from\s*['"]tsl-textures['"]/.exec(code);
    if (tslStarMatch) {
      argNames.push(tslStarMatch[1]);
      argValues.push(tslTextures);
    }

    // Strip all import lines
    let body = code.replace(/^\s*import\s+.*$/gm, '').trim();

    // Strip <script> blocks if pasted from HTML examples
    body = body.replace(/<script[\s\S]*?<\/script>/gi, '').trim();

    // Rewrite model.material.XNode = ... into captures
    body = body
      .replace(/model\.material\.colorNode\s*=\s*/g, '__result.colorNode = ')
      .replace(/model\.material\.normalNode\s*=\s*/g, '__result.normalNode = ');

    const execCode = [
      '"use strict";',
      'const __result = { colorNode: null, normalNode: null };',
      body,
      'return __result;',
    ].join('\n');

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(...argNames, execCode);
    const result = fn(...argValues);

    return {
      colorNode: result.colorNode,
      normalNode: result.normalNode,
      success: result.colorNode !== null,
    };
  } catch (e) {
    return {
      colorNode: null,
      normalNode: null,
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
