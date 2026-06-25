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
 * The shaderloader handles TDZ fixes, missing import injection, rewrites the
 * `three/tsl` import to read the A-Frame bundle's global `THREE` (so no import
 * map and no shim are needed), and auto-detects `const NAME = uniform(VALUE)`
 * patterns to create property uniforms at runtime — no explicit schema or
 * params needed in the module.
 *
 * The actual TSL→module conversion lives in `buildShaderModule`
 * (tslCodeProcessor.ts), shared verbatim with the live preview so the exported
 * file always matches what the user saw. This module only adds the usage
 * header and threads through the declared property defaults.
 */

import { buildShaderModule } from './tslCodeProcessor';
import type { MaterialSettings } from '@/types';

export interface PropertyInfo {
  name: string;
  type: 'float';
  defaultValue: number;
}

// CDN base for the a-frame-shaderloader project
const CDN_BASE = 'https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@main/js';

/** Build the usage-comment header prepended to the exported module. */
function buildHeader(props: PropertyInfo[]): string[] {
  const hasProps = props.length > 0;
  const header: string[] = [
    '// TSL Shader Module — for use with a-frame-shaderloader',
    '//',
    '// HTML setup — these two scripts are all you need (no import map, no shim):',
    '//   a-frame-180-a-01.min.js = A-Frame 1.8.0 + Three.js r184 (WebGPU) bundle',
    '//   a-frame-shaderloader-0.4.js rewrites the three/tsl import to that bundle',
    `//   <script src="${CDN_BASE}/a-frame-180-a-01.min.js"><${''}/script>`,
    `//   <script src="${CDN_BASE}/a-frame-shaderloader-0.4.js"><${''}/script>`,
  ];
  if (hasProps) {
    const propExample = props.map((p) => `${p.name}: ${p.defaultValue}`).join('; ');
    header.push(`//   <a-entity shader="src: shader.js; ${propExample}"></a-entity>`);
    header.push('//');
    header.push('// Properties can be updated at runtime:');
    for (const p of props) {
      header.push(`//   el.setAttribute('shader', { ${p.name}: value });`);
    }
  } else {
    header.push('//   <a-entity shader="src: shader.js"></a-entity>');
  }
  header.push('//');
  header.push('// Also usable directly with Three.js, or any bundler that resolves \'three/tsl\'.');
  return header;
}

export function tslToShaderModule(
  tslCode: string,
  materialSettings?: MaterialSettings,
  properties?: PropertyInfo[],
): string {
  const props = properties ?? [];
  return buildShaderModule(tslCode, {
    materialSettings,
    header: buildHeader(props),
    properties: props,
  });
}
