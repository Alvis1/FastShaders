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

import { buildShaderModule, type MaterialPartsMirrorEntry } from './tslCodeProcessor';
import { THREE_REVISION } from './threeRevision';
import { sanitizeIdentifier } from '@/utils/nameUtils';
import { soundUniformNamesIn } from '@/utils/soundAnalysis';
import type { MaterialSettings } from '@/types';
import { glbModuleHeaderLines } from './glbUsage';

export interface ShaderModuleOptions {
  /**
   * The single-GLB export's file name (`<base>.glb`): the module rides INSIDE
   * that file, so its header gains the GLB usage block (engine/glbUsage.ts)
   * above the plain-three block. Absent = the `.js` export, byte-identical to
   * before the option existed.
   */
  glbFile?: string;
}

export interface PropertyInfo {
  name: string;
  type: 'float' | 'color';
  /** float → number; color → '#rrggbb' hex string. */
  defaultValue: number | string;
}

// CDN base for the a-frame-shaderloader project. Pinned to @master — that is
// the repo's default branch (it has no `main`), so jsdelivr serves the vendored
// scripts the exported shader references.
// Exported so the A-Frame index.html preview (tslToAFrameHTML.ts) points at the
// same base and loader version this header documents — one source of truth.
export const CDN_BASE = 'https://cdn.jsdelivr.net/gh/Alvis1/a-frame-shaderloader@master/js';

/**
 * The loader version a NEW export tells its embedding page to load.
 *
 * Every new export references 0.8 — deliberately unconditional. It is also the
 * loader every surface that runs a module loads (the preview and its XR popup
 * through `resolveAssetUrl`, the A-Frame tab through CDN_BASE, podest's stage
 * and VR popup by a literal pinned to this constant), so the editor never
 * previews on one loader while the file it hands the user runs another. Since
 * 0.8 the pin is correctness and not only parity: 0.8 carries what 0.6 lacks —
 * the plain-three.js FastShaders core, the GLTFLoader plugin and `materialParts`
 * dispatch. Shaders exported BEFORE this keep referencing 0.4/0.5/0.6 by URL and
 * are unaffected — which is exactly why those files are frozen, and why this
 * constant is a version string rather than an edit to one.
 *
 * NB the CDN serves @master, so a bumped version here is only real once the
 * submodule is pushed AND jsdelivr is purged for the new file — otherwise every
 * export 404s for its recipient while working perfectly for the author.
 */
export const LOADER_FILE = 'a-frame-shaderloader-0.8.js';

/**
 * Schema keys the `shader` component already owns, so a property that
 * sanitizes to one of them can never be set from an `<a-entity>` attribute.
 *
 * A-Frame's style parser is LAST-WINS over `;`-separated chunks
 * (aframe/src/utils/styleParser.js), so printing such a row after `src:` does
 * not merely fail to set the uniform — it REPLACES the module path with the
 * property's default, and the entity loads no shader at all. Both surfaces
 * that write an `<a-entity …>` example — this header and the A-Frame tab's
 * generated page (tslToAFrameHTML.ts) — drop the row for that reason.
 */
export const RESERVED_ATTRIBUTE_KEYS: ReadonlySet<string> = new Set(['src']);

/** Build the usage-comment header prepended to the exported module. */
function buildHeader(props: PropertyInfo[], tslCode = '', opts: ShaderModuleOptions = {}): string[] {
  // Sanitized identifiers are the actual schema keys / a-entity attributes the
  // module exposes (a property named "my speed" → `my_speed`). Deduped so two
  // names that collapse to the same key don't print twice, and stripped of the
  // component's own keys — see RESERVED_ATTRIBUTE_KEYS.
  //
  // Computed BEFORE the branch below, not inside it: a shader whose only
  // property is named `src` has `props.length > 0` but nothing printable, and
  // the old `hasProps` would have emitted a dangling `shader="src: shader.js; "`
  // followed by an empty "can be updated at runtime" list.
  const seenKeys = new Set<string>();
  const uniqueProps = props.filter((p) => {
    const key = sanitizeIdentifier(p.name);
    if (seenKeys.has(key) || RESERVED_ATTRIBUTE_KEYS.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  const hasProps = uniqueProps.length > 0;
  const header: string[] = [
    '// TSL Shader Module — for use with a-frame-shaderloader',
    '//',
    '// HTML setup — these two scripts are all you need (no import map, no shim):',
    `//   a-frame-180-a-01.min.js = A-Frame 1.8.0 + Three.js r${THREE_REVISION} (WebGPU) bundle`,
    `//   ${LOADER_FILE} rewrites the three/tsl import to that bundle`,
    `//   <script src="${CDN_BASE}/a-frame-180-a-01.min.js"><${''}/script>`,
    `//   <script src="${CDN_BASE}/${LOADER_FILE}"><${''}/script>`,
  ];
  if (hasProps) {
    // `defaultValue` comes straight out of node `values` (adversarial:
    // .fastshader / fs:graph / pasted TSL). The colour branch of
    // collectShaderProperties is a RAW `String(values.hex)`, so a stored hex
    // carrying a NEWLINE ends this `//` comment and injects a real top-level
    // statement into the downloaded module. Same whitelist as graphToCode's
    // hexLiteral; a legit `#rrggbb` / finite number prints byte-identically.
    const safeDefault = (p: PropertyInfo): string =>
      typeof p.defaultValue === 'string'
        ? (/^#[0-9a-fA-F]{6}$/.test(p.defaultValue) ? p.defaultValue : '#000000')
        : String(Number.isFinite(Number(p.defaultValue)) ? Number(p.defaultValue) : 0);
    const propExample = uniqueProps
      .map((p) => `${sanitizeIdentifier(p.name)}: ${safeDefault(p)}`)
      .join('; ');
    header.push(`//   <a-entity shader="src: shader.js; ${propExample}"></a-entity>`);
    header.push('//');
    header.push('// Properties can be updated at runtime:');
    for (const p of uniqueProps) {
      header.push(`//   el.setAttribute('shader', { ${sanitizeIdentifier(p.name)}: value });`);
    }
  } else {
    header.push('//   <a-entity shader="src: shader.js"></a-entity>');
  }
  header.push('//');
  // GLB mode only: the module rides inside a .glb and runs through
  // `src: model`, and the block that says so sits ABOVE the plain-three block,
  // so every "within N lines of the plain-three block" pin keeps its anchor.
  if (opts.glbFile !== undefined) {
    header.push(...glbModuleHeaderLines(opts.glbFile));
    header.push('//');
  }
  // Plain three.js, unconditionally so every export carries the same block.
  // It names only the FastShaders core calls loader 0.8 defines (use / load /
  // apply — loaderSwitch.test.ts checks them against the served file) and not
  // the loader's FILE, so a loader bump never has to touch it. Wording rules
  // (pinned in tslToShaderModule.test.ts, run against the real 0.5, 0.6 and 0.8
  // loaders in shaderloaderTransform.test.ts): autoInjectTSLImports matches an
  // UNANCHORED `import\s*{` on the raw source, comments included, and
  // autoDetectSchema scans for `params.<name>` — so no line here may spell an
  // import brace, a params member or a `uniform(` declaration. (Call syntax is
  // safe: autoInjectTSLImports strips `//` comments before it scans for calls.)
  header.push(`// Plain Three.js r${THREE_REVISION} (no A-Frame): put the same loader script on the page,`);
  header.push('// then FastShaders.use(THREE) with the three/webgpu namespace and');
  header.push("// FastShaders.apply(mesh, await FastShaders.load('shader.js')). The loader");
  header.push('// builds the uniforms and the material, applies `parts`, the weld and corners.');
  header.push('// Without the loader the module still imports THREE and every TSL function it');
  header.push('// calls, and you redo that material work by hand. Recipe:');
  header.push('// https://github.com/Alvis1/FastShaders#using-the-shader-module-with-plain-threejs');
  if (tslCode.includes('data:image/')) {
    header.push('//');
    header.push('// This shader embeds image texture(s) as data: URLs. If the host page sets a');
    header.push('// Content-Security-Policy, its img-src directive must allow data:.');
  }
  // Live-audio properties (Mic node AND Audio Input node) are ordinary numbers
  // here and nothing drives them, so an undriven download renders as permanent
  // silence. Saying so — and saying exactly how to fix it — is the difference
  // between a documented boundary and a recipient debugging a shader that looks
  // broken with no error anywhere.
  const micNames = soundUniformNamesIn(tslCode);
  if (micNames.length > 0) {
    header.push('//');
    header.push('// LIVE AUDIO INPUT — this file does NOT capture audio.');
    header.push(`// It exposes ${micNames.join(', ')} as ordinary number properties, all starting`);
    header.push('// at 0 (silence). FastShaders drives them only inside its own editor preview;');
    header.push('// here, the embedding page has to drive them. Roughly:');
    header.push('//   const ac = new AudioContext();');
    header.push('//   const stream = await navigator.mediaDevices.getUserMedia({ audio: true });');
    header.push('//   const an = ac.createAnalyser(); an.fftSize = 1024;');
    header.push('//   ac.createMediaStreamSource(stream).connect(an);');
    header.push('//   const bins = new Uint8Array(an.frequencyBinCount);');
    header.push('//   (function tick() {');
    header.push('//     requestAnimationFrame(tick);');
    header.push('//     an.getByteFrequencyData(bins);');
    header.push('//     let s = 0; for (const v of bins) s += v;');
    header.push(`//     el.setAttribute('shader', { ${micNames[0]}: s / bins.length / 255 });`);
    header.push('//   })();');
    header.push('// getUserMedia needs a secure context (https or localhost) and a user gesture.');
    header.push('// For an `aud*` property the source was tab/system audio or a chosen input:');
    header.push('// swap the getUserMedia line for navigator.mediaDevices.getDisplayMedia({');
    header.push('//   audio: true, video: true }) — video is required by the spec — or pass an');
    header.push('// exact deviceId. Everything after that line is identical.');
  }
  return header;
}

export function tslToShaderModule(
  tslCode: string,
  materialSettings?: MaterialSettings,
  properties?: PropertyInfo[],
  /** The Output's loader-0.6 mirror plan (`materialPartsMirrorPlan`) — the
   *  SAME plan every module path passes, so the export is what the preview
   *  ran. Absent = no mirrors, byte-identical to before. */
  materialPartsMirror?: readonly MaterialPartsMirrorEntry[],
  opts: ShaderModuleOptions = {},
): string {
  const props = properties ?? [];
  return buildShaderModule(tslCode, {
    materialSettings,
    header: buildHeader(props, tslCode, opts),
    properties: props,
    ...(materialPartsMirror && materialPartsMirror.length > 0 ? { materialPartsMirror } : {}),
  });
}
