import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAllDefinitions, getFlowNodeType } from '@/registry/nodeRegistry';

/**
 * "One node, one look" — the mechanical half.
 *
 * A node is drawn on four surfaces (canvas, asset tiles, the node-editor
 * overview, the Node Designer). Only `shader` flow types get there through the
 * ONE shared replica, `nodes/NodeVisual.tsx`; the rest — colour, preview
 * (noise), mathPreview, clock, mic, output — need a hand-written card in
 * NodePreviewCard.tsx, and every hand-written card is a drift site.
 *
 * The drift is never "someone redrew the node wrong". It is always one of two
 * mechanical slips, and both are checkable from source:
 *
 *  1. THE CARD RESTYLES THE NODE. `.node-preview-card .node-base:not(--exact)`
 *     carried `min-width: 100px` (plus header/badge/row overrides) to draw the
 *     hand-built cards "larger". On a FIXED-geometry node that is not a size
 *     tweak but a lie: the Mic node is 80px wide, so a 100px card frame left
 *     its 77px body 20px short of the right edge — all four output sockets
 *     floated INSIDE the card and the arm light sat off centre, while the
 *     canvas node had its sockets on the border. Time and Sine were widened
 *     past their own content the same way.
 *
 *  2. THE CARD RE-IMPLEMENTS NODE GEOMETRY. The retired
 *     `.node-preview-card__canvas--clock/--math/--noise` twins restated the
 *     live canvas sizes, and `--right-abs`/`--left-abs` hardcoded `top: 50%`
 *     of the whole card — which is why the Time tile's socket missed the
 *     clock FACE that ClockNode.css centres the live one on.
 *
 * So the rules this file enforces:
 *   • the asset-card stylesheet may SCALE and neutralize a node, never resize
 *     or reposition any part of it;
 *   • a card's socket dots carry the LIVE handle classes (CardSocket), so the
 *     node's own stylesheet places them;
 *   • a hand-written card passes the live node's class to CardShell, which is
 *     what puts that stylesheet in reach in the first place.
 *
 * None of this checks pixels — that needs a browser. It checks that the card
 * layer has no way to disagree, which is the property that actually holds up.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const css = readFileSync(here + 'NodePreviewCard.css', 'utf8');
const tsx = readFileSync(here + 'NodePreviewCard.tsx', 'utf8');

/** Class prefixes owned by a NODE's own stylesheet — off limits to the card. */
const NODE_INTERNAL =
  /\.(node-base|shader-node|mic-node|clock-node|preview-node|math-preview-node|color-node|output-node|typed-handle|react-flow__handle|drag-num)/;

/** Declarations that move or resize something. Colour/cursor/pointer-events
 *  are fine: a card may look inert, it may not look like a different node. */
const GEOMETRY_PROP =
  /^(width|height|min-width|max-width|min-height|max-height|padding|padding-[a-z]+|margin|margin-[a-z]+|font-size|top|right|bottom|left|inset|inset-[a-z]+|transform|translate|scale|rotate|gap|row-gap|column-gap|border|border-width|border-radius|border-[a-z]+-width|flex|flex-basis|zoom)$/;

/** Selector → declarations, at any nesting depth (at-rule preludes skipped). */
function cssRules(source: string): { selector: string; body: string }[] {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: { selector: string; body: string }[] = [];
  let depth = 0, start = 0, selStart = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        const selector = src.slice(selStart, start).trim();
        const body = src.slice(start + 1, i);
        // An at-rule (@media/@supports) wraps more rules — recurse into it.
        if (selector.startsWith('@')) out.push(...cssRules(body));
        else if (selector) out.push({ selector, body });
        selStart = i + 1;
      }
    }
  }
  return out;
}

describe('asset-card geometry', () => {
  it('the card stylesheet never sets geometry on a node-internal class', () => {
    const offenders: string[] = [];
    for (const { selector, body } of cssRules(css)) {
      if (!NODE_INTERNAL.test(selector)) continue;
      for (const decl of body.split(';')) {
        const prop = decl.split(':')[0]?.trim().toLowerCase();
        if (prop && GEOMETRY_PROP.test(prop)) offenders.push(`${selector} { ${prop} }`);
      }
    }
    expect(
      offenders,
      'NodePreviewCard.css is resizing/repositioning part of a node. That is how the ' +
        'mic tile ended up 100px wide around an 80px node, with its sockets floating ' +
        'inside the frame. Put the value in the NODE\'s own stylesheet and let the card ' +
        `scale it:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('every hand-written card carries the live node class', () => {
    // CardShell without nodeClassName renders a bare `.node-base`, so none of
    // the node's own geometry rules — socket insets, wrapper padding, canvas
    // size — can reach the card, and whatever it draws is a fresh replica.
    const shells = [...tsx.matchAll(/<CardShell\b([^>]*)>/g)].map((m) => m[1]);
    expect(shells.length, 'no <CardShell> usages found — did this file move?').toBeGreaterThan(0);
    const bare = shells.filter((attrs) => !/nodeClassName=/.test(attrs));
    expect(
      bare,
      'a card without nodeClassName cannot inherit its node\'s geometry — pass the ' +
        'live class (e.g. nodeClassName="clock-node")',
    ).toEqual([]);
  });

  it('card sockets are the live handle element, not a card-local dot', () => {
    // The `.node-preview-card__handle*` classes are gone on purpose: a dot the
    // card positions itself is a dot that can disagree with the node.
    expect(
      /node-preview-card__handle/.test(tsx) || /node-preview-card__handle/.test(css),
      'use <CardSocket> (real handle classes, placed inside the live wrapper) ' +
        'instead of reviving the card-local handle classes',
    ).toBe(false);
  });

  it('the hand-written-card list matches the flow types NodeVisual cannot draw', () => {
    // NodeVisual draws `shader` and nothing else, so every OTHER flow type in
    // the registry needs a branch in NodePreviewCard's dispatch. A new flow
    // type without one falls through to the generic shader card — which is how
    // the Output node once rendered as seven editable number boxes.
    const flowTypes = new Set(
      getAllDefinitions().map((d) => getFlowNodeType(d)).filter((t) => t !== 'shader'),
    );
    const missing = [...flowTypes].filter(
      (t) => !new RegExp(`flowType === '${t}'`).test(tsx),
    );
    expect(
      missing,
      `these flow types have no card branch and would render as a generic shader ` +
        `card: ${missing.join(', ')}`,
    ).toEqual([]);
  });
});
