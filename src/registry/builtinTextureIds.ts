/**
 * The built-in texture ids, WITHOUT the library behind them.
 *
 * A LEAF: this module imports nothing. `builtinTextures.ts` holds the eight TSL
 * snippets and builds them through `codeGroupBuilder` → `codeToGraph` →
 * @babel/*, so a static import of it puts the whole Babel front end on the
 * boot wave — and the content browser needs the ids at MODULE SCOPE (whether
 * the Textures tab should exist at all, given which textures
 * `editorVisibility.json` hides). Everything else it needs from the two
 * libraries it loads on demand.
 *
 * The list repeats the ids of `builtinTextures.ts`'s `TEXTURE_ENTRIES`, which
 * has to stay in that file (the node editor's description splice rewrites it in
 * place). `src/bootWave.test.ts` fails when the two disagree, and when any
 * static import path from `main.tsx` reaches a Babel-bearing module again.
 */
const BUILTIN_TEXTURE_IDS: readonly string[] = [
  'polka-dots',
  'grid',
  'tiger-fur',
  'static-noise',
  'crumpled-fabric',
  'gas-giant',
  'marble',
  'wood',
];

/** A fresh array per call, as the accessor in `builtinTextures.ts` always returned. */
export function getBuiltinTextureIds(): string[] {
  return [...BUILTIN_TEXTURE_IDS];
}
