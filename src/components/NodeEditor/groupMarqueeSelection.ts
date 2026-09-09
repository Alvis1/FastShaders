/**
 * What a MARQUEE selects when it is drawn inside a group frame.
 *
 * The canvas runs `SelectionMode.Partial`, so React Flow selects any node the
 * rubber band merely TOUCHES — which is right for a card and wrong for a
 * frame: an expanded group is a big transparent backdrop, so a band drawn
 * anywhere inside it overlaps it by construction. Rubber-banding two nodes
 * inside a frame therefore selected the FRAME as well, and dragging that
 * selection moved the whole group with every member in it rather than the two
 * nodes that were picked. Selecting inside a group was effectively impossible.
 *
 * The rule that replaces it: **a marquee selects an expanded frame only when
 * it has selected every one of that frame's members.** Deriving it from the
 * MEMBERS rather than from the rectangle is what makes it work at all — React
 * Flow only re-proposes a selection when its own node SET changes, so a rect
 * that grows to cover a frame without sweeping in a new node would never
 * re-select it. It also states the intent better than geometry does: you get
 * the frame when you have taken everything in it, so the drag moves the group
 * as one object; short of that you get exactly the nodes you drew around, and
 * the frame stays put.
 *
 * Consequences worth keeping in view. An EMPTY frame is never marquee-selected
 * (it has no members to have taken), which is a real gap — it is still
 * selected by its header and by the select-all key, and the alternative is a
 * frame that a band anywhere near it grabs for free. COLLAPSED groups are
 * exempt entirely: a pill stands in for a node, so it selects like one. And
 * this is scoped to the marquee — a header click selects the frame directly,
 * and `selectAll` deliberately takes frames along with everything else (it
 * dispatches straight to the store, not through here).
 */

/** The shape this rule needs off a node — a structural subset of AppNode. */
export interface MarqueeSelectionNode {
  id: string;
  type?: string;
  parentId?: string;
  selected?: boolean;
  data?: unknown;
}

/** The shape this rule needs off a change — a structural subset of NodeChange. */
export interface SelectChange {
  type: string;
  id?: string;
  selected?: boolean;
}

function isExpandedGroup(n: MarqueeSelectionNode): boolean {
  if (n.type !== 'group') return false;
  return !(n.data as { collapsed?: unknown } | undefined)?.collapsed;
}

/** How many parents deep a node sits — groups may nest. */
function depthOf(id: string, parentOf: Map<string, string | undefined>): number {
  let d = 0;
  let cur = parentOf.get(id);
  // Bounded by the node count: a `.fastshader` file could describe a parent
  // cycle, and this must not spin on one.
  const seen = new Set<string>([id]);
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    d++;
    cur = parentOf.get(cur);
  }
  return d;
}

/**
 * Rewrite a marquee's `select` changes so every EXPANDED group follows its
 * members. Returns the input array unchanged when nothing applies, so the
 * common case (no groups on the canvas) costs one scan and no allocation.
 *
 * Call this ONLY while a marquee is in progress — see the module comment.
 */
export function applyGroupMarqueeRule<C extends SelectChange>(
  nodes: MarqueeSelectionNode[],
  changes: C[],
): C[] {
  if (!changes.some((c) => c.type === 'select')) return changes;
  const groups = nodes.filter(isExpandedGroup);
  if (groups.length === 0) return changes;

  // Where every node ends up if these changes are applied as they stand.
  const selected = new Map<string, boolean>();
  const parentOf = new Map<string, string | undefined>();
  for (const n of nodes) {
    selected.set(n.id, !!n.selected);
    parentOf.set(n.id, n.parentId);
  }
  for (const c of changes) {
    if (c.type === 'select' && c.id !== undefined) selected.set(c.id, !!c.selected);
  }

  const membersOf = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parentId === undefined) continue;
    const list = membersOf.get(n.parentId);
    if (list) list.push(n.id);
    else membersOf.set(n.parentId, [n.id]);
  }

  // DEEPEST FIRST, so a nested frame's derived answer is already in `selected`
  // when its parent asks whether all of ITS members are taken.
  const ordered = [...groups].sort(
    (a, b) => depthOf(b.id, parentOf) - depthOf(a.id, parentOf),
  );
  const desired = new Map<string, boolean>();
  for (const g of ordered) {
    const members = membersOf.get(g.id) ?? [];
    const want = members.length > 0 && members.every((m) => selected.get(m) === true);
    desired.set(g.id, want);
    selected.set(g.id, want);
  }

  const out = changes.filter((c) => !(c.type === 'select' && c.id !== undefined && desired.has(c.id)));
  for (const g of groups) {
    const want = desired.get(g.id) === true;
    if (want === !!g.selected) continue;
    out.push({ type: 'select', id: g.id, selected: want } as unknown as C);
  }
  return out;
}
