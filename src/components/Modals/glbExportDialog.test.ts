/**
 * What the single-GLB export dialog ANSWERS, pinned from SOURCE — the vitest
 * env is `node`, so the modal cannot be mounted, and the rule below is one a
 * wrong wiring breaks silently, in the dangerous direction:
 *
 * three of the four views resolve a `GlbTooLargeChoice` and the fourth
 * (`ready`, the fresh-click step) resolves a BOOLEAN, while ONE `cancel`
 * handler serves Escape, the backdrop and the button for all of them. It
 * answers the string 'cancel', and a string is truthy, so a `ready` ask
 * resolved with it verbatim sails through exportShader's
 * `!(await asks.glb.ready(…))` and DOWNLOADS the file the user just declined.
 * TypeScript cannot see it: `settle` casts the resolver through `(v: never)`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const MODAL = readFileSync(path.join(__dirname, 'GlbExportModal.tsx'), 'utf8');

describe('the pending ask decides what a cancel resolves', () => {
  it('the ready ask cancels with FALSE, the two dialogs with the string', () => {
    expect(MODAL).toContain("ready: (fileName, sizeBytes) => ask({ view: 'ready', fileName, sizeBytes }, false)");
    expect(MODAL).toContain("failed: (message, canBundle) => ask({ view: 'failed', message, canBundle }, 'cancel')");
    expect(MODAL).toContain("tooLarge: (request) => ask({ view: 'too-large', request }, 'cancel')");
  });

  it("onAnswer maps a 'cancel' answer onto the PENDING ask's own cancel value", () => {
    const at = MODAL.indexOf('const onAnswer = useCallback(');
    expect(at).toBeGreaterThan(-1);
    const body = MODAL.slice(at, MODAL.indexOf('[settle],', at));
    // Exactly one resolution, and it is the mapped one.
    expect([...body.matchAll(/settle\(/g)]).toHaveLength(1);
    expect(body).toMatch(/settle\(\s*answer === 'cancel' && pending \? pending\.cancel : answer\s*\)/);
    // Read before settle(), which clears the ref.
    expect(body.indexOf('pendingRef.current')).toBeLessThan(body.indexOf('settle('));
  });

  it('the ONE cancel handler still answers the string, for every view', () => {
    expect(MODAL).toContain("onAnswer('cancel');");
    // Escape, the backdrop and the button all go through it.
    expect(MODAL).toContain('preflightKeydown(e, cancel)');
    expect(MODAL).toContain('className="csv-import-modal__backdrop" onClick={cancel}');
    expect(MODAL).toContain('className="csv-import-modal__button" onClick={cancel}');
  });

  it('the other two resolution paths already use the ask’s own cancel value', () => {
    expect(MODAL).toContain('if (p) settle(p.cancel);');
    expect(MODAL).toContain("?.(p?.cancel ?? 'cancel');");
  });

  it('no other string answer can reach the boolean ask', () => {
    // The ready view offers Download and nothing else; every choice button is
    // gated on a view that resolves a GlbTooLargeChoice.
    expect(MODAL).toContain('onClick={() => onAnswer(true)}');
    for (const choice of ['full', 'webp-only', 'as-bundle']) {
      const at = MODAL.indexOf(`onAnswer('${choice}')`);
      expect(at, choice).toBeGreaterThan(-1);
      const guard = MODAL.lastIndexOf("state.view === '", at);
      expect(MODAL.slice(guard, guard + 40), choice).toMatch(/state\.view === '(too-large|failed)'/);
    }
  });
});
