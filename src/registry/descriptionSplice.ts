import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import type { NodePath } from '@babel/traverse';
import * as t from '@babel/types';

// Handle babel traverse CJS/ESM interop (same shim as src/engine/codeToGraph.ts)
const traverse = (
  typeof (_traverse as unknown as { default: typeof _traverse }).default === 'function'
    ? (_traverse as unknown as { default: typeof _traverse }).default
    : _traverse
) as typeof _traverse;

/**
 * A single `description` or `label` string literal located in a registry source
 * file, addressed by BYTE RANGE rather than by AST node.
 *
 * `start`/`end` span the literal INCLUDING its quotes, so a splice replaces the
 * quoting too — that is what lets us swap a single-quoted source literal for a
 * JSON double-quoted one without caring which quote style the original used.
 */
export interface DescriptionSlot {
  key: string;                    // node type ('sin') or texture id ('polka-dots')
  start: number;                  // offset of the string literal INCLUDING its quotes
  end: number;                    // exclusive end offset
  value: string;                  // decoded current value (full text, incl. any "Also:" tail)
  form: 'property' | 'tuple';
}

/**
 * WHY BYTE SPLICING AND NOT @babel/generator:
 *
 * nodeRegistry.ts is a hand-maintained file: section banners (`// ===== MATH =====`),
 * deliberate blank lines, and per-entry formatting carry meaning for the humans who
 * edit it. Reprinting the AST through @babel/generator would round-trip the whole
 * file through Babel's printer, silently restyling every one of the ~1000 lines and
 * dropping/reflowing comments — a one-word description tweak would land as a
 * thousand-line diff, and any generator-vs-source disagreement (quote style, trailing
 * commas, line width) would become a permanent phantom change.
 *
 * So Babel is used ONLY as a locator: it tells us the exact byte range of each
 * description literal, and we rewrite those ranges and nothing else. Every other
 * byte of the file is preserved verbatim by construction, which is what makes the
 * no-op identity property (splice each slot with its own value → byte-identical
 * file) hold.
 */
function parseSource(source: string) {
  return parse(source, { sourceType: 'module', plugins: ['typescript'] });
}

/** Read a StringLiteral-valued property off an object literal, if present. */
function getStringProp(obj: t.ObjectExpression, name: string): t.StringLiteral | undefined {
  for (const prop of obj.properties) {
    if (!t.isObjectProperty(prop) || prop.computed) continue;
    const keyName = t.isIdentifier(prop.key)
      ? prop.key.name
      : t.isStringLiteral(prop.key)
        ? prop.key.value
        : undefined;
    if (keyName === name && t.isStringLiteral(prop.value)) return prop.value;
  }
  return undefined;
}

function toSlot(
  key: string,
  literal: t.StringLiteral,
  form: DescriptionSlot['form'],
): DescriptionSlot {
  if (literal.start == null || literal.end == null) {
    throw new Error(`descriptionSplice: literal for "${key}" has no source range`);
  }
  return { key, start: literal.start, end: literal.end, value: literal.value, form };
}

/**
 * Which tuple element holds each spliceable field, for the unary-math
 * `[type, label, description]` tuples (see locateRegistryField).
 */
const TUPLE_INDEX = { label: 1, description: 2 } as const;

export type RegistryField = keyof typeof TUPLE_INDEX;

/**
 * Collect the slots for one field of every definition in nodeRegistry.ts's
 * `definitions` array.
 *
 * WHY THERE ARE TWO FORMS:
 *
 * Most definitions are plain object literals with `label: '…'` / `description: '…'`
 * properties ('property' form). But the nine unary-math nodes (sin/cos/abs/…) are not
 * written out longhand — they share an identical shape, so the registry spreads them in
 * from a `.map()` over a `[type, label, description]` tuple array:
 *
 *   ...([['sin', 'Sine', 'Sine wave … Also: oscillate'], …]).map(([fn, label, description]) => ({
 *     type: fn, label, …, description,           // <- shorthand, no `label:`/`description:` token
 *   }))
 *
 * For those nine there is NO `label:`/`description:` key anywhere near the text — the
 * strings live at tuple elements [1] and [2] and reach the object through shorthand
 * property punning, and the node's type is tuple element [0]. A locator that only looked
 * for keyed properties would silently miss them (and a grep-based one would too), so the
 * tuple array is matched structurally as a second, equal-status form.
 *
 * WHY A DIRECT-PROPERTY READ IS ENOUGH FOR `label`:
 *
 * `getStringProp` walks only the definition object's OWN properties, so the per-socket
 * `label`s nested inside `inputs: [{ id: 'a', label: 'A', … }]` are never candidates —
 * a node label and a socket label can never be confused, which matters because socket
 * labels outnumber node labels 2:1 in this file and are keyed by English text in
 * lv.json (renaming one there would silently drop its translation).
 */
function locateRegistryField(source: string, field: RegistryField): DescriptionSlot[] {
  const ast = parseSource(source);
  const slots: DescriptionSlot[] = [];
  const tupleIndex = TUPLE_INDEX[field];

  let found = false;
  traverse(ast, {
    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      if (!t.isIdentifier(path.node.id, { name: 'definitions' })) return;
      if (!t.isArrayExpression(path.node.init)) return;
      found = true;

      for (const element of path.node.init.elements) {
        // Longhand definition: { type: 'x', …, label: '…', description: '…' }
        if (t.isObjectExpression(element)) {
          const typeLit = getStringProp(element, 'type');
          const valueLit = getStringProp(element, field);
          if (typeLit && valueLit) slots.push(toSlot(typeLit.value, valueLit, 'property'));
          continue;
        }

        // Spread of the unary-math `.map()` over [type, label, description]
        // tuples (with an optional trailing defaultValues object).
        if (t.isSpreadElement(element)) {
          for (const tuple of collectTupleArrays(element.argument)) {
            const typeEl = tuple.elements[0];
            const valueEl = tuple.elements[tupleIndex];
            if (t.isStringLiteral(typeEl) && t.isStringLiteral(valueEl)) {
              slots.push(toSlot(typeEl.value, valueEl, 'tuple'));
            }
          }
        }
      }
      path.stop();
    },
  });

  if (!found) throw new Error('descriptionSplice: could not find the `definitions` array');
  return slots;
}

/** Description slots for every definition in nodeRegistry.ts's `definitions` array. */
export function locateRegistryDescriptions(source: string): DescriptionSlot[] {
  return locateRegistryField(source, 'description');
}

/**
 * Label slots for every definition in nodeRegistry.ts's `definitions` array.
 *
 * The node DISPLAY label only — `type` is deliberately not spliceable here and must
 * never become so: it is the registry key, the `registryType` stored in every saved
 * graph, and what codeToGraph matches on, so renaming it would orphan every existing
 * `.fastshader`. The label reaches no persisted or generated artefact (see
 * nodeLabelRename.test.ts), which is exactly what makes IT safe to edit.
 */
export function locateRegistryLabels(source: string): DescriptionSlot[] {
  return locateRegistryField(source, 'label');
}

/**
 * Find the 3-element string tuples inside a spread expression.
 *
 * The spread is `...([[…], […]] as [string,string,string][]).map(fn)`, so the tuple
 * array sits behind a TSAsExpression, a parenthesized member call, or both. Rather
 * than hard-code that exact chain (which would break the moment someone drops the
 * `as` cast or the parens), walk the subtree and accept any ArrayExpression whose
 * elements are all 3-string tuples.
 */
function collectTupleArrays(argument: t.Node): t.ArrayExpression[] {
  const found: t.ArrayExpression[] = [];

  const visit = (node: t.Node | null | undefined): void => {
    if (!node) return;
    if (t.isArrayExpression(node)) {
      for (const el of node.elements) {
        if (isStringTuple(el)) found.push(el);
      }
      if (found.length > 0) return;
    }
    // Unwrap the wrappers the registry actually uses, in whatever order they appear.
    if (t.isTSAsExpression(node) || t.isTSTypeAssertion(node)) return visit(node.expression);
    if (t.isCallExpression(node)) return visit(node.callee);
    if (t.isMemberExpression(node)) return visit(node.object);
  };

  visit(argument);
  return found;
}

/**
 * A unary-math entry: `[type, label, description]`, optionally followed by a
 * defaultValues object literal (`['log2', 'Log2', '…', { x: 1 }]`) for a unary
 * whose domain excludes 0.
 *
 * The first three elements must still be string literals — that is what keeps
 * this from matching arbitrary arrays elsewhere in the file — but the arity is
 * no longer pinned at exactly 3. It was, and adding the 4th element silently
 * dropped log2 from every slot list: the Node Designer could no longer rename
 * it or edit its description, and nothing said so except two count assertions.
 */
function isStringTuple(node: t.Node | null | undefined): node is t.ArrayExpression {
  if (!t.isArrayExpression(node)) return false;
  const { elements } = node;
  if (elements.length < 3 || elements.length > 4) return false;
  if (!elements.slice(0, 3).every(el => t.isStringLiteral(el))) return false;
  return elements.length === 3 || t.isObjectExpression(elements[3]);
}

/** Collect the description slots for every entry in builtinTextures.ts's TEXTURE_ENTRIES. */
export function locateTextureDescriptions(source: string): DescriptionSlot[] {
  const ast = parseSource(source);
  const slots: DescriptionSlot[] = [];

  let found = false;
  traverse(ast, {
    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      if (!t.isIdentifier(path.node.id, { name: 'TEXTURE_ENTRIES' })) return;
      if (!t.isArrayExpression(path.node.init)) return;
      found = true;

      for (const element of path.node.init.elements) {
        if (!t.isObjectExpression(element)) continue;
        const idLit = getStringProp(element, 'id');
        const descLit = getStringProp(element, 'description');
        if (idLit && descLit) slots.push(toSlot(idLit.value, descLit, 'property'));
      }
      path.stop();
    },
  });

  if (!found) throw new Error('descriptionSplice: could not find the `TEXTURE_ENTRIES` array');
  return slots;
}

/**
 * Rewrite the located description literals in `source` with the values in `patch`
 * (keyed by node type / texture id). Slots not mentioned in `patch` are left alone.
 *
 * An unknown patch key THROWS rather than being skipped: a caller asking to update
 * 'sinn' has a typo or is working against a stale slot list, and silently writing
 * nothing would look like success while the description never changed.
 */
export function spliceDescriptions(
  source: string,
  slots: DescriptionSlot[],
  patch: Record<string, string>,
  kind = 'description',
): string {
  const byKey = new Map(slots.map(slot => [slot.key, slot]));

  for (const [key, value] of Object.entries(patch)) {
    if (!byKey.has(key)) {
      throw new Error(`descriptionSplice: no ${kind} slot for key "${key}"`);
    }
    assertSingleLine(key, value, kind);
  }

  // Right-to-left: each splice shifts every offset after it, so applying in
  // descending start order keeps the not-yet-applied slots' ranges valid.
  const pending = Object.keys(patch)
    .map(key => byKey.get(key)!)
    .sort((a, b) => b.start - a.start);

  let out = source;
  for (const slot of pending) {
    // Read the delimiter from the ORIGINAL source: `slot.start` indexes `source`,
    // and right-to-left order means bytes before the current splice are still
    // untouched in `out` anyway.
    const quote = source[slot.start] === '"' ? '"' : "'";
    out = out.slice(0, slot.start) + serializeLiteral(patch[slot.key], quote) + out.slice(slot.end);
  }
  return out;
}

/**
 * Re-serialize `value` as a TS string literal delimited by `quote`.
 *
 * JSON.stringify is the obvious tool and was the first thing tried, but it always
 * emits double quotes while both registry files are written single-quoted — so
 * every edited line flipped its quoting, turning a one-word description fix into a
 * diff that also churns style, and re-serializing an UNCHANGED value produced
 * different bytes than it read. Preserving the delimiter makes the splice a true
 * identity for untouched slots, which is what lets the no-op test below assert
 * byte-equality over all 76 descriptions at once instead of having to special-case
 * unchanged ones out of the comparison.
 *
 * Hand-escaping is safe at exactly this call site: the only characters that can
 * need escaping inside a TS string literal are the delimiter and the backslash,
 * and `assertSingleLine` has already rejected every control character. Anything
 * else (em-dashes, the apostrophes in "geometry's", quotes of the other kind) is
 * literal in the source.
 */
function serializeLiteral(value: string, quote: '"' | "'"): string {
  const escaped = value.split('\\').join('\\\\').split(quote).join('\\' + quote);
  return quote + escaped + quote;
}

/**
 * Descriptions and labels are single-line string literals. A newline would still
 * splice into syntactically valid TypeScript (JSON.stringify escapes it to \n), but it
 * would break the one-entry-per-line shape the file is maintained in, so reject it
 * at the boundary instead of letting it through.
 */
function assertSingleLine(key: string, value: string, kind = 'description'): void {
  // eslint-disable-next-line no-control-regex
  // U+2028/U+2029 are JS LineTerminators, but ES2019 made them legal INSIDE string
  // literals — so they are not a syntax error, `serializeLiteral` passes them through
  // untouched, the file still parses, and `split('\n').length` is unchanged, while every
  // editor and `git diff` renders the definition broken across two lines mid-literal.
  // That is precisely the one-entry-per-line invariant this guard protects, so they
  // belong in the class even though the \n / \r range does not reach them.
  const control = /[\u0000-\u001F\u007F\u2028\u2029]/.exec(value);
  if (control) {
    const code = control[0].charCodeAt(0).toString(16).padStart(4, '0');
    throw new Error(
      `descriptionSplice: ${kind} for "${key}" contains control character U+${code.toUpperCase()}`,
    );
  }
}

/**
 * A node label is a UI string, but it is edited by hand in the Node Designer and lands
 * in EXECUTABLE source, so it gets a real boundary rather than a trim().
 *
 * `MAX_NODE_LABEL_LENGTH` is a legibility cap, not a safety one: the label is the header
 * of a node whose width the designer authors in pixels, and it is the row text in the
 * Add-node menu (a 280px box) and on every asset tile. NodeBase.css clamps the header at
 * two lines, so a runaway label does not break layout — it just becomes an ellipsis
 * everywhere and stops being a name.
 */
export const MAX_NODE_LABEL_LENGTH = 40;

/**
 * Validate a COMPLETE key→label map — the state the registry would be in AFTER the
 * patch, not the patch alone.
 *
 * Uniqueness has to be judged against the whole map: `nodeMatchRank` tiers an exact name
 * hit above everything else, so two nodes sharing a label make that tier ambiguous and
 * the Add-node menu grows two identical-looking rows with no way to tell them apart.
 * Comparison is case-insensitive because the ranker lowercases before matching, so
 * "Multiply"/"multiply" would collide there while looking distinct here.
 *
 * Empty labels are rejected outright (a node whose name renders as "" is
 * indistinguishable from a broken registry entry), and so is surrounding whitespace —
 * it survives the splice into the source literal, is invisible in every UI, and would
 * make " Multiply" and "Multiply" read as the same name while passing the collision
 * check above.
 *
 * Throws on the FIRST problem: the caller surfaces the message verbatim, and a partial
 * "some labels applied" write is worse than none.
 */
/**
 * Zero-width and invisible characters, which `trim()` cannot see.
 *
 * Its WhiteSpace set covers the classic spaces plus U+00A0 and U+FEFF but NOT U+200B
 * ZWSP, U+200C/D, U+2060 or U+180E — so "\u200bMultiply" passes both the empty check
 * and the collision fold and produces a second, visually identical "Multiply" row in the
 * Add-node menu. That is the exact harm the whitespace rule exists to stop, wearing a
 * character that copy-paste from a web page supplies routinely; a label made ONLY of
 * them is the empty case in the same disguise.
 */
const ZERO_WIDTH = /[\u200B-\u200D\u2060\u180E\uFEFF]/;

export function assertValidNodeLabels(labels: Record<string, string>, kind = 'label'): void {
  const seen = new Map<string, string>();
  for (const [key, value] of Object.entries(labels)) {
    if (typeof value !== 'string') throw new Error(`${kind} for "${key}" must be a string`);
    assertSingleLine(key, value, kind);
    if (!value.trim()) throw new Error(`${kind} for "${key}" must not be empty`);
    if (value.trim() !== value) {
      throw new Error(`${kind} for "${key}" has leading or trailing whitespace`);
    }
    const zw = ZERO_WIDTH.exec(value);
    if (zw) {
      const code = zw[0].charCodeAt(0).toString(16).padStart(4, '0').toUpperCase();
      throw new Error(`${kind} for "${key}" contains an invisible character U+${code}`);
    }
    if (value.length > MAX_NODE_LABEL_LENGTH) {
      throw new Error(
        `${kind} for "${key}" is ${value.length} characters (max ${MAX_NODE_LABEL_LENGTH})`,
      );
    }
    const fold = value.toLowerCase();
    const owner = seen.get(fold);
    // Name BOTH sides. Callers hand in the whole post-patch map, which iterates in
    // registry order rather than "patched key last", so `owner` is whichever node comes
    // first in the FILE — for a rename of an early node that is the node being renamed,
    // and "X is already used by X" reads as nonsense. The pair is unambiguous either way.
    if (owner) throw new Error(`${kind} "${value}" for "${key}" collides with "${owner}"`);
    seen.set(fold, key);
  }
}

const ALIAS_MARKER = ' Also: ';

/**
 * Split a registry description into its human-facing head and its search-only
 * alias tail, mirroring displayDescription()'s `/\s*Also:/` split.
 *
 * The separator is uniformly `" Also: "` across all 27 tailed definitions (verified
 * against the live registry), and no description contains a second "Also:". The
 * `\s*`/`\s*` in the pattern absorb the separator's surrounding spaces so that
 * joinAliases can put back exactly one — which is what makes the round-trip
 * byte-exact rather than merely equivalent.
 */
export function splitAliases(full: string): { description: string; aliases: string } {
  const match = /^([\s\S]*?)\s*Also:\s*([\s\S]*)$/.exec(full);
  if (!match) return { description: full, aliases: '' };
  return { description: match[1], aliases: match[2] };
}

/** Inverse of splitAliases: rebuilds the stored form, tail omitted when empty. */
export function joinAliases(description: string, aliases: string): string {
  return aliases ? `${description}${ALIAS_MARKER}${aliases}` : description;
}
