/**
 * Does a module's DISPLACEMENT read uv? Decides loader 0.8's `uvDisplaced:
 * false` (buildShaderModule).
 *
 * The loader welds a displaced primitive's coincident vertices so it deforms
 * as one skin, and it merges a sphere's u=0/u=1 seam and pole fans only when a
 * uv-driven height could pull them apart. It can ask only the module SOURCE,
 * so ANY uv() answers yes — including a uv() that only drives COLOUR, where
 * the merge buys nothing and costs the seam: a welded vertex keeps one u, and
 * the strip beside the seam squeezes the whole texture into one column. The
 * editor has the text of every line, so it traces what the `position` channel
 * actually reads and tells the loader when that is no uv at all.
 *
 * CONSERVATIVE by construction — every doubt answers `true`, which keeps
 * today's weld: a body line that is not a one-line `const x = …` (a statement,
 * a multi-line Fn) stops the trace, and texture samplers count as readers,
 * since `texture(map)` samples at uv() without spelling it.
 */

/** Calls that read the surface's uv, spelled or implied. */
const UV_READER = /\b(?:uv|texture|cubeTexture|textureLoad|textureBicubic|triplanarTexture|triplanarTextures)\s*\(/;
const DEF = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/;
const IDENT = /[A-Za-z_$][\w$]*/g;

export function displacementReadsUv(
  position: string,
  defLines: readonly string[],
  preambleDecls: readonly string[] = [],
): boolean {
  const defs = new Map<string, string>();
  for (const line of defLines) {
    const m = DEF.exec(line);
    if (m && /;\s*(?:\/\/.*)?$/.test(line)) {
      defs.set(m[1], line);
      continue;
    }
    if (!line.trim() || /^\s*\/\//.test(line)) continue;
    return true;
  }
  for (const decl of preambleDecls) {
    const m = DEF.exec(decl);
    if (m) defs.set(m[1], decl);
    else if (decl.trim()) return true;
  }
  if (UV_READER.test(position)) return true;
  const seen = new Set<string>();
  const queue: string[] = [...(position.match(IDENT) ?? [])];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const text = defs.get(name);
    if (text === undefined) continue;
    if (UV_READER.test(text)) return true;
    for (const id of text.slice(text.indexOf('=') + 1).match(IDENT) ?? []) if (!seen.has(id)) queue.push(id);
  }
  return false;
}
