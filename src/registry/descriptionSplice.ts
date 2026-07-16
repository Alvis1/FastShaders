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
 * A single `description` string literal located in a registry source file,
 * addressed by BYTE RANGE rather than by AST node.
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
 * Collect the description slots for every definition in nodeRegistry.ts's
 * `definitions` array.
 *
 * WHY THERE ARE TWO FORMS:
 *
 * Most definitions are plain object literals with a `description: '…'` property
 * ('property' form). But the nine unary-math nodes (sin/cos/abs/…) are not written
 * out longhand — they share an identical shape, so the registry spreads them in from
 * a `.map()` over a `[type, label, description]` tuple array:
 *
 *   ...([['sin', 'Sine', 'Sine wave … Also: oscillate'], …]).map(([fn, label, description]) => ({
 *     type: fn, label, …, description,           // <- shorthand, no `description:` token
 *   }))
 *
 * For those nine there is NO `description:` key anywhere near the text — the string
 * lives at tuple element [2] and reaches the object through shorthand property
 * punning, and the node's type is tuple element [0]. A locator that only looked for
 * `description:` properties would silently miss them (and a grep-based one would too),
 * so the tuple array is matched structurally as a second, equal-status form.
 */
export function locateRegistryDescriptions(source: string): DescriptionSlot[] {
  const ast = parseSource(source);
  const slots: DescriptionSlot[] = [];

  let found = false;
  traverse(ast, {
    VariableDeclarator(path: NodePath<t.VariableDeclarator>) {
      if (!t.isIdentifier(path.node.id, { name: 'definitions' })) return;
      if (!t.isArrayExpression(path.node.init)) return;
      found = true;

      for (const element of path.node.init.elements) {
        // Longhand definition: { type: 'x', …, description: '…' }
        if (t.isObjectExpression(element)) {
          const typeLit = getStringProp(element, 'type');
          const descLit = getStringProp(element, 'description');
          if (typeLit && descLit) slots.push(toSlot(typeLit.value, descLit, 'property'));
          continue;
        }

        // Spread of the unary-math `.map()` over [type, label, description] tuples.
        if (t.isSpreadElement(element)) {
          for (const tuple of collectTupleArrays(element.argument)) {
            const [typeEl, , descEl] = tuple.elements;
            if (t.isStringLiteral(typeEl) && t.isStringLiteral(descEl)) {
              slots.push(toSlot(typeEl.value, descEl, 'tuple'));
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

function isStringTuple(node: t.Node | null | undefined): node is t.ArrayExpression {
  return (
    t.isArrayExpression(node) &&
    node.elements.length === 3 &&
    node.elements.every(el => t.isStringLiteral(el))
  );
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
): string {
  const byKey = new Map(slots.map(slot => [slot.key, slot]));

  for (const [key, value] of Object.entries(patch)) {
    if (!byKey.has(key)) {
      throw new Error(`descriptionSplice: no description slot for key "${key}"`);
    }
    assertSingleLine(key, value);
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
 * Descriptions are single-line string literals. A newline would still splice into
 * syntactically valid TypeScript (JSON.stringify escapes it to \n), but it would
 * break the one-description-per-line shape the file is maintained in, so reject it
 * at the boundary instead of letting it through.
 */
function assertSingleLine(key: string, value: string): void {
  // eslint-disable-next-line no-control-regex
  const control = /[\u0000-\u001F\u007F]/.exec(value);
  if (control) {
    const code = control[0].charCodeAt(0).toString(16).padStart(4, '0');
    throw new Error(
      `descriptionSplice: description for "${key}" contains control character U+${code.toUpperCase()}`,
    );
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
