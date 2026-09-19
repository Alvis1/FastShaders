/**
 * The ONE statement of how a single-GLB export is USED — the module header
 * lines the GLB-mode module carries (tslToShaderModule `opts.glbFile`) and
 * the A-Frame entity snippet the README, the module header and the A-Frame
 * tab all spell the same way.
 *
 * Every line is ASCII, carries no opening brace, no block-comment closer and
 * no `import`: the header is scanned by the loaders' source transforms
 * (autoInjectTSLImports matches an unanchored import brace, comments
 * included; 0.6 and 0.8 both strip `//` comments before the CALL scan, so
 * `url(` and `(` here are inert), and it sits above the project block, which
 * is a block comment. `glbFile` is always
 * `${shaderBaseName(…)}.glb` — kebab ASCII — but it is whitelisted here
 * anyway, so a hostile name can never end the comment or inject markup.
 */
import { MODEL_SRC } from './glbShaderContract';

/** The `shader` src that runs the module inside the model. === glbShaderContract MODEL_SRC (loader-pinned). */
export const GLB_SRC_MODEL: typeof MODEL_SRC = MODEL_SRC;

/** Where the A-Frame snippet puts the model — the A-Frame tab's object position. */
export const GLB_ENTITY_POSITION = '0 1.6 -3';

const FALLBACK_GLB_FILE = 'model.glb';

/** Same whitelist as tslToAFrameHTML's safeShaderFile: nothing outside `[A-Za-z0-9._-]` survives. */
export function safeGlbFileName(name: string): string {
  const clean = String(name ?? '').replace(/[^A-Za-z0-9._-]/g, '');
  return /\.glb$/i.test(clean) && clean !== '.glb' ? clean : FALLBACK_GLB_FILE;
}

/** The entity that runs a single-GLB export on an A-Frame page. */
export function glbAFrameSnippet(glbFile: string): string {
  const file = safeGlbFileName(glbFile);
  return `<a-entity gltf-model="url(${file})" shader="src: ${GLB_SRC_MODEL}" position="${GLB_ENTITY_POSITION}"></a-entity>`;
}

/** Module-header block, GLB mode only. Six `//` lines, ASCII, no brace, no comment closer, no `import`. */
export function glbModuleHeaderLines(glbFile: string): string[] {
  const file = safeGlbFileName(glbFile);
  return [
    `// This module rides INSIDE ${file} (a FastShaders single-GLB export).`,
    '// Run it with a-frame-shaderloader 0.8 or later:',
    `//   ${glbAFrameSnippet(file)}`,
    '// Loader 0.6 cannot: it reads `src: model` as a file path, logs a shader-error',
    '// and the model keeps its own PBR materials. Use src: model only for .glb files',
    '// you trust: it runs the code carried inside the model.',
  ];
}
