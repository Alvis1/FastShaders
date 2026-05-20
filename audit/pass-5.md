# Pass 5 — Tests and resource hygiene (cap: 10 findings + 10 test cases)

- **Inventory:** count test files, name what they cover, give the fraction of source files with any test. One paragraph.
- **Dispose discipline:** `rg "new THREE\.(WebGLRenderTarget|BufferGeometry|.*Material|.*Texture)"`. For each construction site, locate the matching `.dispose()` in a cleanup path (unmount, route change, scene swap). Flag every unmatched one.
- **Event listener cleanup:** `rg "addEventListener"`. Verify each has a paired `removeEventListener` in the same component's cleanup.

## Then propose exactly 10 test cases

In priority order, format `it('description', () => { /* one-line assertion */ })`. Must include:

1. Save → load roundtrip equality for a 30-node graph.
2. Undo N times then redo N times equals the original state.
3. Deleting a node removes all incident wires.
4. Loading a malformed `.fastshader` does not crash the app or execute arbitrary code.
5. `complexity.json` produces stable points across two equivalent graphs.

The other 5 are your call based on what you actually found in earlier passes (or in this one if Pass 5 is being run standalone).

---

## Top 10 fixes (final section of this pass)

After listing the findings and the 10 test cases above, produce a **"Top 10 fixes ranked by impact-to-effort ratio"** section drawing from this pass *and any earlier pass reports the user has saved in `audit/findings/`*. If earlier reports aren't available in context, ground the Top 10 in Pass 5's findings only and say so explicitly.

This is not "the 10 worst issues" — it's the 10 most worth doing this week. Each entry: one-line description, impact (high/med/low), effort (S/M/L), and which finding(s) it resolves.
