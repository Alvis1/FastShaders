/**
 * The sampled-texture budget of one generated module, announced IN THE CODE.
 *
 * WebGPU's default `maxSampledTexturesPerShaderStage` is 16 (WebGL2's
 * MAX_TEXTURE_IMAGE_UNITS floor is the same 16), and every Image, Colormap,
 * Data/Stripes column, environment map, Color Ramp and RGB Curves table spends
 * one binding. Past it the preview fails to compile with only the raw error
 * overlay — so graphToCode counts and, over the limit, says so in a comment
 * above the shader Fn (the "every limit announces itself" rule; the rejected-
 * ramp comment's precedent). The LUT editors read the same line back from the
 * code (`TEXTURE_BUDGET_MARK`) to show their notice.
 *
 * The count is PER MATERIAL — each Output's material is compiled on its own,
 * so two materials' textures never meet in one stage — and only what that
 * material READS: the textures reachable from its channels through the body's
 * `const` definitions (an unconnected node is emitted but never bound). It is
 * textual: every distinct identifier read as `texture(<id>` in the reachable
 * statements, plus the distinct `fsLut.make` keys of the reachable LUT nodes
 * (their texture is made inside the helper, so it never appears as a
 * `texture(` call in the body). Stages are not told apart, so a material's
 * count is an upper bound on any one of its stages. The module's figure is the
 * largest material's.
 *
 * three.js spends one binding of its own on a lit material (r184's
 * MeshPhysicalNodeMaterial samples its DFG lookup table — measured with the
 * WGSL and GLSL builders: 16 module textures bind 17), so the comment fires
 * from 16, not 17 (`THREE_RESERVED_TEXTURES`). A custom sink may be unlit and
 * get one comment too many at exactly 16; the other way round, the comment is
 * missing where the shader breaks.
 *
 * The comment is emitted ONLY at or over the budget, so every module under it
 * — every snapshot — is byte-identical to before. Line comments are stripped by
 * the loader's import scan, so its words cannot become imports.
 */

export const SAMPLED_TEXTURE_STAGE_LIMIT = 16;

/** Sampled textures three.js binds on its own in a lit material (the DFG lookup table). */
export const THREE_RESERVED_TEXTURES = 1;

/** The fixed head of the comment — what the editors look for in the code. */
export const TEXTURE_BUDGET_MARK = '// texture budget:';

const TEXTURE_READ_RE = /\btexture\(\s*([A-Za-z_$][\w$]*)/g;

/** Distinct texture objects a shader body reads, plus `lutKeys` distinct baked tables. */
export function countSampledTextures(bodyLines: readonly string[], lutKeys: number): number {
  const names = new Set<string>();
  for (const block of bodyLines) {
    for (const line of block.split('\n')) {
      if (line.trimStart().startsWith('//')) continue;
      for (const m of line.matchAll(TEXTURE_READ_RE)) names.add(m[1]);
    }
  }
  return names.size + lutKeys;
}

/** A top-level body definition: graphToCode emits every node as `  const <name> = …`, two spaces in. */
const DEF_RE = /^ {2}const ([A-Za-z_$][\w$]*)\s*=/;
/** Any other top-level statement (two spaces in, not a closer or a comment) declares nothing a material can name. */
const LOOSE_RE = /^ {2}[^\s/})\]]/;
/** String literals are data: a canonical ramp string must not name a body variable. */
const STRING_RE = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
/** Word tokens, each with the `.` before it if any — a member name (`.rgb`, `.mul`) or a number is not a name. */
const TOKEN_RE = /\.?[\w$]+/g;

function identifiersOf(text: string): string[] {
  const code = text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n')
    .replace(STRING_RE, '""');
  return (code.match(TOKEN_RE) ?? []).filter((tok) => !/^[.\d]/.test(tok));
}

/**
 * The body split into its top-level statements: each `const` definition with
 * every line indented under it (a scope Fn's body, a multi-line call), and the
 * LOOSE statements that define nothing — those are counted for every material.
 */
function bodyStatements(body: readonly string[]): { defs: Map<string, string[]>; loose: string[] } {
  const defs = new Map<string, string[]>();
  const loose: string[] = [];
  let current: string[] = loose;
  for (const block of body) {
    for (const line of block.split('\n')) {
      const def = DEF_RE.exec(line);
      if (def) {
        current = [];
        defs.set(def[1], current);
      } else if (LOOSE_RE.test(line)) {
        current = loose;
      }
      current.push(line);
    }
  }
  return { defs, loose };
}

/**
 * The sampled textures of the module's busiest material.
 *
 * @param body       the shader Fn's flat body (graphToCode's `mainLines`)
 * @param materials  per material, the code it reads directly: its channel expressions, its discard, or — for a
 *                   custom sink — its whole program
 * @param lutKeyOf   body variable → the `fsLut.make` key of the table it bakes (equal keys share one texture)
 */
export function maxMaterialSampledTextures(
  body: readonly string[],
  materials: readonly (readonly string[])[],
  lutKeyOf: ReadonlyMap<string, string>,
): number {
  const { defs, loose } = bodyStatements(body);
  let max = 0;
  for (const roots of materials) {
    const reached = new Set<string>();
    const lines: string[] = [...roots, ...loose];
    const queue: string[] = [...lines];
    while (queue.length > 0) {
      for (const id of identifiersOf(queue.pop()!)) {
        if (reached.has(id)) continue;
        reached.add(id);
        const def = defs.get(id);
        if (def) {
          lines.push(...def);
          queue.push(...def);
        }
      }
    }
    const keys = new Set<string>();
    for (const id of reached) {
      const key = lutKeyOf.get(id);
      if (key !== undefined) keys.add(key);
    }
    max = Math.max(max, countSampledTextures(lines, keys.size));
  }
  return max;
}

/** The comment line, or null while the material's textures plus three's own fit a stage (nothing is emitted). */
export function textureBudgetLine(count: number): string | null {
  if (!(count + THREE_RESERVED_TEXTURES > SAMPLED_TEXTURE_STAGE_LIMIT)) return null;
  return `${TEXTURE_BUDGET_MARK} ${count} textures in one material, and three.js may add one for lighting; a stage can read at most ${SAMPLED_TEXTURE_STAGE_LIMIT}, so the preview may fail to compile`;
}
