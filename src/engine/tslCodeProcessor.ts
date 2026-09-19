/**
 * Shared TSL code processing utilities used by tslToPreviewHTML and tslToShaderModule.
 * Handles import extraction, TDZ fix, body parsing, and channel resolution.
 */

import type { MaterialSettings } from '@/types';
import { sanitizeIdentifier } from '@/utils/nameUtils';
import { PART_SETTING_KEYS, materialSettingProps, materialSettingsFromSource } from './materialSettingsCode';
import { THREE_REVISION } from './threeRevision';
import { TSL_EXPORT_NAMES } from './tslExportNames';
import {
  MAX_INDEX_MATERIALS,
  MAX_MIRROR_ENTRIES,
  MATERIAL_PART_KEY_RE,
  checkLegacyGuard,
  sanitizeModelSignature,
  type MaterialPartsMirrorEntry,
  type ModelSignature,
} from './materialPartsContract';
import { moduleStringLiteral, partEntryColon, partEntryKey } from './partKeyLiteral';
import { safeJsonReviver } from '@/utils/safeJson';
import { isUsableMeshName } from '@/utils/meshInventory';

export type { MaterialPartsMirrorEntry };

// Map, not Record: channel keys come from parseShaderBody's return-object
// scan of pasted/imported code, and a Record would resolve 'constructor' to
// an inherited Function that lands as a property NAME in the emitted module.
const CHANNEL_TO_PROP = new Map<string, string>([
  ['color', 'colorNode'],
  ['emissive', 'emissiveNode'],
  ['normal', 'normalNode'],
  ['position', 'positionNode'],
  ['opacity', 'opacityNode'],
  ['roughness', 'roughnessNode'],
  ['metalness', 'metalnessNode'],
  // envNode: three's MeshPhysicalNodeMaterial wraps a texture-valued env in
  // pmremTexture() (EnvironmentNode) — image-based lighting, not a channel
  // sampled per fragment. Needs the loader's nodeProps to list it (added in
  // 0.5; every export references 0.8).
  ['env', 'envNode'],
]);

interface TSLImports {
  tslNames: string[];
}

interface ProcessedBody {
  defLines: string[];
  channels: Record<string, string>;
}


// ── Shared source-scanning helpers ─────────────────────────────────────────
// Single home for the string/comment-aware scanning primitives used by every
// string-based TSL transform (this module AND scriptToTSL) — hand-rolled
// copies drifted before: the naive splitters here broke on commas/braces
// inside strings or nested calls that scriptToTSL's versions already handled.

/** Per-character source classes produced by classifySource. */
const CLS_CODE = 0;
/** Inside a `//` or block comment, including its delimiters. */
const CLS_COMMENT = 1;
/** Inside a string/template literal, excluding the surrounding quotes. */
const CLS_STRING = 2;

/**
 * Classify every character of a JS source as code, comment, or string body.
 *
 * Both `maskNonCode` and `stripComments` derive from this single scan, so the
 * two can't disagree about where a comment ends — which matters because a `}`,
 * a `,` or a `//` sitting inside a comment or a string must never steer a
 * brace/argument scan.
 *
 * A line comment stops *before* its terminating newline, so stripping one
 * leaves the line break intact. Regex literals are not modelled: TSL shader
 * bodies don't contain them, and `/` in any other position is division, which
 * this scanner already treats as code.
 */
function classifySource(src: string): Uint8Array {
  const cls = new Uint8Array(src.length);
  type State = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tmpl';
  let state: State = 'code';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 'code') {
      if (c === '/' && d === '/') { cls[i] = cls[i + 1] = CLS_COMMENT; i += 2; state = 'line'; continue; }
      if (c === '/' && d === '*') { cls[i] = cls[i + 1] = CLS_COMMENT; i += 2; state = 'block'; continue; }
      if (c === "'") { state = 'sq'; i++; continue; }
      if (c === '"') { state = 'dq'; i++; continue; }
      if (c === '`') { state = 'tmpl'; i++; continue; }
      i++;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; i++; continue; }
      cls[i] = CLS_COMMENT;
      i++;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { cls[i] = cls[i + 1] = CLS_COMMENT; i += 2; state = 'code'; continue; }
      cls[i] = CLS_COMMENT;
      i++;
      continue;
    }
    // String-ish states: sq / dq / tmpl.
    if (c === '\\') { cls[i] = CLS_STRING; if (i + 1 < src.length) cls[i + 1] = CLS_STRING; i += 2; continue; }
    const closes = (state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tmpl' && c === '`');
    if (closes) { state = 'code'; i++; continue; }
    cls[i] = CLS_STRING;
    i++;
    continue;
  }
  return cls;
}

/**
 * Blank the *contents* of comments and string literals with spaces, preserving
 * the source's length and its newlines. Index-based scans (head matching, brace
 * balancing) run over the mask and then slice the original at the same offsets.
 */
export function maskNonCode(src: string): string {
  const cls = classifySource(src);
  const out = src.split('');
  for (let i = 0; i < out.length; i++) {
    if (cls[i] !== CLS_CODE && out[i] !== '\n') out[i] = ' ';
  }
  return out.join('');
}

/**
 * Remove comments, leaving code and string literals untouched. Each comment run
 * collapses to a single space so neighbouring tokens can't glue together.
 */
export function stripComments(src: string): string {
  const cls = classifySource(src);
  let out = '';
  for (let i = 0; i < src.length; i++) {
    if (cls[i] !== CLS_COMMENT) { out += src[i]; continue; }
    while (i < src.length && cls[i] === CLS_COMMENT) i++;
    out += ' ';
    i--;
  }
  return out;
}

/**
 * Split a comma-separated list on its *top-level* commas only — commas nested
 * inside (), [], or {} (or strings/comments, via the mask) stay with their
 * group.
 */
export function splitTopLevelArgs(s: string): string[] {
  const masked = maskNonCode(s);
  const args: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      args.push(s.slice(last, i).trim());
      last = i + 1;
    }
  }
  const tail = s.slice(last).trim();
  if (tail) args.push(tail);
  return args;
}

// `partEntryColon` (where a `parts` entry's key ends — a mesh name may contain
// a colon) moved verbatim to the partKeyLiteral.ts leaf, which the lazy
// scriptToTSL chunk shares.

/** Collect imported names from 'three/tsl'. */
function collectImports(tslCode: string, excludeFn = false): TSLImports {
  const tslNames: string[] = [];

  const tslImportRe = /import\s*\{([^}]+)\}\s*from\s*['"]three\/tsl['"]/g;
  let m: RegExpExecArray | null;
  while ((m = tslImportRe.exec(tslCode)) !== null) {
    for (const name of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
      if (excludeFn && name === 'Fn') continue;
      if (!tslNames.includes(name)) tslNames.push(name);
    }
  }

  return { tslNames };
}

/**
 * The local names an `import … from '…'` line binds (`* as NS`, a default, the
 * `{ a, b as c }` list — the name after `as`). Only for the single-line imports
 * `extractFnBody` preserves; anything else binds nothing.
 */
function importBindings(line: string): string[] {
  const m = /^\s*import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/.exec(line);
  if (!m) return [];
  let clause = m[1].trim();
  const out: string[] = [];
  const brace = clause.indexOf('{');
  if (brace !== -1) {
    const inner = clause.slice(brace + 1, clause.lastIndexOf('}'));
    for (const spec of inner.split(',')) out.push(spec.trim().split(/\s+as\s+/).pop()!.trim());
    clause = clause.slice(0, brace);
  }
  for (const part of clause.split(',')) {
    const p = part.trim();
    const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(p);
    out.push(ns ? ns[1] : p);
  }
  return out.filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
}

/**
 * Every name the (masked) module code DECLARES: `const`/`let`/`var`/`function`/
 * `class` names, destructuring patterns, and arrow / function parameters — the
 * `Fn(([p, r]) => …)` helpers included. Deliberately OVER-inclusive (a
 * destructuring key or a default's identifier counts too): a name wrongly
 * counted as declared is merely not imported, which is how every module
 * behaved before the import completion below existed, while a declared name
 * that WAS imported would be a module-scope redeclaration — a SyntaxError.
 */
function declaredNames(masked: string): Set<string> {
  const out = new Set<string>();
  const addAll = (text: string) => {
    for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) out.add(m[0]);
  };
  for (const m of masked.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of masked.matchAll(/\b(?:const|let|var)\s*([{[][^=;]*)=/g)) addAll(m[1]);
  for (const m of masked.matchAll(/\(([^()]*)\)\s*=>/g)) addAll(m[1]);
  for (const m of masked.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) out.add(m[1]);
  for (const m of masked.matchAll(/\bfunction\b\s*[\w$]*\s*\(([^)]*)\)/g)) addAll(m[1]);
  return out;
}

/** The namespace import a module gets when it builds a texture (see `bindThreeNamespace`). */
const THREE_NAMESPACE_IMPORT = "import * as THREE from 'three/webgpu';";

/**
 * Module-only: rewrite every CODE-position `globalThis.THREE` to `THREE`, which
 * the caller then imports from 'three/webgpu'. graphToCode spells the global for
 * every baked texture (Image, Data, Colormap, and Stripes / Data Viz fed by a
 * Data node), and a module imported without the shaderloader — plain three.js
 * with an import map — has no such global; with the import it runs standalone.
 * On either loader nothing changes at run time: `globalizeBareImports` turns the
 * namespace import back into `const THREE = globalThis.THREE;`.
 *
 * The scan runs over `maskNonCode`, so a string or comment spelling it is never
 * touched. Skipped outright — no rewrite AND no import — when the code already
 * binds `THREE` (a preamble import, e.g. an exported module pasted back through
 * scriptToTSL, or a declaration), since a second binding is a SyntaxError that
 * kills the whole module.
 */
function bindThreeNamespace(code: string, preambleImports: readonly string[]): { code: string; imported: boolean } {
  if (preambleImports.some((l) => importBindings(l).includes('THREE'))) return { code, imported: false };
  const masked = maskNonCode(code);
  if (declaredNames(masked).has('THREE')) return { code, imported: false };
  let out = '';
  let last = 0;
  let hits = 0;
  for (const m of masked.matchAll(/(?<![\w$.])globalThis\.THREE(?![\w$])/g)) {
    out += code.slice(last, m.index) + 'THREE';
    last = m.index! + m[0].length;
    hits++;
  }
  if (hits === 0) return { code, imported: false };
  return { code: out + code.slice(last), imported: true };
}

/**
 * Module-only: the `three/tsl` names the code CALLS but neither imports nor
 * declares — an unknown node's function, an unknown argument, pasted code, the
 * `Fn` a Raymarch Output's IIFE calls — sorted, for appending to the import
 * line. The shaderloader's `autoInjectTSLImports` recovers such a name at run
 * time; a bare `import()` of the downloaded `.js` does not. Only names in
 * `TSL_EXPORT_NAMES` qualify, so a function three/tsl does not export is never
 * imported (it would be a SyntaxError of its own).
 */
function missingTslNames(code: string, tslNames: readonly string[], preambleImports: readonly string[]): string[] {
  const masked = maskNonCode(code);
  const known = new Set<string>(declaredNames(masked));
  for (const n of tslNames) known.add(n.split(/\s+as\s+/).pop()!.trim());
  for (const line of preambleImports) for (const n of importBindings(line)) known.add(n);
  const found = new Set<string>();
  for (const m of masked.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (TSL_EXPORT_NAMES.has(m[1]) && !known.has(m[1])) found.add(m[1]);
  }
  return [...found].sort();
}

/** The module's declared three revision (the leaf `threeRevision.ts` holds the number). */
const THREE_REVISION_LINE_RE = /^\s*export\s+const\s+threeRevision\s*=/;

interface ExtractedFn {
  /** The statements inside the main `Fn(() => { ... })` wrapper. */
  body: string;
  /** Non-`three/tsl` import lines that precede the main Fn (preserved verbatim). */
  preambleImports: string[];
  /**
   * Module-scope declarations that precede the main Fn — e.g. the `hsl`/`toHsl`
   * helper `Fn`s graphToCode emits for the HSL color nodes. These are called
   * from inside the body, so dropping them produces a module that references an
   * undefined helper. Preserved verbatim and re-emitted at module scope.
   */
  preambleDecls: string[];
}

/**
 * Extract the body of the main `Fn(() => { ... })` wrapper, and preserve
 * everything that precedes it at module scope (non-`three/tsl` imports +
 * helper declarations). The main shader Fn is the empty-param `Fn(() => {`
 * (helpers use the param form `Fn(([...]) => {`, so `indexOf('Fn(() => {')`
 * lands on the shader, never a helper). The body is closed by brace-matching
 * from that point — robust to trailing module code and nested blocks, where the
 * old `lastIndexOf('});')` could mis-slice. (A full @babel parse would be the
 * ideal here; this stays string-based but no longer silently discards the
 * preamble.)
 */
function extractFnBody(tslCode: string, tslNames: string[]): ExtractedFn {
  // Scan offsets on the masked copy so a `{`/`}` inside a string literal or
  // comment can't derail the match; slice the ORIGINAL at the same offsets.
  const masked = maskNonCode(tslCode);
  // The SHADER is `const shader = Fn(() => {` when the editor emitted it — a
  // zero-parameter helper Fn declared above it (the `rayDirection` module
  // helper: `const rayDirection = Fn(() => { … })`) would otherwise be taken
  // for the shader by a plain first-occurrence search, and the whole module
  // collapsed to that helper's return (measured: `colorNode: normalize(sub(
  // positionWorld, cameraPosition))`, the ray direction painted as colour).
  // Hand-written code without the name still falls back to the first match.
  const named = masked.indexOf('const shader = Fn(() => {');
  const fnStart = named !== -1 ? masked.indexOf('Fn(() => {', named) : masked.indexOf('Fn(() => {');
  let body = '';
  let head = '';
  if (fnStart !== -1) {
    const bodyOpen = fnStart + 'Fn(() => {'.length; // just past the `{`
    let depth = 1;
    let i = bodyOpen;
    while (i < masked.length && depth > 0) {
      const ch = masked[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      i++;
    }
    if (depth === 0) {
      body = tslCode.slice(bodyOpen, i - 1).trim();
      // Start of the `const <name> = Fn(() => {` declaration line.
      const declStart = tslCode.lastIndexOf('\n', fnStart) + 1;
      head = tslCode.slice(0, declStart);
    }
  }

  const preambleImports: string[] = [];
  const preambleDecls: string[] = [];
  for (const rawLine of head.split('\n')) {
    if (/^\s*import\b/.test(rawLine)) {
      // three/tsl imports are regenerated by collectImports; keep any others.
      if (!/from\s*['"]three\/tsl['"]/.test(rawLine)) preambleImports.push(rawLine.trim());
    } else if (THREE_REVISION_LINE_RE.test(rawLine)) {
      // Pasted MODULE text carries the revision buildShaderModule declares
      // itself; keeping this line would export `threeRevision` twice — a
      // SyntaxError that kills the whole module.
      continue;
    } else {
      preambleDecls.push(rawLine);
    }
  }
  // Trim leading/trailing blank decl lines so the re-emitted preamble is tidy.
  while (preambleDecls.length && !preambleDecls[0].trim()) preambleDecls.shift();
  while (preambleDecls.length && !preambleDecls[preambleDecls.length - 1].trim()) {
    preambleDecls.pop();
  }

  if (!body) {
    body = 'return vec3(1, 0, 0);';
    if (!tslNames.includes('vec3')) tslNames.push('vec3');
  }
  return { body, preambleImports, preambleDecls };
}

interface TDZResult {
  body: string;
  /**
   * Locals renamed because they shadowed an imported TSL name, mapped
   * original → renamed (e.g. a property named `mix` → `_mix`). buildShaderModule
   * reverses this so a renamed property uniform still resolves to a `params.<X>`
   * keyed by its *original* name (the name the live overlay & shaderloader
   * auto-detect from the un-rewritten generated code).
   */
  renames: Map<string, string>;
}

/**
 * Fix TDZ (Temporal Dead Zone) issues in generated code:
 * 1. Remove self-referencing bare declarations (const X = X;)
 * 2. Rename local variables that shadow imported function names
 * 3. Fix bare numeric first-arg in MaterialX noise calls
 */
function fixTDZ(body: string, tslNames: string[]): TDZResult {
  let processedBody = body;
  const importedNames = new Set(tslNames);
  const renames = new Map<string, string>();

  // 1. Remove self-referencing bare declarations: const X = X;
  //
  // ONE pass with a backreference, not one pass per imported name. This used to
  // compile a fresh RegExp per name and rescan the entire body with it, i.e.
  // O(names x bodyLength) with a regex compile per iteration — ~40 full-body
  // scans on a large graph, paid on every path that builds a runnable module
  // (each debounced preview rebuild, each Download Shader, and — undebounced —
  // every graph edit while the A-Frame tab is open). The set membership test in
  // the replacer does exactly the filtering the per-name pattern used to do, and
  // the `\s`/anchoring is unchanged, so the multi-line `const X =\n  X;` form
  // still matches. `[\w$]` rather than `\w` because a JS identifier may carry a
  // `$`; the gate means the wider class can still only ever match imported names.
  processedBody = processedBody.replace(
    /^[ \t]*const\s+([\w$]+)\s*=\s*\1\s*;[ \t]*$/gm,
    (whole, name: string) => (importedNames.has(name) ? '' : whole),
  );

  // 2. Rename local variables that shadow imported function names
  const declRe = /\bconst\s+(\w+)\s*=/g;
  const conflicting = new Set<string>();
  let dm: RegExpExecArray | null;
  while ((dm = declRe.exec(processedBody)) !== null) {
    if (importedNames.has(dm[1])) {
      conflicting.add(dm[1]);
    }
  }
  for (const name of conflicting) {
    processedBody = processedBody.replace(
      new RegExp(`\\b${name}\\b(?!\\s*[:(])`, 'g'),
      `_${name}`,
    );
    renames.set(name, `_${name}`);
  }

  // 3. Fix bare numeric first-arg in MaterialX noise calls — default to uv()
  processedBody = processedBody.replace(
    /\b(mx_\w+)\(\s*0\s*\)/g,
    '$1(uv())',
  );
  processedBody = processedBody.replace(
    /\b(mx_\w+)\(\s*0\s*,/g,
    '$1(uv(),',
  );
  if (processedBody.includes('uv(') && !tslNames.includes('uv')) {
    tslNames.push('uv');
  }

  return { body: processedBody, renames };
}

/**
 * Pull discard statements out of a body, returning the extracted conditions and
 * the remaining text. Uses paren-balancing (not an end-anchored regex) so a
 * discard with nested parens, a trailing `// comment`, or one split across lines
 * is handled rather than silently dropped. A genuinely unbalanced `Discard(` is
 * left in place (loud syntax error) instead of vanishing.
 *
 * BOTH TSL spellings are lifted, because both reach here:
 *
 *   Discard(cond);   — what graphToCode emits
 *   cond.discard();  — the method-chaining form (`addMethodChaining('discard',
 *                      Discard)` in three's Discard.js), i.e. the idiomatic
 *                      spelling someone writes by hand in the code panel
 *
 * The chained form used to be skipped by the `.`-prefix guard below (which
 * exists for a member call like `foo.Discard(`) and so survived verbatim into
 * the module — landing at plain-function scope where `.toStack()` has no active
 * stack and is a silent no-op. Measured against three r184's GLSLNodeBuilder:
 * the verbatim form emitted ZERO `discard` instructions, the wrapped form one.
 * It reached the preview AND the downloaded `.js`, and `codeToGraph` drops the
 * line with no diagnostic, so the next graph edit erased the user's cutout.
 *
 * An extracted condition of `''` is three's parameterless `Discard()` — an
 * UNCONDITIONAL cull, which the caller must emit without an Fn parameter.
 *
 * The scan runs over `maskNonCode(bodyText)` and slices out of `bodyText`, so a
 * discard inside a comment or a string literal is not code and is left alone.
 * Scanning the raw text meant `/* Discard(a); *\/` had its body eaten AND a live
 * cutout injected, and `const s = 'Discard(1)';` became `const s = '';` plus a
 * real unconditional discard — the mesh vanished because of a string literal.
 *
 * Only STATEMENT-level discards are lifted. `const k = Discard(n);` used to be
 * sliced at the call, leaving a dangling `const k = ` — a SyntaxError that took
 * the whole module down. It is now left verbatim (inert, like any other
 * expression-position discard) rather than mangled.
 */
function extractDiscards(bodyText: string): { conds: string[]; rest: string } {
  // Comments and string literals blanked to spaces, indices preserved, so every
  // offset below indexes both strings identically.
  const masked = maskNonCode(bodyText);

  /** True when only whitespace separates `idx` from the start of its statement. */
  const atStatementStart = (idx: number): boolean => {
    for (let i = idx - 1; i >= 0; i--) {
      const ch = masked[i];
      if (/\s/.test(ch)) continue;
      return ch === ';' || ch === '{' || ch === '}';
    }
    return true;
  };

  /**
   * From the `)` of a discard call, the end of the span to delete: past a
   * trailing `;`, and past the rest of the line when nothing but whitespace or
   * a comment follows (a real trailing statement is kept).
   */
  const spanEnd = (afterCall: number): number => {
    let k = afterCall;
    while (k < masked.length && /[ \t]/.test(masked[k])) k++;
    if (masked[k] === ';') k++;
    const tailStart = k;
    while (k < masked.length && masked[k] !== '\n') k++;
    // Comments are already blank in `masked`, so this is a pure whitespace test.
    if (masked.slice(tailStart, k).trim() === '') {
      return masked[k] === '\n' ? k + 1 : k;
    }
    return tailStart;
  };

  const hits: { start: number; end: number; cond: string }[] = [];

  // --- `Discard(cond);` ---------------------------------------------------
  const callRe = /\bDiscard\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(masked)) !== null) {
    // Don't treat a member call like `foo.Discard(` as the TSL Discard.
    if (m.index > 0 && masked[m.index - 1] === '.') continue;
    if (!atStatementStart(m.index)) continue;
    const argStart = m.index + m[0].length; // just past the `(`
    let depth = 1;
    let j = argStart;
    for (; j < masked.length && depth > 0; j++) {
      const ch = masked[j];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth !== 0) break; // unbalanced — leave the remainder untouched
    const argEnd = j - 1; // index of the matching `)`
    hits.push({
      start: m.index,
      end: spanEnd(argEnd + 1),
      cond: bodyText.slice(argStart, argEnd).trim(),
    });
    callRe.lastIndex = argEnd + 1;
  }

  // --- `cond.discard();` --------------------------------------------------
  const chainRe = /\.discard\s*\(\s*\)/g;
  while ((m = chainRe.exec(masked)) !== null) {
    const dot = m.index;
    let i = dot - 1;
    while (i >= 0 && /\s/.test(masked[i])) i--;
    // Walk back over the receiver: an identifier/property chain, with balanced
    // call and index brackets. Anything else ends it.
    let depth = 0;
    for (; i >= 0; i--) {
      const ch = masked[i];
      if (ch === ')' || ch === ']') { depth++; continue; }
      if (ch === '(' || ch === '[') {
        if (depth === 0) break;
        depth--;
        continue;
      }
      if (depth > 0) continue;
      if (!/[A-Za-z0-9_$.]/.test(ch)) break;
    }
    const start = i + 1;
    const cond = bodyText.slice(start, dot).trim();
    if (!cond || depth !== 0 || !atStatementStart(start)) continue;
    hits.push({ start, end: spanEnd(m.index + m[0].length), cond });
  }

  hits.sort((a, b) => a.start - b.start);

  const conds: string[] = [];
  let rest = '';
  let lastCopied = 0;
  for (const hit of hits) {
    if (hit.start < lastCopied) continue; // overlapping — keep the first
    conds.push(hit.cond);
    rest += bodyText.slice(lastCopied, hit.start);
    lastCopied = hit.end;
  }
  rest += bodyText.slice(lastCopied);
  return { conds, rest };
}

/** Parse processed body into definition lines and output channels. */
function parseBody(
  processedBody: string,
  tslNames: string[],
): ProcessedBody {
  const defLines: string[] = [];
  const channels: Record<string, string> = {};

  // Brace depth, counted on the MASKED body so a `{` inside a string or comment
  // cannot shift it. Only a `return` at depth 0 is the SHADER's return: a nested
  // `Fn(() => { … return v; })()` — the one shape that can carry a `Loop`, an
  // `If` or an `.assign` into a module the loader calls as a plain function —
  // has a `return` of its own, and the line-based match below used to hijack
  // it as the colour channel and DELETE it from the body, leaving the inner Fn
  // void. Measured: the A-Frame bundle then crashed in `getTypeFromLength`
  // (a SplitNode over a void node) and the unminified build reported "Invalid
  // generated code, expected a vec3" — for a shader that ran correctly in Node.
  const maskedLines = maskNonCode(processedBody).split('\n');
  const bodyLines = processedBody.split('\n');
  let depth = 0;

  for (let li = 0; li < bodyLines.length; li++) {
    const rawLine = bodyLines[li];
    const atTop = depth === 0;
    for (const ch of maskedLines[li] ?? '') {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
    // Strip a trailing line comment before matching. Both patterns below are
    // anchored to end-of-line, so a `return …; // note` slipped past BOTH and
    // fell through to defLines — re-emitted verbatim as a body statement that
    // then WINS over the return this function builds afterwards. The whole
    // channel/__pixel/material-settings return became dead code: Discard never
    // ran and Transparent / Alpha Clip / Side / Depth Write were all silently
    // dropped. Only a `//` outside a string can end a statement line here, and
    // the emitter never puts a URL-ish `//` in one.
    const trimmed = rawLine.trim().replace(/\s*\/\/[^'"`]*$/, '').trim();
    if (!trimmed) continue;

    const objReturn = atTop ? trimmed.match(/^return\s*\{(.+)\}\s*;?$/) : null;
    const simpleReturn = atTop ? trimmed.match(/^return\s+(.+);$/) : null;

    if (objReturn) {
      // Top-level commas only — `color: vec3(1, 0, 0)` is ONE property, and
      // the old raw split(',') sheared every nested call apart.
      for (const prop of splitTopLevelArgs(objReturn[1])) {
        const colonIdx = prop.indexOf(':');
        if (colonIdx !== -1) {
          const key = prop.slice(0, colonIdx).trim();
          const val = prop.slice(colonIdx + 1).trim();
          if (key && val) channels[key] = val;
        }
      }
    } else if (simpleReturn) {
      channels['color'] = simpleReturn[1].trim();
    } else {
      defLines.push(rawLine);
    }
  }

  if (Object.keys(channels).length === 0) {
    channels['color'] = 'vec3(1, 0, 0)';
    if (!tslNames.includes('vec3')) tslNames.push('vec3');
  }

  return { defLines, channels };
}

interface ShaderModuleProperty {
  name: string;
  /** float property → number; colour property → '#rrggbb' hex string. */
  defaultValue: number | string;
}

export interface BuildShaderModuleOptions {
  materialSettings?: MaterialSettings;
  /**
   * Comment lines emitted above the import statements. The standalone `.js`
   * export uses this for its usage header; the live preview omits it.
   */
  header?: string[];
  /**
   * Declared float properties. When provided (export), only `uniform(V)`
   * declarations whose (sanitized) name matches a declared property are rewritten
   * to `params.<name>`; unwired properties are still declared in the schema using
   * their `defaultValue`. When omitted (preview), every `uniform(V)` declaration
   * is auto-detected. In BOTH modes a wired uniform's schema default comes from
   * its code literal `V`, so the exported file matches the preview byte-for-byte.
   */
  properties?: ShaderModuleProperty[];
  /**
   * The loader-0.6 MIRROR plan (`materialPartsMirrorPlan` of the Output node):
   * a `parts` entry per GLTFLoader-given mesh name, its body byte-identical to
   * the `materialParts` entry for its glTF material (materialPartsContract
   * R2/R4). MODULE-ONLY (R7): the editor TSL never carries it, so every module
   * path — preview, XR popup, the A-Frame/Three.js tabs and the export —
   * passes the SAME plan here. Absent or empty = no mirrors; with no
   * `materialParts` in the code it is ignored entirely.
   */
  materialPartsMirror?: readonly MaterialPartsMirrorEntry[];
}

/**
 * A `modelSignature: { materials: [...] }` value's SOURCE TEXT as a signature,
 * or null. The list is read with JSON.parse (what the emitter writes is JSON:
 * double-quoted strings, the `/` and `<` escapes JSON decodes), then THE
 * sanitizer. A single-quoted or otherwise non-JSON list is refused, not guessed
 * — and with it the whole table (R3).
 */
function parseModelSignatureText(src: string | undefined): ModelSignature | null {
  if (!src) return null;
  const m = /^\{\s*materials\s*:\s*(\[[\s\S]*\])\s*\}$/.exec(src.trim());
  if (!m) return null;
  let list: unknown;
  try {
    list = JSON.parse(m[1], safeJsonReviver);
  } catch {
    return null;
  }
  return sanitizeModelSignature({ materials: list });
}

/**
 * Convert Fn-wrapped editor TSL into a shaderloader-compatible ES module. This
 * is the SINGLE source of truth shared by the live preview (tslToPreviewHTML)
 * and the `.js` export (tslToShaderModule) — they must never diverge, because
 * any divergence means the export ships a shader that differs from what the
 * user previewed.
 *
 * The shaderloader calls the default export as a *plain function* (no active
 * TSL stack) and assigns `material.colorNode = result.colorNode` directly, so
 * two rules are non-negotiable and historically easy to break with ad-hoc
 * per-line string surgery (which is exactly what produced the struct-as-
 * colorNode export bug):
 *
 *   1. Object returns (`{ color, position, ... }`) MUST be parsed per channel.
 *      `parseBody` matches the object-form return before the bare-value form so
 *      a `{ ... }` literal is never swallowed whole into a single color slot —
 *      assigning a struct to `colorNode` makes the renderer read uninitialised
 *      memory (random color each reload) and drops every other channel.
 *   2. `Discard()` needs an active stack, so the color channel is routed
 *      through a tiny `__pixel` Fn. Its discard conditions and color node are
 *      passed as explicit Fn *parameters*, never closure-captured: Three.js
 *      r173 (where first diagnosed; the bundled A-Frame build is now r184) did not propagate closure-captured
 *      derived nodes into an Fn body invoked from an outer plain function,
 *      which would otherwise resolve the color to a default (solid red).
 */
export function buildShaderModule(
  tslCode: string,
  options: BuildShaderModuleOptions = {},
): string {
  const { materialSettings, header, properties } = options;

  const { tslNames } = collectImports(tslCode, true);
  const { body, preambleImports, preambleDecls } = extractFnBody(tslCode, tslNames);
  const { body: processedBody, renames } = fixTDZ(body, tslNames);
  const { defLines, channels } = parseBody(processedBody, tslNames);

  // Module-scope helper Fns (hsl/toHsl) live in the preamble and need `Fn`.
  if (/\bFn\s*\(/.test(preambleDecls.join('\n')) && !tslNames.includes('Fn')) {
    tslNames.push('Fn');
  }

  // Ensure positionLocal (and normalLocal for normal-based displacement) are available.
  const displacementMode = materialSettings?.displacementMode ?? 'normal';
  if (channels.position) {
    if (!tslNames.includes('positionLocal')) tslNames.push('positionLocal');
    if (displacementMode === 'normal' && !tslNames.includes('normalLocal')) {
      tslNames.push('normalLocal');
    }
  }

  // --- Property uniforms → params + schema --------------------------------
  //
  // Rewriting `const X = uniform(N)` to `const X = params.X` (plus an explicit
  // `schema`) makes the shaderloader create the uniforms up-front and pass them
  // in, so the live overlay's `_propertyUniforms.X.value = …` reaches the
  // material instead of mutating a throwaway anonymous uniform.
  //
  // EVERY `uniform()` line is keyed off its ACTUAL generated var name (only
  // property_float emits uniform(), and the shaderloader auto-detects every
  // `const X = uniform(V)` as a property at runtime regardless). Keying off the
  // real var — not a name recomputed from the property list — is what keeps two
  // properties whose names sanitize to the same base (`my speed`, `my-speed` →
  // graphToCode emits `my_speed`, `my_speed2`) BOTH exposed instead of one
  // silently overwriting the other.
  //
  // The schema key is the *pre-fixTDZ* var name (`reverseRename`) — the name the
  // live overlay & shaderloader auto-detect from the un-rewritten code — so a
  // property whose name collides with a TSL import (renamed `mix` → `_mix`)
  // still resolves to `params.mix`.
  const reverseRename = new Map<string, string>();
  for (const [orig, renamed] of renames) reverseRename.set(renamed, orig);

  const explicit = !!(properties && properties.length > 0);
  // number → a float uniform; `#rrggbb` string → a colour (vec3) uniform.
  // shaderloader 0.5+ reads the schema `type` to decide which to build.
  const schemaEntries: Record<string, number | string> = {};
  // Export declares all properties up-front so the a-entity API documents them
  // even when a property node isn't wired (no `uniform()` line). Wired ones get
  // their default overwritten below from the code literal, keeping the schema
  // default identical to the preview's auto-detected value (#9 parity). Schema
  // keys are sanitized to match graphToCode's generated var names.
  if (explicit) {
    // Mirror graphToCode's claimName disambiguation: two property names that
    // sanitize to the same identifier ('my speed' / 'my-speed' → my_speed) get
    // my_speed, my_speed2, … — matching the emitted variable names, so this
    // declared-up-front pass and the wired-line rewrite below agree on keys.
    // The old raw-keyed version was last-wins: an UNWIRED property colliding
    // with another silently vanished from the exported schema.
    const taken = new Set<string>();
    for (const p of properties!) {
      const base = sanitizeIdentifier(p.name);
      let key = base;
      for (let i = 2; taken.has(key); i++) key = `${base}${i}`;
      taken.add(key);
      schemaEntries[key] = p.defaultValue;
    }
  }
  // Accept any numeric literal — including scientific notation (`1e-7`) and
  // leading-dot (`.5`), both of which `String(value)` can produce — so a
  // property at an extreme value isn't left as an undriveable literal uniform.
  const uniformLineRe =
    /^(\s*)const\s+(\w+)\s*=\s*uniform\(\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*\)\s*;?\s*$/;
  // Colour uniforms: `const X = uniform(color(0xrrggbb))`. Matched separately
  // because the numeric pattern above deliberately accepts only a bare literal
  // — `[^)]+`-style greediness here would also swallow unrelated calls.
  const uniformColorLineRe =
    /^(\s*)const\s+(\w+)\s*=\s*uniform\(\s*color\(\s*0x([0-9a-fA-F]{6})\s*\)\s*\)\s*;?\s*$/;
  const rewrittenDefLines = defLines.map((line) => {
    const mc = line.match(uniformColorLineRe);
    if (mc) {
      const [, indent, codeVar, hex] = mc;
      const schemaKey = reverseRename.get(codeVar) ?? codeVar;
      schemaEntries[schemaKey] = `#${hex.toLowerCase()}`;
      return `${indent}const ${codeVar} = params.${schemaKey};`;
    }
    const m = line.match(uniformLineRe);
    if (!m) return line;
    const [, indent, codeVar, rawVal] = m;
    const schemaKey = reverseRename.get(codeVar) ?? codeVar;
    const v = parseFloat(rawVal);
    schemaEntries[schemaKey] = isNaN(v) ? 0 : v;
    return `${indent}const ${codeVar} = params.${schemaKey};`;
  });
  const hasParams = Object.keys(schemaEntries).length > 0;

  // --- Pull Discard(...) out for the __pixel wrapper ----------------------
  const { conds: discardConds, rest: nonDiscardText } = extractDiscards(
    rewrittenDefLines.join('\n'),
  );
  const nonDiscardLines = nonDiscardText.split('\n').filter((l) => l.trim());
  const hasDiscard = discardConds.length > 0;
  if (hasDiscard && !tslNames.includes('Fn')) tslNames.push('Fn');
  // The wrapper below CALLS `Discard`, so the module must import it even when
  // the source didn't — a `.discard()` chain names it nowhere. Existing exports
  // are unaffected: their source already imports it, so this never pushes.
  // (The shaderloader's auto-import recovers a missing name at runtime, but a
  // bare `import()` of the downloaded `.js` does not.)
  if (hasDiscard && !tslNames.includes('Discard')) tslNames.push('Discard');

  // Colour carried through the discard wrapper when no colour channel is wired.
  // Emissive first: the loader copies emissiveNode→colorNode only when
  // colorNode is undefined, and the wrapper always defines colorNode — so
  // falling straight to white made adding a discard wash an emissive-only
  // shader out to lit white. Passing the emissive ref reproduces exactly what
  // the loader would have done. White remains the last resort: it is the
  // MeshStandard base colour, so the cutout applies without changing the look
  // of the surviving fragments.
  // The copy-when-undefined rule arrived in loader 0.5, and 0.6 and 0.8 carry
  // it verbatim; cite the frozen 0.6 in the SUBMODULE when you need the line:
  // a-frame-shaderloader/js/a-frame-shaderloader-0.6.js:346-350. Neither 0.5
  // nor 0.6 is vendored into public/js any more, so a `public/js/…` citation of
  // either can no longer be followed.
  const discardColor = channels.color ?? channels.emissive ?? 'vec3(1, 1, 1)';
  if (hasDiscard && !channels.color && !channels.emissive && !tslNames.includes('vec3')) {
    tslNames.push('vec3');
  }
  // An empty condition is three's parameterless `Discard()` — an unconditional
  // cull. It takes NO Fn parameter and NO call argument: passing one through
  // emitted `__pixel(, …)`, a SyntaxError that killed the whole module.
  const condParams = discardConds.map((c, i) => (c ? `__c${i}` : null));
  const pixelCallArgs = hasDiscard
    ? [...discardConds.filter((c) => c !== ''), discardColor]
    : [];

  // --- Build the return object (node property names per channel) ----------
  const returnProps: string[] = [];
  let colorEmitted = false;
  for (const [ch, ref] of Object.entries(channels)) {
    const prop = CHANNEL_TO_PROP.get(ch);
    if (!prop) continue;
    if (ch === 'position') {
      const displacement = displacementMode === 'normal'
        ? `normalLocal.mul(${ref})`
        : ref;
      returnProps.push(`${prop}: positionLocal.add(${displacement})`);
    } else if (ch === 'color' && hasDiscard) {
      returnProps.push(`${prop}: __pixel(${pixelCallArgs.join(', ')})`);
      colorEmitted = true;
    } else {
      returnProps.push(`${prop}: ${ref}`);
      if (ch === 'color') colorEmitted = true;
    }
  }
  // A discard only runs inside the __pixel Fn routed through colorNode. If the
  // graph wired a discard but no color (e.g. discard + position), still emit the
  // color channel so the cutout isn't silently dropped with a dead __pixel.
  if (hasDiscard && !colorEmitted) {
    returnProps.unshift(`${CHANNEL_TO_PROP.get('color')}: __pixel(${pixelCallArgs.join(', ')})`);
  }

  // --- Per-sub-mesh materials (the loader's `parts`, 0.6 and 0.8) ---------
  //
  // The editor speaks CHANNEL names (`color`) and the loader speaks node-prop
  // names (`colorNode`), and that translation is this function's job — so a
  // part's inner keys go through the very same CHANNEL_TO_PROP map as the
  // default's. Re-emitting the block verbatim would hand the loader keys it
  // does not know, and it would silently render the default material on every
  // mesh: right-looking source, wrong picture, no error.
  //
  // A part's `discard` is a KEY rather than a statement (a statement belongs
  // to the module, not to one mesh), so it becomes that part's own __pixel
  // wrapper. The wrappers are INDEXED because a mesh name is not an
  // identifier — `Body.001` and `my mesh` are both legal names.
  //
  // A part's Transparent / Side / Alpha clip / Depth write (the four
  // PART_SETTING_KEYS the loader's buildMaterial applies per part) are
  // collected as TEXT, re-validated through the same sanitizer scriptToTSL
  // and codeToGraph use (which also strips a value's comments, so this raw
  // colon-to-comma slice reads what Babel's comment-free value node does),
  // and re-emitted canonically AFTER the channel props — the code panel
  // is an editing surface, and a `.fastshader`'s settings reach the code via
  // graphToCode, so neither is trusted verbatim. A part's `mergeVertices` /
  // `displacementMode` are ignored: welding is module-level and the
  // displacement mode is the default's (see materialSettingsCode).
  const partWrappers: string[] = [];
  /**
   * Translate ONE part body `{ … }` — a `parts` entry's or a `materialParts`
   * entry's — into node-prop form: the joined props, or null when it carries
   * no CHANNEL prop (mirroring the loader's own `hasChannels(spec)` skip: a
   * part carrying nothing but settings is dropped). A cutout pushes that
   * part's indexed __partPixel wrapper as a side effect. ONE translator for
   * both tables, so an index body and its 0.6 mirror are byte-identical and
   * neither can drift from a name part's.
   */
  const translatePartBody = (bodySrc: string): string | null => {
    const props: string[] = [];
    let partDiscard: string | null = null;
    /** Raw source text of this part's settings keys (last occurrence wins, as in the JS literal). */
    const partSettingText: Record<string, string> = {};
    for (const partProp of splitTopLevelArgs(bodySrc.replace(/^\{/, '').replace(/\}$/, ''))) {
      const c = partProp.indexOf(':');
      if (c === -1) continue;
      // Unquoted, because codeToGraph's `propKeyName` reads a string-literal
      // key (`"transparent": true`, `'color': x`) as the name it spells: a
      // quoted key compared raw here was dropped from the module while the
      // parse kept it, so after an Apply the preview and the node disagreed.
      const key = partProp.slice(0, c).trim().replace(/^(['"])(.*)\1$/, '$2');
      const val = partProp.slice(c + 1).trim();
      if (!key || !val) continue;
      if (key === 'discard') { partDiscard = val; continue; }
      if (PART_SETTING_KEYS.has(key)) { partSettingText[key] = val; continue; }
      const partPropName = CHANNEL_TO_PROP.get(key);
      if (!partPropName) continue;
      if (key === 'position') {
        const displacement = displacementMode === 'normal'
          ? `normalLocal.mul(${val})`
          : val;
        props.push(`${partPropName}: positionLocal.add(${displacement})`);
      } else {
        props.push(`${partPropName}: ${val}`);
      }
    }
    if (partDiscard) {
      const wrapper = `__partPixel${partWrappers.length}`;
      const existingColor = props.findIndex((s) => s.startsWith('colorNode:'));
      // Emissive before white, for the reason the DEFAULT path documents
      // above (`discardColor`): the loader copies emissiveNode→colorNode only
      // when colorNode is undefined, and this wrapper always defines it — so
      // falling straight to white washes an emissive-only part out to lit
      // white. The ordinary glow-cutout wiring (Emissive + Discard, no
      // Colour) rendered correctly on the default Output and wrong on a
      // targeted one: the same graph, two pictures, decided only by whether
      // the Output happened to carry a mesh target.
      const existingEmissive = props.findIndex((s) => s.startsWith('emissiveNode:'));
      const colorRef = existingColor !== -1
        ? props[existingColor].slice('colorNode:'.length).trim()
        : existingEmissive !== -1
          ? props[existingEmissive].slice('emissiveNode:'.length).trim()
          : 'vec3(1, 1, 1)';
      partWrappers.push(
        `const ${wrapper} = Fn(([__c, __col]) => { Discard(__c); return __col; });`,
      );
      const call = `colorNode: ${wrapper}(${partDiscard}, ${colorRef})`;
      if (existingColor === -1) props.unshift(call);
      else props[existingColor] = call;
    }
    // Gated on CHANNEL props only: a part carrying nothing but settings is
    // still dropped, mirroring the loader's own `hasChannels(spec)` skip.
    if (props.length === 0) return null;
    const partSettings = materialSettingsFromSource(partSettingText);
    return [...props, ...materialSettingProps(partSettings)].join(', ');
  };

  const partsSrc = channels.parts;
  /** The emitted NAME entries, and the names their keys decode to. */
  const entries: string[] = [];
  const nameKeys = new Set<string>();
  if (partsSrc) {
    const inner = partsSrc.trim().replace(/^\{/, '').replace(/\}$/, '');
    for (const entry of splitTopLevelArgs(inner)) {
      const colon = partEntryColon(entry);
      if (colon === -1) continue;
      const rawKey = entry.slice(0, colon).trim();
      const bodySrc = entry.slice(colon + 1).trim();
      if (!bodySrc.startsWith('{')) continue;
      // graphToCode always quotes the key, but the code panel is a real editing
      // surface and a hand-written `parts: { Glass: {…} }` is valid JS that
      // `codeToGraph` accepts. Quoting it here rather than skipping keeps the
      // preview showing what the module says; the alternative is the part
      // silently vanishing from the render until the user happens to press
      // Apply (which re-emits it quoted). Anything that is neither a string
      // literal nor a plain identifier is still refused.
      const nameLit = rawKey.startsWith('"')
        ? rawKey
        : /^[A-Za-z_$][\w$]*$/.test(rawKey)
          ? JSON.stringify(rawKey)
          : '';
      if (!nameLit) continue;
      const body = translatePartBody(bodySrc);
      if (body === null) continue;
      entries.push(`${nameLit}: { ${body} }`);
      const key = partEntryKey(entry);
      if (key !== null) nameKeys.add(key);
    }
  }

  // --- glTF MATERIAL-INDEX parts (loader 0.8's `materialParts`) -----------
  //
  // An import-built section is keyed by glTF MATERIAL INDEX, not by mesh name.
  // Its body goes through the same translator as a `parts` body. The table
  // travels only beside a VALID `modelSignature` (R3): 0.8 applies it only
  // against an exactly-equal model, and without one it is dropped whole. Keys
  // are the canonical decimal index (MATERIAL_PART_KEY_RE, quoted or bare
  // digits — the parse accepts the same two spellings), inside the signature;
  // the last occurrence wins, as in the JS literal; ascending, capped at the
  // editor's MAX_INDEX_MATERIALS.
  const indexBodies = new Map<number, string>();
  const signature = channels.materialParts !== undefined
    ? parseModelSignatureText(channels.modelSignature)
    : null;
  if (signature) {
    const table = channels.materialParts.trim();
    if (table.startsWith('{') && table.endsWith('}')) {
      const bySource = new Map<number, string>();
      for (const entry of splitTopLevelArgs(table.slice(1, -1))) {
        const colon = partEntryColon(entry);
        if (colon === -1) continue;
        const rawKey = entry.slice(0, colon).trim();
        const bodySrc = entry.slice(colon + 1).trim();
        if (!bodySrc.startsWith('{')) continue;
        const key = /^\d+$/.test(rawKey) ? rawKey : rawKey.startsWith('"') ? partEntryKey(entry) : null;
        if (key === null || !MATERIAL_PART_KEY_RE.test(key)) continue;
        const index = Number(key);
        if (index >= signature.materials.length) continue;
        bySource.set(index, bodySrc);
      }
      for (const index of [...bySource.keys()].sort((a, b) => a - b)) {
        if (indexBodies.size >= MAX_INDEX_MATERIALS) break;
        const body = translatePartBody(bySource.get(index)!);
        if (body !== null) indexBodies.set(index, body);
      }
    }
  }

  if (signature && indexBodies.size > 0) {
    // R2: the loader-0.6 MIRRORS. 0.6 knows nothing of materialParts, so each
    // GLTFLoader-given mesh name of an emitted index gets a `parts` entry
    // carrying that index's body VERBATIM — never a name an explicit part
    // already claims (a name claim wins, as on 0.8), each name once, capped.
    // Names are re-validated here: this is the gate that decides what becomes
    // CODE, whatever the caller passed.
    const mirrorNames: string[] = [];
    const mirrored = new Set<string>();
    for (const m of options.materialPartsMirror ?? []) {
      if (mirrorNames.length >= MAX_MIRROR_ENTRIES) break;
      const body = typeof m?.index === 'number' ? indexBodies.get(m.index) : undefined;
      if (body === undefined || !isUsableMeshName(m.name) || nameKeys.has(m.name) || mirrored.has(m.name)) continue;
      entries.push(`${moduleStringLiteral(m.name)}: { ${body} }`);
      mirrored.add(m.name);
      mirrorNames.push(m.name);
    }
    // R1: a materialParts module ALWAYS carries a `parts` object — `{}` at
    // minimum — or frozen 0.6 takes its Simple-API branch and paints every
    // mesh near-black. R3: the signature beside it. R4: the mirror list, so
    // 0.8 drops those keys from its name table in every status.
    const tableProps = [
      entries.length > 0 ? `parts: { ${entries.join(', ')} }` : 'parts: {}',
      `materialParts: { ${[...indexBodies].map(([i, b]) => `${moduleStringLiteral(String(i))}: { ${b} }`).join(', ')} }`,
      `modelSignature: { materials: [${signature.materials.map(moduleStringLiteral).join(', ')}] }`,
      ...(mirrorNames.length > 0 ? [`materialPartsMirror: [${mirrorNames.map(moduleStringLiteral).join(', ')}]`] : []),
    ];
    returnProps.push(...tableProps);
    if (partWrappers.length > 0) {
      if (!tslNames.includes('Fn')) tslNames.push('Fn');
      if (!tslNames.includes('Discard')) tslNames.push('Discard');
    }
    const tableText = tableProps.join(', ');
    if (/\bvec3\(/.test(tableText) && !tslNames.includes('vec3')) tslNames.push('vec3');
    if (/\bpositionLocal\b/.test(tableText) && !tslNames.includes('positionLocal')) {
      tslNames.push('positionLocal');
    }
    if (/\bnormalLocal\b/.test(tableText) && !tslNames.includes('normalLocal')) {
      tslNames.push('normalLocal');
    }
    // The export guard's module half (materialPartsContract): a dev build
    // throws on a shape that breaks the frozen 0.6 or confuses 0.8, so the
    // whole emission corpus is guarded in CI (vitest sets DEV). Never runs in
    // a production build.
    if (import.meta.env?.DEV) {
      const problems = checkLegacyGuard({
        hasMaterialParts: true,
        hasParts: true,
        hasSignature: true,
        partKeys: [...nameKeys, ...mirrorNames],
        mirrorKeys: mirrorNames,
      });
      if (problems.length > 0) throw new Error(`buildShaderModule: ${problems.join('; ')}`);
    }
  } else if (partsSrc) {
    if (entries.length > 0) returnProps.push(`parts: { ${entries.join(', ')} }`);
    // Imports for what the parts block itself emitted. Registered here rather
    // than beside the default's, because `hasDiscard` describes the DEFAULT
    // output only — a cutout that exists solely on one mesh would otherwise
    // emit `Fn(...)`/`Discard(...)` with neither imported, and the module dies
    // on a ReferenceError before it renders anything.
    if (partWrappers.length > 0) {
      if (!tslNames.includes('Fn')) tslNames.push('Fn');
      if (!tslNames.includes('Discard')) tslNames.push('Discard');
    }
    const partsOut = returnProps[returnProps.length - 1] ?? '';
    if (/\bvec3\(/.test(partsOut) && !tslNames.includes('vec3')) tslNames.push('vec3');
    if (/\bpositionLocal\b/.test(partsOut) && !tslNames.includes('positionLocal')) {
      tslNames.push('positionLocal');
    }
    if (/\bnormalLocal\b/.test(partsOut) && !tslNames.includes('normalLocal')) {
      tslNames.push('normalLocal');
    }
  }

  // The DEFAULT material's Transparent / Side / Alpha clip / Depth write. The
  // same emitter writes every `parts` entry's keys above, so the per-part
  // rules cannot drift from these; its comments carry the coercion reasoning.
  returnProps.push(...materialSettingProps(materialSettings));

  // The Output node's "Merge Vertices", carried to every host that runs this
  // module. The loader (0.6 and 0.8) welds a displaced PRIMITIVE's coincident vertices
  // so a displaced box does not split into floating faces; this key is how an
  // author who unticked that reaches it.
  //
  // Emitted ONLY for an explicit `false` — `=== false`, never `!== true`,
  // because the settings menu writes a literal `true` when the box is re-ticked
  // and a truthiness test would then add the key to a perfectly default node.
  // Absent means weld, matching MaterialSettings.mergeVertices' own
  // `undefined === true` contract, which is what keeps every already-exported
  // module and all 32 built-in snapshots byte-identical.
  //
  // NB this is the first key here that is not a THREE.Material property — it is
  // a geometry directive the loader reads off the module's return object rather
  // than copying onto the material. Older CDN loaders (0.4/0.5) copy named keys
  // only, so it is inert there.
  if (materialSettings?.mergeVertices === false) {
    returnProps.push('mergeVertices: false');
  }

  // The Wireframe node's EDGES mode reads a per-corner barycentric attribute,
  // and no mesh carries one by default: there is no way to recover triangle
  // corners from an indexed geometry in either backend, so the loader has to
  // build them (toNonIndexed + a `bary` attribute). This key is how the module
  // asks — the `mergeVertices` precedent: a geometry directive the loader reads
  // off the return object rather than copying onto the material, and inert on
  // the frozen 0.4/0.5 CDN loaders.
  //
  // Detected from the emitted TEXT rather than passed in, because this function
  // is handed TSL source and never sees the graph. Narrow on purpose: it is the
  // exact call graphToCode writes, so a user's own `attribute('bary')` in the
  // code panel asks for the same injection — which is right, that is the only
  // way their shader could work either.
  if (/\battribute\(\s*['"]bary['"]/.test(tslCode)) {
    returnProps.push('barycentric: true');
  }

  // --- The __pixel Fn: conditions + color as explicit params (see rule 2) -
  const pixelFnLines: string[] = [];
  if (hasDiscard) {
    const fnParams = [...condParams.filter((p): p is string => p !== null), '__color'];
    pixelFnLines.push(`  const __pixel = Fn(([${fnParams.join(', ')}]) => {`);
    // `Discard()` for an unconditional cull; `Discard(__cN)` for a conditional one.
    condParams.forEach((p) => pixelFnLines.push(`    Discard(${p ?? ''});`));
    pixelFnLines.push('    return __color;');
    pixelFnLines.push('  });');
  }

  // --- Explicit schema export so original defaults survive ----------------
  const schemaLines: string[] = [];
  if (hasParams) {
    schemaLines.push('export const schema = {');
    for (const [name, def] of Object.entries(schemaEntries)) {
      // A colour default is a hex STRING and must be quoted + typed so the
      // loader builds a Color-valued uniform instead of parseFloat-ing it to 0.
      schemaLines.push(
        typeof def === 'string'
          ? `  ${name}: { type: 'color', default: '${/^#[0-9a-fA-F]{6}$/.test(def) ? def : '#000000'}' },`
          : `  ${name}: { type: 'number', default: ${def} },`,
      );
    }
    schemaLines.push('};');
    schemaLines.push('');
  }

  // Everything below the schema, assembled FIRST: the two module-only passes
  // that follow read the code the module will actually carry.
  let code = [
    ...(preambleDecls.length ? [...preambleDecls, ''] : []),
    `export default function(${hasParams ? 'params' : ''}) {`,
    ...nonDiscardLines.map((l) => '  ' + l.trimStart()),
    ...pixelFnLines,
    // One tiny Fn per part that culls, declared beside the default's __pixel
    // for the same reason: Discard() needs an active TSL stack, so it only
    // works inside an Fn body.
    ...partWrappers.map((l) => '  ' + l),
    `  return { ${returnProps.join(', ')} };`,
    '}',
  ].join('\n');

  // --- Module-only text (graphToCode and the code panel never see it) ------
  // A baked texture's `globalThis.THREE` becomes an imported namespace, and the
  // three/tsl import is completed with every TSL function the code calls (the
  // new names appended SORTED, so an existing import line's order never moves).
  // Both make the module import standalone on plain three.js; on the loader
  // neither changes what runs.
  const three = bindThreeNamespace(code, preambleImports);
  code = three.code;
  tslNames.push(...missingTslNames(code, tslNames, preambleImports));

  const imports: string[] = [...preambleImports];
  if (three.imported) imports.push(THREE_NAMESPACE_IMPORT);
  if (tslNames.length > 0) {
    imports.push(`import { ${tslNames.join(', ')} } from 'three/tsl';`);
  }

  const lines = [
    ...(header && header.length ? [...header, ''] : []),
    ...imports,
    '',
    // The three release this module was emitted for. Loader 0.8 compares it
    // with the page's THREE.REVISION and warns (never refuses) on a mismatch;
    // 0.4–0.6 read only `default` and `schema`, so it is inert there.
    `export const threeRevision = '${THREE_REVISION}';`,
    '',
    ...schemaLines,
    code,
  ];

  return lines.join('\n') + '\n';
}
