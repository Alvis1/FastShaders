/**
 * The names a generated program may carry into the app — the only text from a
 * model's reply that survives into what the app runs (everything else the gate
 * re-emits from its own tables). See docs/dev/node-generator.md.
 *
 * Two kinds of name leave the gate:
 *  - UNIFORM names, which stay the variable name in every module the graph
 *    emits from then on (graphToCode keeps a property's own name), appear in
 *    the preview's Properties panel and the export schema, and key the tuned values
 *    persisted in `fs:previewUniformValues`;
 *  - every other const's name, which only labels its node — graphToCode mints
 *    its own names for those (`mix1`, `noise2`).
 *
 * Both must be plain ASCII identifiers that cannot shadow anything the module
 * or the loader defines: `const color = uniform(color(…))` is a TDZ error at
 * load, a uniform named `mix` beside a Mix node shadows `mix()`, and a name
 * like `constructor` reads an inherited function off the stored-values map.
 */
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { HELPER_ALIASES, MODULE_HELPERS, MODULE_HELPER_NAMES } from '@/engine/moduleHelpers';
import { FORMULA_TSL_SYMBOLS } from '@/utils/dataRangeFormula';
import { SPLAT_CONSTANTS, SPLAT_FN_PARAMS } from '@/utils/sdfPartition';
import { sanitizeIdentifier } from '@/utils/nameUtils';
import { getNodeValues, type AppNode } from '@/types';
import { safeJsonReviver } from '@/utils/safeJson';
import { sanitizeUniformBounds, sanitizeUniformValues } from '@/utils/uniformOverride';

/** A name the gate keeps as written: ASCII letter first, then letters, digits
 *  or `_`, at most 32 characters. Checked by explicit code-unit ranges, never
 *  by `normalize()` or a Unicode class. */
export const MAX_NAME_LENGTH = 32;

function isAsciiLetter(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

export function isPlainName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return false;
  if (!isAsciiLetter(name.charCodeAt(0))) return false;
  for (let i = 1; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (!isAsciiLetter(c) && !(c >= 0x30 && c <= 0x39) && c !== 0x5f) return false;
  }
  return true;
}

const JS_WORDS = [
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import',
  'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private', 'protected', 'public',
  'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while',
  'with', 'yield', 'arguments', 'eval', 'undefined', 'NaN', 'Infinity', 'async', 'of', 'get', 'set',
];

/** Names inherited from Object.prototype — a stored-values map is a plain `{}`. */
const PROTOTYPE_NAMES = Object.getOwnPropertyNames(Object.prototype);

/** Globals a generated module, the loader or an export page may read by name. */
const GLOBAL_NAMES = [
  'globalThis', 'window', 'self', 'document', 'location', 'navigator', 'console', 'Math', 'JSON', 'Object',
  'Array', 'Number', 'String', 'Boolean', 'Symbol', 'BigInt', 'Function', 'Reflect', 'Proxy', 'Promise',
  'Date', 'RegExp', 'Error', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Intl', 'fetch', 'THREE', 'AFRAME',
];

/** Names the module itself defines or the app's pipeline reads by name:
 *  the wrapper and its PARAMETER (`export default function(params)` reads each
 *  uniform as `const <name> = params.<key>;` — the module renames a body local
 *  named `params` to `_params` so it still loads (tslCodeProcessor.ts fixTDZ),
 *  but a generated uniform never needs that rename), the
 *  shaderloader exports (`schema`, `parts`, `threeRevision`, `materialParts`),
 *  the loader's `src` key (a uniform named `src` makes the A-Frame page load no
 *  shader at all), and the parser's sink keyword. */
const MODULE_NAMES = ['Fn', 'shader', 'params', 'src', 'schema', 'parts', 'materialParts', 'threeRevision', 'output', 'Discard', 'If', 'Loop'];

/**
 * Every name graphToCode imports by LITERAL — `addImport('three/tsl', 'texture')`
 * and friends, the SDF Output's import list, the splat light's — so a live
 * module can import it whatever the registry says. `gate.test.ts` scans
 * graphToCode.ts and fails on one missing here: the drift pair a synthetic test
 * cannot catch. (The Data Range formula's functions and the splat constants'
 * imports are read from their own tables, below.)
 */
export const CODEGEN_LITERAL_IMPORTS = [
  'Fn', 'uv', 'mul', 'sub', 'add', 'cos', 'sin', 'float', 'texture', 'equirectUV', 'color', 'mix', 'dFdx', 'dFdy',
  'attribute', 'uniform', 'positionGeometry', 'normalMap', 'Discard', 'mat2', 'vec2', 'vec3', 'vec4', 'int',
  'Loop', 'If', 'Break', 'max', 'min', 'clamp', 'dot', 'length', 'normalize', 'select', 'frontFacing',
  'cameraPosition', 'modelWorldMatrixInverse', 'modelWorldMatrix', 'transformDirection', 'positionLocal', 'div',
] as const;

function buildReserved(): ReadonlySet<string> {
  const out = new Set<string>([...JS_WORDS, ...PROTOTYPE_NAMES, ...GLOBAL_NAMES, ...MODULE_NAMES, ...CODEGEN_LITERAL_IMPORTS]);
  // Every function a node of ANY type can make the live module import — the
  // catalogue offers fewer, but a parked group shares a module with the graph.
  for (const def of NODE_REGISTRY.values()) if (def.tslFunction) out.add(def.tslFunction);
  for (const [name, helper] of MODULE_HELPERS) {
    out.add(name);
    for (const imp of helper.imports) out.add(imp);
  }
  for (const name of HELPER_ALIASES.keys()) out.add(name);
  // Imports chosen at emission time from tables of their own.
  for (const name of FORMULA_TSL_SYMBOLS) out.add(name);
  for (const c of SPLAT_CONSTANTS) for (const name of c.imports) out.add(name);
  return out;
}

/** Exact names a generated identifier may never take. */
export const RESERVED_NAMES: ReadonlySet<string> = buildReserved();

/**
 * Name shapes codeToGraph gives a meaning of their own: the Raymarch and
 * Splat Output's per-socket declarators (`rm1Field`, `sp2Shade`), the parser's
 * Append and argument placeholders (`append3`, `__arg1_0`), Split labels.
 */
const SPECIAL_SHAPES = [/^(rm|sp)\d/, /^append\d*$/, /^split_/];

export function isReservedName(name: string): boolean {
  return RESERVED_NAMES.has(name) || SPECIAL_SHAPES.some((re) => re.test(name));
}

/** Latvian letters → their base letters, so `ātrums` keeps its meaning as
 *  `atrums` instead of collapsing to `_trums`. Anything else non-ASCII drops. */
const FOLD: Record<string, string> = {
  ā: 'a', č: 'c', ē: 'e', ģ: 'g', ī: 'i', ķ: 'k', ļ: 'l', ņ: 'n', š: 's', ū: 'u', ž: 'z', ō: 'o', ŗ: 'r',
  Ā: 'A', Č: 'C', Ē: 'E', Ģ: 'G', Ī: 'I', Ķ: 'K', Ļ: 'L', Ņ: 'N', Š: 'S', Ū: 'U', Ž: 'Z', Ō: 'O', Ŗ: 'R',
};

/** The closest plain name to `raw`, or '' when nothing usable is left. */
export function plainBase(raw: string): string {
  let s = '';
  for (const ch of raw) {
    const folded = FOLD[ch] ?? ch;
    const c = folded.charCodeAt(0);
    if (folded.length === 1 && (isAsciiLetter(c) || (c >= 0x30 && c <= 0x39) || c === 0x5f)) s += folded;
  }
  s = s.replace(/^[^A-Za-z]+/, '').slice(0, MAX_NAME_LENGTH - 3);
  return s;
}

/**
 * Claim a name the way graphToCode does for properties (`bareFirst`): the bare
 * base when it is free, else base2, base3, … The claimed name is added to
 * `taken`.
 */
export function claimName(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name) || isReservedName(name); n++) name = `${base}${n}`;
  taken.add(name);
  return name;
}

/**
 * The property names the LIVE graph's module uses — each property node's
 * sanitized name, claimed in turn so duplicates take the `2`, `3` … names
 * graphToCode would give them. A generated uniform must avoid every one, or
 * graphToCode renames one of the two (possibly the user's).
 */
export function liveUniformNames(nodes: readonly AppNode[]): Set<string> {
  // graphToCode's namer starts with every module-helper name taken, and the
  // splat parameters while a Splat Output drives (seeded always here — the
  // cautious side): a live property named `hsl` is emitted as `hsl2`.
  const taken = new Set<string>([...MODULE_HELPER_NAMES, ...SPLAT_FN_PARAMS]);
  for (const n of nodes) {
    const type = n.data.registryType;
    if (type !== 'property_float' && type !== 'property_color') continue;
    // graphToCode's own read: `String(name ?? 'property1')` (getNodeValues has
    // already dropped an entry that cannot be coerced).
    const raw = getNodeValues(n).name;
    const base = sanitizeIdentifier(raw == null ? 'property1' : String(raw));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}${i}`;
    taken.add(name);
  }
  return taken;
}

/**
 * The uniform names that already carry a TUNED value or range in this browser.
 * Uniform values persist by NAME, so a generated uniform that reuses one would
 * start at somebody else's tuning. Both maps are adversarial (a project import
 * writes them verbatim) and are read through their own sanitizers.
 */
export function storedUniformNames(read: (key: string) => string | null): Set<string> {
  const out = new Set<string>();
  for (const [key, sanitize] of [
    ['fs:previewUniformValues', sanitizeUniformValues],
    ['fs:previewUniformBounds', sanitizeUniformBounds],
  ] as const) {
    try {
      const raw = read(key);
      if (!raw) continue;
      for (const name of Object.keys(sanitize(JSON.parse(raw, safeJsonReviver)))) out.add(name);
    } catch {
      // Unreadable storage contributes nothing.
    }
  }
  return out;
}
