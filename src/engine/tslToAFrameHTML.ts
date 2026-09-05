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
 *  3. **A-Frame defaults, nothing else — with TWO exceptions.** No comments, no
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
 *     exist. It is fixed now because shaderloader 0.6 welds those vertices
 *     itself, which this page gets for free: it already loads the loader.
 *     Spheres and planes were never affected (their duplicate positions share
 *     normals, so the loader's weld correctly leaves them alone).
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
        defaultValue: /^#[0-9a-fA-F]{6}$/.test(c[2]) ? c[2].toLowerCase() : '#000000',
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
 * with a quote or a path traversal in it is never what was meant.
 */
function safeShaderFile(name: string): string {
  const cleaned = (name || '').replace(/[^A-Za-z0-9._-]/g, '');
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'shader.js';
}

/**
 * The A-Frame primitive to hang the shader on. Model-backed previews have no
 * sibling model file, so they fall back to the sphere.
 */
function primitiveOf(geometry: GeometryType | undefined): 'a-sphere' | 'a-box' | 'a-plane' {
  if (geometry === 'cube') return 'a-box';
  if (geometry === 'plane') return 'a-plane';
  return 'a-sphere';
}

/** Eye height, three metres out — where a headset user is already looking. */
const OBJECT_POSITION = '0 1.6 -3';

/**
 * Segments per axis for a displacement shader. Matches the preview panel's own
 * default (`SUBDIVISION_DEFAULT`, ShaderPreview.tsx), so the copied page shows
 * the relief at the density the editor showed it at.
 */
const DISPLACEMENT_SEGMENTS = 64;

/** True when the module drives vertex positions — the preview's own predicate. */
function hasDisplacement(moduleSource: string): boolean {
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
  const tag = primitiveOf(isModelGeometry(options.geometry ?? 'sphere') ? 'sphere' : options.geometry);

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
  const leading = [`position="${OBJECT_POSITION}"`];
  // The march window: a sphere of the Raymarch Output's Window radius.
  if (options.geometry === 'marchSphere') leading.push(`radius="${Number.isFinite(options.marchWindow) && options.marchWindow! > 0 ? options.marchWindow : 1}"`);
  if (hasDisplacement(moduleSource)) leading.push(segmentAttributes(tag).join(' '));

  if (uniforms.length === 0 && leading.length === 1) {
    L.push(`    <${tag} ${leading[0]} shader="src: ${file}"></${tag}>`);
  } else {
    L.push(`    <${tag} ${leading[0]}`);
    for (const attr of leading.slice(1)) L.push(`${attrCol}${attr}`);
    if (uniforms.length === 0) {
      L.push(`${attrCol}shader="src: ${file}"></${tag}>`);
    } else {
      // Every uniform the module declares, on its own line so a value can be
      // edited in place. A-Frame's style parser trims each `;`-separated chunk
      // (utils/styleParser.js), so the newlines and indentation are inert.
      L.push(`${attrCol}shader="src: ${file};`);
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
