/**
 * Builds the copy-ready `index.html` the code panel's A-Frame tab shows: a
 * minimal, VR-ready A-Frame page that loads the exported shader module from the
 * SAME directory.
 *
 * Three rules shape it:
 *
 *  1. **The shader is a sibling source file.** The page references `<name>.js`
 *     with a bare relative path, so dropping the exported module next to this
 *     `index.html` is the whole install step. A-Frame, three and the
 *     shaderloader come from the jsdelivr base the module's own usage header
 *     names.
 *
 *  2. **Every uniform is listed, and it is read off the module itself.** The
 *     rows come from parsing the `export const schema = { … }` block
 *     `buildShaderModule` emits (tslCodeProcessor.ts:887-901) rather than from a
 *     second walk of the node graph. That block IS the loader's uniform
 *     contract — declared properties, colours and live-audio channels all land
 *     in it — so a page built from it cannot list a uniform the shader doesn't
 *     have, or miss one it does.
 *
 *  3. **A-Frame defaults, nothing else — with FOUR exceptions.** No comments, no
 *     light rig, no background, no camera rig, no orbit-controls: the default
 *     camera (eye height, look/wasd controls), the default lighting and the
 *     default `vr-mode-ui` Enter-VR button are what the page is meant to use,
 *     and the object sits at `0 1.6 -3` — eye height, three metres out —
 *     because the page is expected to be entered in VR. The editor preview's
 *     own lighting, background and spin are deliberately NOT mirrored; only
 *     the primitive follows what the preview is showing.
 *
 *     The first exception is TESSELLATION FOR A DISPLACEMENT SHADER, and it is a
 *     correctness fix rather than a taste one. `<a-plane>` and `<a-box>`
 *     default to ONE segment per axis (aframe/src/geometries/plane.js, box.js),
 *     so a plane is four vertices sharing one normal: a `positionNode` has
 *     nothing to move and the relief the editor shows vanishes completely —
 *     not "coarser", absent. `<a-sphere>`'s 36x18 survives but is visibly
 *     blockier than the preview. So when the module declares a `positionNode`
 *     — this file's own `/positionNode\s*:/` predicate; the loader answers the
 *     same question structurally, off the BUILT material, which is a luxury
 *     only it has — the primitive gets explicit segment attributes and nothing
 *     else changes. A-Frame maps the
 *     hyphenated form onto `geometry.*` for every primitive
 *     (extras/primitives/primitives/meshPrimitives.js), and the schema's
 *     `max: 20` is inspector metadata that nothing enforces — the app's own
 *     preview already passes 64-256 through the same field.
 *
 *     A displaced `<a-box>` used to split at its 12 shared edges here —
 *     BoxGeometry duplicates those positions with per-face normals at ANY
 *     segment count, so each face slid outward along its own normal — and the
 *     fix could not be inlined without costing the page its whole reason to
 *     exist. It is fixed now because the loader (0.6 and 0.8) welds those vertices
 *     itself, which this page gets for free: it already loads the loader.
 *     Spheres and planes were never affected (their duplicate positions share
 *     normals, so the loader's weld correctly leaves them alone).
 *
 *     The THIRD exception is the SINGLE-GLB export (`modelFile`): the page
 *     hangs `shader="src: model"` on `<a-entity gltf-model="url(<name>.glb)">`
 *     instead of a primitive, because the export IS the model — so it carries
 *     no segments and no radius, and everything else (the scene, the backend,
 *     the two scripts, the uniform rows) is unchanged. It needs loader 0.8:
 *     0.6 reads `src: model` as a path, logs a shader-error and leaves the
 *     model on its own materials, which is why the tab's label names the
 *     version. The Three.js tab stays on the primitive.
 *
 *     The FOURTH exception is the BUNDLE'S MODEL (`bundledModel`): when the
 *     file the EXPORT button writes is a `.zip` carrying a model under
 *     `models/` that no primitive reproduces — a dropped OBJ (or an
 *     unpackable glTF) on screen, since EXPORT is contextual and a packable
 *     glTF/GLB on screen makes it the `.glb` above — the page hangs the
 *     sibling `.js` on `<a-entity obj-model="obj: url(models/<file>)">` (or
 *     `gltf-model="url(…)"`), the pairing the README's `meshPairingSnippet`
 *     spells. Before this the page put the shader on a sphere while the
 *     `.zip` beside it held the model it was made for. The file named is the
 *     one the EXPORT BUTTON writes (`bundledModelForPage` over
 *     engine/exportModel.ts's `exportModelChoice(…, 'primary')`), so a
 *     built-in shape — whose `.obj` only the popover's "Export with model"
 *     ships — keeps the primitive page. The N1 pre-flight's "without the 3D
 *     model" answer is the one way that download can still lack the file. No
 *     segments and no radius, as for the `.glb`. Loader 0.8 hooks A-Frame's
 *     own `gltf-model` (plugin + decoders), so material-index sections apply
 *     on a glTF page too. What the page does NOT reproduce is the preview's
 *     `fit-bounds` repair, which only the preview runs: the model shows at
 *     its AUTHORED size; a bare OBJ keeps OBJLoader's flat per-face normals
 *     and is never welded (the loader welds primitives only), so a
 *     displacement tears it; a model with no UVs reads `uv()` as 0; a
 *     clockwise OBJ renders inside-out. The `.glb` page and the README
 *     snippet share every one of those.
 *
 *     A GAUSSIAN SPLAT is deliberately NOT a fifth exception. With a splat
 *     scene in the preview (or a Splat Output driving) this page still hangs
 *     the module on the sphere every model geometry falls back to, with the
 *     same two scripts — byte-identical to the page for that module on any
 *     other model (`primitiveOf` / `isModelGeometry` below, and
 *     `bundledModelForPage`, which returns null for every splat kind — the
 *     ONE guard keeping a `.ply`/`.spz` out of `gltf-model="url(…)"`). Describing a splat would add a THIRD
 *     script (`fs-splat-0.1.js`, after the A-Frame bundle), a `splat-model`
 *     entity and a model file the page does not have beside it — a whole
 *     second setup, where this page is the defaults-only one. The splat
 *     pairing is documented where the scene file actually ships instead: the
 *     bundle export's README (`meshPairingSnippet` in utils/exportBundle.ts —
 *     the runtime tag plus `splat-model="src: url(models/<name>); kind: …;
 *     size: 1.6"`), and dropping that zip into Podest shows it.
 *
 * The page carries NO script of its own. The VR promise rides rule 3's SECOND
 * deliberate exception instead: `<a-scene renderer="backend: webgl">`. The
 * bundle carries aframevr/aframe#5847's `backend` renderer property (applied
 * by a-frame-shaderloader/build/build.mjs, guarded by
 * aframeBackendProperty.test.ts), which maps onto `WebGPURenderer`'s
 * `forceWebGL` BEFORE the renderer is constructed — three r184 otherwise
 * picks its WebGPU backend on `navigator.gpu != null` alone, and that backend
 * hard-throws in XRManager.setSession, so Enter VR dies with it. WebGL2
 * compiles the same TSL through GLSLNodeBuilder and is the only backend that
 * can present to a headset. The SPELLING is load-bearing: the patched branch
 * runs only when the raw attribute contains `backend:` and forces only on the
 * exact value `webgl` — a typo silently does nothing and VR throws again.
 * This replaced an inline navigator.gpu-hiding script (2026-08-31); pages
 * exported before then still carry that script and keep working, because
 * hiding gpu and forcing WebGL compose to the same backend.
 */

import { isModelGeometry, escapeHtml, type GeometryType } from './tslToPreviewHTML';
import { CDN_BASE, LOADER_FILE, RESERVED_ATTRIBUTE_KEYS } from './tslToShaderModule';
import { GLB_ENTITY_POSITION, safeGlbFileName } from './glbUsage';
import { MODEL_SRC } from './glbShaderContract';
import { HEX6 } from '@/utils/colorUtils';

/** One row of the module's exported `schema` — i.e. one `shader` attribute. */
export interface EmbedUniform {
  name: string;
  type: 'number' | 'color';
  /** Already normalized for direct interpolation into the attribute. */
  defaultValue: string;
}

export interface AFrameEmbedOptions {
  /** Module file name, assumed to sit in the same directory as the page. */
  shaderFile: string;
  /** Document title — the shader's display name. */
  title?: string;
  /** Which primitive to put the shader on; model geometries fall back to a sphere. */
  geometry?: GeometryType;
  /** The Raymarch Output's Window radius (marchSphere only). */
  marchWindow?: number;
  /**
   * The single-GLB export: hang `src: model` on a `gltf-model` entity instead
   * of a primitive, because the export IS the model. Absent = today's page,
   * byte for byte.
   */
  modelFile?: string;
  /**
   * The model the `.zip` export ships under `models/` (`bundledModelForPage`):
   * hang the sibling `.js` on that model instead of a primitive. Ignored when
   * `modelFile` is set. Absent = today's page, byte for byte.
   */
  bundledModel?: AFrameBundledModel | null;
}

/** A model file the bundle export ships under `models/`, as the page loads it. */
export interface AFrameBundledModel {
  /** The `models/` entry's file name (engine/exportModel.ts `exportModelFile`). */
  file: string;
  kind: 'glb' | 'gltf' | 'obj';
}

/**
 * The shapes an A-Frame primitive reproduces. Their `.obj` may ship too
 * ("Export with model"), but the page keeps the primitive: it is tessellated for a
 * displacing shader and the loader WELDS a primitive, never a model — a
 * displaced `cube.obj` would split at its edges where `<a-box>` does not.
 */
const PRIMITIVE_SHAPES: ReadonlySet<string> = new Set(['sphere', 'cube', 'plane', 'marchSphere']);

/**
 * The `models/` file the page loads instead of a primitive, or null for the
 * primitive page. `file` is what EXPORT writes (`exportModelFile` over
 * `exportModelChoice`, the decision the download itself builds from), so the
 * page never names a file the `.zip` lacks; `builtinShape` is the built-in
 * shape it was written from, null for a dropped model. A Gaussian splat is
 * null on purpose: see the header.
 */
export function bundledModelForPage(
  file: { name: string; kind: string } | null,
  builtinShape: string | null,
): AFrameBundledModel | null {
  if (!file || (builtinShape !== null && PRIMITIVE_SHAPES.has(builtinShape))) return null;
  const kind = file.kind;
  return kind === 'glb' || kind === 'gltf' || kind === 'obj' ? { file: file.name, kind } : null;
}

/**
 * The `models/` entry as written into `url(…)`. The name was sanitized when
 * the model was dropped (previewMesh's `sanitizeMeshFileName`), but a restored
 * session record is someone's data, so the `.js` name's whitelist is applied
 * again — a no-op on every name the app itself mints.
 */
function safeModelFile(name: string, kind: AFrameBundledModel['kind']): string {
  const cleaned = String(name ?? '').replace(/[^A-Za-z0-9._-]/g, '');
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : `model.${kind}`;
}

const SCHEMA_OPEN = 'export const schema = {';

// The two line forms tslCodeProcessor emits, and nothing else. Values are
// re-normalized below rather than trusted: a property default rides in from
// adversarial input (.fastshader / pasted TSL), and these land in an HTML
// attribute.
const SCHEMA_COLOR_RE = /^\s*([A-Za-z_$][\w$]*):\s*\{\s*type:\s*'color',\s*default:\s*'([^']*)'\s*\},?\s*$/;
const SCHEMA_NUMBER_RE = /^\s*([A-Za-z_$][\w$]*):\s*\{\s*type:\s*'number',\s*default:\s*([^,}]*?)\s*\},?\s*$/;

/**
 * The uniforms a generated shader module declares, in emitted order.
 *
 * Returns `[]` for a module with no properties — `buildShaderModule` omits the
 * whole `schema` block in that case (`hasParams`), and the page then carries a
 * bare `shader="src: …"`.
 */
export function parseShaderModuleSchema(moduleSource: string): EmbedUniform[] {
  const lines = moduleSource.split('\n');
  const start = lines.findIndex((l) => l.trim() === SCHEMA_OPEN);
  if (start === -1) return [];
  const out: EmbedUniform[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '};') break;
    const c = SCHEMA_COLOR_RE.exec(lines[i]);
    if (c) {
      out.push({
        name: c[1],
        type: 'color',
        defaultValue: HEX6.test(c[2]) ? c[2].toLowerCase() : '#000000',
      });
      continue;
    }
    const n = SCHEMA_NUMBER_RE.exec(lines[i]);
    if (n) {
      const v = Number(n[2]);
      out.push({ name: n[1], type: 'number', defaultValue: String(Number.isFinite(v) ? v : 0) });
    }
  }
  return out;
}

/**
 * The module file name as written into `src:`. Export names come from
 * `toKebabCase`, but this page is also the one artefact a user hand-edits, so
 * anything outside a plain file name is dropped rather than escaped — a `src`
 * with a quote or a path traversal in it is never what was meant: only the
 * last path segment is read. Shared with the Three.js page (threeEmbed.test.ts).
 */
export function safeShaderFile(name: string): string {
  const base = String(name || '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '');
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'shader.js';
}

/**
 * The A-Frame primitive to hang the shader on. A model-backed preview whose
 * model the export does not ship (`bundledModel` absent) has no sibling model
 * file, so it falls back to the sphere.
 */
function primitiveOf(geometry: GeometryType | undefined): 'a-sphere' | 'a-box' | 'a-plane' {
  if (geometry === 'cube') return 'a-box';
  if (geometry === 'plane') return 'a-plane';
  return 'a-sphere';
}

/**
 * Segments per axis for a displacement shader. Matches the preview panel's own
 * default (`SUBDIVISION_DEFAULT`, ShaderPreview.tsx), so the copied page shows
 * the relief at the density the editor showed it at.
 */
const DISPLACEMENT_SEGMENTS = 64;

/**
 * True when the module drives vertex positions. Only the loader can answer it
 * off the built material, so a page built from source text reads the text.
 */
export function hasDisplacement(moduleSource: string): boolean {
  return /positionNode\s*:/.test(moduleSource);
}

/** The hyphenated segment attributes A-Frame maps onto `geometry.segments*`. */
function segmentAttributes(tag: string): string[] {
  const n = DISPLACEMENT_SEGMENTS;
  const attrs = [`segments-width="${n}"`, `segments-height="${n}"`];
  if (tag === 'a-box') attrs.push(`segments-depth="${n}"`);
  return attrs;
}

/**
 * The preview panel's current primitive — the ONE editor setting the page
 * mirrors. It lives in localStorage (ShaderPreview's `usePersistedState` owns
 * it), so this reads the key directly, the idiom exportShader's
 * `buildProjectState` and FeedbackModal already use. Anything unrecognized is
 * narrowed to the sphere by `primitiveOf`.
 */
export function readPreviewGeometry(): GeometryType | undefined {
  try {
    return (localStorage.getItem('fs:previewGeometry') ?? undefined) as GeometryType | undefined;
  } catch {
    return undefined;
  }
}

export function buildAFrameEmbedHTML(
  moduleSource: string,
  options: AFrameEmbedOptions,
): string {
  const uniforms = parseShaderModuleSchema(moduleSource)
    .filter((u) => !RESERVED_ATTRIBUTE_KEYS.has(u.name));
  const file = safeShaderFile(options.shaderFile);
  const title = escapeHtml(options.title?.trim() || file);
  // The single-GLB page: one gltf-model entity, and `src: model` in place of
  // the sibling `.js`. Whitelisted through the SAME rule the header block and
  // the README snippet use (engine/glbUsage.ts), so one hostile name cannot
  // spell one thing here and another there.
  const modelFile = options.modelFile === undefined ? null : safeGlbFileName(options.modelFile);
  // The bundle's model: the sibling `.js` on the `models/` file the `.zip`
  // carries. Its loader attribute is the one A-Frame's own component for that
  // format takes (the same spelling as the README's `meshPairingSnippet`).
  const bundled = modelFile || !options.bundledModel ? null : options.bundledModel;
  const bundledAttr = bundled
    ? bundled.kind === 'obj'
      ? `obj-model="obj: url(models/${safeModelFile(bundled.file, 'obj')})"`
      : `gltf-model="url(models/${safeModelFile(bundled.file, bundled.kind)})"`
    : null;
  const onModel = modelFile !== null || bundledAttr !== null;
  const src = modelFile ? MODEL_SRC : file;
  const tag = onModel
    ? 'a-entity'
    : primitiveOf(isModelGeometry(options.geometry ?? 'sphere') ? 'sphere' : options.geometry);

  const L: string[] = [];
  L.push('<!DOCTYPE html>');
  L.push('<html lang="en">');
  L.push('<head>');
  L.push('  <meta charset="utf-8">');
  L.push(`  <title>${title}</title>`);
  L.push(`  <script src="${CDN_BASE}/a-frame-180-a-01.min.js"><${''}/script>`);
  L.push(`  <script src="${CDN_BASE}/${LOADER_FILE}"><${''}/script>`);
  L.push('</head>');
  L.push('<body>');
  // The backend force — the page's one non-default setting; see the header.
  L.push('  <a-scene renderer="backend: webgl">');

  // Both continuation indents are DERIVED from the opening tag, not counted by
  // hand: `attrCol` puts each later attribute under `position=`, and `valueCol`
  // puts each uniform under `src:`. A literal here would silently misalign the
  // moment the tag changes length (a-sphere / a-box / a-plane).
  const attrCol = ' '.repeat(4 + 1 + tag.length + 1);
  const valueCol = ' '.repeat(attrCol.length + 'shader="'.length);
  const leading = modelFile
    ? [`gltf-model="url(${modelFile})"`, `position="${GLB_ENTITY_POSITION}"`]
    : bundledAttr
      ? [bundledAttr, `position="${GLB_ENTITY_POSITION}"`]
      : [`position="${GLB_ENTITY_POSITION}"`];
  // A model brings its own geometry: no segments (a model is never
  // tessellated) and no window radius.
  if (!onModel) {
    // The march window: a sphere of the Raymarch Output's Window radius.
    if (options.geometry === 'marchSphere') leading.push(`radius="${Number.isFinite(options.marchWindow) && options.marchWindow! > 0 ? options.marchWindow : 1}"`);
    if (hasDisplacement(moduleSource)) leading.push(segmentAttributes(tag).join(' '));
  }

  if (uniforms.length === 0 && (leading.length === 1 || onModel)) {
    L.push(`    <${tag} ${leading.join(' ')} shader="src: ${src}"></${tag}>`);
  } else {
    L.push(`    <${tag} ${leading[0]}`);
    for (const attr of leading.slice(1)) L.push(`${attrCol}${attr}`);
    if (uniforms.length === 0) {
      L.push(`${attrCol}shader="src: ${src}"></${tag}>`);
    } else {
      // Every uniform the module declares, on its own line so a value can be
      // edited in place. A-Frame's style parser trims each `;`-separated chunk
      // (utils/styleParser.js), so the newlines and indentation are inert.
      L.push(`${attrCol}shader="src: ${src};`);
      uniforms.forEach((u, i) => {
        const last = i === uniforms.length - 1;
        L.push(`${valueCol}${u.name}: ${u.defaultValue}${last ? `"></${tag}>` : ';'}`);
      });
    }
  }
  L.push('  </a-scene>');
  L.push('</body>');
  L.push('</html>');
  return L.join('\n') + '\n';
}
