/**
 * The double-click/double-tap "show this node's port names" gesture.
 *
 * The DOM half (the class on the React Flow wrapper, the CSS that reads it) is
 * source-pinned at the bottom — the vitest env is `node`, so there is nothing to
 * drive a real double-click against.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  DOUBLE_ACTIVATE_MS,
  isDoubleActivation,
  togglePeek,
  PEEK_EXEMPT_SELECTOR,
  PEEK_EXEMPT_NODE_TYPES,
} from './labelPeek';

describe('isDoubleActivation', () => {
  it('pairs two clicks on the same node inside the window', () => {
    expect(isDoubleActivation({ id: 'a', t: 1000 }, 'a', 1200)).toBe(true);
    expect(isDoubleActivation({ id: 'a', t: 1000 }, 'a', 1000 + DOUBLE_ACTIVATE_MS)).toBe(true);
  });

  it('does not pair a slow second click', () => {
    expect(isDoubleActivation({ id: 'a', t: 1000 }, 'a', 1000 + DOUBLE_ACTIVATE_MS + 1)).toBe(false);
  });

  it('never pairs clicks on DIFFERENT nodes, however fast', () => {
    // Two nodes clicked 5ms apart is a user moving between them, not a gesture.
    expect(isDoubleActivation({ id: 'a', t: 1000 }, 'b', 1005)).toBe(false);
  });

  it('has nothing to pair with on the first click', () => {
    expect(isDoubleActivation(null, 'a', 1000)).toBe(false);
  });

  it('refuses a backwards clock rather than pairing an ancient click', () => {
    expect(isDoubleActivation({ id: 'a', t: 5000 }, 'a', 1000)).toBe(false);
  });
});

describe('togglePeek', () => {
  it('opens, and closes on the same node again', () => {
    expect(togglePeek(null, 'a')).toBe('a');
    expect(togglePeek('a', 'a')).toBe(null);
  });

  it('moves to another node rather than showing two at once', () => {
    // Every label of one node is already a lot of text on the canvas; two
    // nodes' worth, overlapping, is not a legible answer to anything.
    expect(togglePeek('a', 'b')).toBe('b');
  });
});

describe('what keeps its own double-click', () => {
  it('exempts the controls that consume one', () => {
    for (const sel of ['input', 'textarea', 'select', '.drag-num']) {
      expect(PEEK_EXEMPT_SELECTOR).toContain(sel);
    }
  });

  it('exempts the Color node, whose body IS its swatch', () => {
    expect(PEEK_EXEMPT_NODE_TYPES.has('color')).toBe(true);
    // …and nothing else: every other node type has ports worth naming.
    expect(PEEK_EXEMPT_NODE_TYPES.size).toBe(1);
  });
});

describe('the DOM half', () => {
  const editor = readFileSync(new URL('./NodeEditor.tsx', import.meta.url), 'utf8');
  const css = readFileSync(new URL('./handles/TypedHandle.css', import.meta.url), 'utf8');

  it('drives off onNodeClick, not onNodeDoubleClick', () => {
    // A double TAP does not reliably produce a `dblclick` — which is why the
    // Color node carries a long-press beside its own onDoubleClick. Counting
    // clicks is what makes one implementation serve mouse and touch alike.
    expect(editor).toContain('onNodeClick=');
    expect(editor).not.toContain('onNodeDoubleClick=');
  });

  it('marks the node imperatively, like the open-menu class', () => {
    // A className on the node OBJECT would push through history and the
    // autosave; looking at a node's ports is not an edit.
    expect(editor).toContain("classList.add('fs-labels-shown')");
    expect(editor).toContain("classList.remove('fs-labels-shown')");
    // Node ids come out of .fastshader files, so the selector is escaped.
    expect(editor).toMatch(/fs-labels-shown[\s\S]{0,400}|CSS\.escape\(peekNodeId\)/);
  });

  it('shows the label the socket already has, in its one placement', () => {
    // A fourth trigger for the existing label — never a second bubble with
    // placement rules of its own.
    expect(css).toContain('.fs-labels-shown .typed-handle[data-tooltip]::after');
    expect(css).toContain('opacity: 1');
  });

  it('can be put away without hitting the same node again', () => {
    // Escape and a click on empty canvas: on touch there is no Escape, and on
    // a dense graph the node you peeked may be under the labels themselves.
    expect(editor).toContain('setPeekNodeId(null)');
  });
});
