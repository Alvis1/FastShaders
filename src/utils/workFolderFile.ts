import { toKebabCase } from './nameUtils';

/**
 * Work-folder file identity — the pure half of the desktop Work folder's
 * "open a shader, edit it, save it back to the SAME file" loop
 * (`components/Layout/WorkFolder.tsx`; the folder itself is owned by
 * `src-tauri/src/work_folder.rs`).
 *
 * WHY THIS EXISTS. Save has always derived its file name from the shader name
 * (`toKebabCase(shaderName) + ext`, engine/exportShader.ts), while LOADING a
 * file restored the name AUTHORED inside it. Those two agree for files this app
 * wrote and diverge for everything else — a file renamed in Finder, a browser
 * download artefact (`waves (1).js`), someone else's export — so opening
 * `waves.js` whose graph is still called "Untitled" and pressing Save wrote
 * `untitled.js` and left `waves.js` stale. The folder forked silently, which is
 * the same divergence the dropdown's file-name-only row already works around.
 *
 * The rule: the name on disk WINS when the two diverge, and the prettier
 * authored name is kept when they are the same identity ("My Shader" for
 * `my-shader.js`). One consequence is deliberate and worth knowing — renaming a
 * file in Finder rewrites the shader's authored name on the next save, and that
 * rewrite is not undoable (`shaderName` is absent from the history snapshot).
 *
 * BOUNDARY: every name returned here is handed to `work_folder_write`, whose
 * `safe_name` gate is the real authority — bare name, no `/ \ : NUL`, no leading
 * dot, `.js`/`.zip` only, no Windows reserved stem, and at most
 * `255 - ".tmp-fastshaders".length` BYTES. Rust's `String::len` is bytes, so the
 * budget here is measured with TextEncoder and NEVER `String.length`: a Latvian
 * name runs up to 2 bytes per character, so a `.length` check waves through
 * names the Rust side then rejects with a bare "invalid file name".
 */

/** `255 - TMP_SUFFIX.len()` in work_folder.rs — the staging file needs the room. */
export const MAX_WORK_FOLDER_NAME_BYTES = 239;

/** The two extensions `safe_name` accepts. */
const SHADER_EXT_RE = /\.(js|zip)$/i;

/**
 * Drop ONE trailing `.js`/`.zip`. Single-strip on purpose: `foo.js.zip` becomes
 * the stem `foo.js` (ugly but harmless), where looping would collapse it to
 * `foo` and could re-target an unrelated `foo.js`.
 */
export function stripShaderExt(fileName: string): string {
  return fileName.replace(SHADER_EXT_RE, '');
}

/**
 * The kebab a name resolves to as a FILE, or null when it only reaches
 * `toKebabCase`'s fallback. Null is not an identity: `""`, `"   "`, `"***"`,
 * `"日本語"` and `"ĀĒĪŌŪ"` all kebab to the fallback, so treating that as a match
 * would make every one of them "the same shader as" a file called `shader.js`.
 */
function fileKey(name: string): string | null {
  return toKebabCase(name, '') || null;
}

/**
 * The shader name to show after loading `fileName` from the work folder.
 *
 * `authoredName` is the name the FILE supplied (null when it carried none — a
 * bare script, or a project block with an empty `shaderName`). Never pass the
 * name that merely happens to be in the store: that is the PREVIOUS shader's.
 *
 * Returns the authored name when it denotes the same file as the stem, else the
 * stem itself. Both branches satisfy the invariant Save depends on:
 * `toKebabCase(result)` equals the stem's kebab, so a save with no rename lands
 * back on the file that was opened.
 */
export function adoptShaderName(fileName: string, authoredName: string | null): string {
  const stem = stripShaderExt(fileName);
  // Trim first: '   ' is truthy but kebabs to the fallback, so an untrimmed
  // test would adopt it verbatim and blank the toolbar's name box.
  const authored = (authoredName ?? '').trim();
  const key = authored ? fileKey(authored) : null;
  return key !== null && key === fileKey(stem) ? authored : stem;
}

/** Would this name survive `safe_name`'s length clause? (bytes, not chars) */
export function fitsWorkFolderName(name: string): boolean {
  return new TextEncoder().encode(name).length <= MAX_WORK_FOLDER_NAME_BYTES;
}

/**
 * Case-insensitive file-name equality. Both shipped desktop targets have
 * case-insensitive filesystems by default (APFS, NTFS), so `A.js` and `a.js` are
 * ONE file — comparing case-sensitively would report two and let a "new" save
 * silently replace the old one.
 */
export function sameShaderFile(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Has the shader been renamed since it was opened — i.e. would Save now write a
 * DIFFERENT file?
 *
 * Compared through `toKebabCase`, not as raw strings, because the file name is
 * what "the same shader" means here. A raw compare gets it wrong in both
 * directions: "My Shader" → "My  Shader" reads as a rename yet resolves to the
 * same file, and re-typing a prettier spelling of the adopted stem ("my-shader"
 * → "My Shader") would take the save-as branch to the file it was already on.
 *
 * The flip side is inherent to deriving file names by kebab and cannot be fixed
 * here: `toKebabCase` is many-to-one, so two genuinely different names can
 * denote one file ("Zīle" and "Zāle" both → `z-le`). That is what the caller's
 * overwrite prompt is for.
 */
export function isShaderRenamed(openedName: string, liveName: string): boolean {
  return toKebabCase(openedName) !== toKebabCase(liveName);
}

/**
 * The file Save should write.
 *
 * `openedFile` is the tracked work-folder file, or null when the shader has been
 * renamed / never came from the folder — then the ordinary export name is used
 * and Save behaves as a save-as.
 *
 * When the extension already matches, the opened name is returned VERBATIM:
 * keeping the on-disk casing is what makes the write land on the opened file
 * rather than spawning a lowercase sibling on a case-sensitive volume.
 * Otherwise the stem is re-extended — a graph that gained an image (or a preview
 * model) exports as a zip, so `waves.js` becomes `waves.zip`. NOTE the old
 * sibling is left behind: there is no delete command in the IPC surface, so a
 * kind flip forks the pair until it flips back.
 */
export function workFolderSaveName(
  openedFile: string | null,
  bundleFileName: string,
  kind: 'js' | 'zip',
): string {
  if (!openedFile) return bundleFileName;
  const dot = openedFile.lastIndexOf('.');
  const ext = dot < 0 ? '' : openedFile.slice(dot + 1).toLowerCase();
  if (ext === kind) return openedFile;
  const target = `${stripShaderExt(openedFile)}.${kind}`;
  // `.js` → `.zip` grows the name by one byte, which a name listed at exactly
  // the limit cannot afford. Falling back to the export name keeps Save working
  // instead of failing with Rust's opaque "invalid file name".
  return fitsWorkFolderName(target) ? target : bundleFileName;
}
