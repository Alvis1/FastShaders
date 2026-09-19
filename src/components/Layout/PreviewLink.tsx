import { memo, useEffect, useMemo, useRef } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { linkLabelText } from '@/components/NodeEditor/nodes/sectionLabelText';
import { resolveWireTargets, wireTargetsKey } from './previewWires';
import { RAIL_INSET, railY } from './previewRailGeometry';
import { linkPath, pickLinkAt, rectCenter, type LinkWire } from './previewLinkGeometry';
import { setLivePreviewWires } from './previewLinkHit';
import './PreviewLink.css';

/**
 * Purely decorative, non-interactive "symbolic edges" that tie the graph's
 * Output nodes to the 3D preview window — ONE WIRE PER CONTRIBUTING OUTPUT
 * NODE, each leaving that node's own preview socket, so a multi-material
 * document visibly feeds the viewer once per material and a plain single-Output
 * shader keeps the one quiet wire it always had.
 *
 * (It was one wire per material SECTION of a single stacked Output. The
 * per-material split turns that into one per NODE by construction, and the set
 * is `contributingOutputs` — the same one emission reads — so the canvas can
 * neither draw a wire from a node the module ignores nor miss one it emits.)
 *
 * It is mounted as a child of `<ReactFlow>` at `z-index: -1` (same layer as
 * React Flow's own background grid): that renders it ABOVE the opaque canvas
 * background but BEHIND the node cards (pane is z1, viewport/nodes z2), and the
 * canvas pane's `overflow: hidden` clips it at the divider.
 *
 * That clip is why each wire ends on the canvas RAIL (`previewRailGeometry`, a
 * socket per contributing Output on the pane's right edge) and no longer aims
 * at the 3D preview's centre: aiming there LOOKED like a connection and was
 * not, because the curve was cut off at the seam and never reached the pane it
 * pointed at. The preview draws its own mirroring socket at the same fraction
 * of its own height, so the pair either side of a 2px seam reads as one
 * connection — and nothing has to be drawn across two panes, which this layer
 * cannot do.
 *
 * The START endpoint is read straight off the DOM every animation frame (each
 * node's socket via its class inside that node's React Flow `data-id`
 * element), which tracks pan/zoom, node drags,
 * split-pane resizes and window resizes uniformly without wiring into React
 * Flow's transform. The SVG is NOT inside the transformed viewport, so client
 * rects are converted to the SVG's local space by subtracting its own bounding
 * box — which keeps the wires a constant on-screen thickness at any zoom.
 *
 * A wire hides ONLY when there is nothing meaningful to draw for it: its Output
 * node missing from the DOM, or rendered `display: none` (a collapsed group
 * member). It deliberately does NOT hide when the node is merely panned off
 * screen — see the tick loop.
 *
 * HOVER AND CLICK. The wire itself can never receive a pointer event:
 * `.preview-link` is a z-index -1 sibling of `.react-flow__renderer`, which is
 * itself a stacking context wrapping the hit-testable pane, so no
 * `pointer-events` value reaches it without lifting the whole layer over every
 * node card; and `isPointInStroke` falls through the wire's own
 * `stroke-dasharray` gaps. So hovering is a `pointermove` on the canvas running
 * the pure `pickLinkAt` against the endpoints this loop already has, painting a
 * hot class and a label IMPERATIVELY (a React render per pointermove is exactly
 * what this component's memo() exists to avoid), and CLICKING is React Flow's
 * own `onPaneClick` reading the same published endpoints — see previewLinkHit.
 */

/** Label offset from the pointer, and how close it may come to the pane edge. */
const LABEL_DX = 14;
const LABEL_DY = -22;
const LABEL_EDGE_PAD = 6;

/** The anchor cache's invalidation key: the contributing-id LIST, never a
 *  COUNT — two nodes swapping identity keeps the count equal while every
 *  cached element is the wrong node's. Length-prefixed so it stays injective
 *  for ids out of a `.fastshader` file, which may spell anything. */
function idsKey(wires: readonly { id: string }[]): string {
  let k = '';
  for (const w of wires) k += `${w.id.length}:${w.id};`;
  return k;
}

// memo(): rendered by NodeEditor, which re-renders every drag frame; this
// component takes no props and reads everything from its own store selectors,
// so memo is unconditionally effective. It matters more here than for the
// other canvas panels — a parent re-render NOT caused by nodes/edges
// (hoveredNodeId, an open context menu, NodeEditor's own local state) re-runs
// the whole-graph selector below, which is work no notification asked for.
export const PreviewLink = memo(function PreviewLink() {
  const language = useAppStore((s) => s.language);
  // The cheap-string two-step: subscribe to a KEY, so a position-only graph
  // notify bails on Object.is and nothing re-renders; rebuild the real list
  // from getState() only when the key moves. The key is language-free (it
  // carries the label as DATA), so a language switch re-words the labels
  // through the memo's own dependency without touching the wire set.
  // The shared key — memoized on the store slices the derivation reads, so the
  // three surfaces that draw this connection cost ONE walk per notify between
  // them rather than one each.
  const wireKey = useAppStore(wireTargetsKey);
  const wires = useMemo<{ id: string; label: string }[]>(
    () => resolveWireTargets(useAppStore.getState()).map((w) => ({
      id: w.id,
      label: linkLabelText(w.label, language),
    })),
    // wireKey is the cache key, not a value this reads — see above.
    [wireKey, language],
  );
  const pathCount = wires.length;
  const wiresRef = useRef(wires);
  wiresRef.current = wires;

  const svgRef = useRef<SVGSVGElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const lastDs: string[] = [];
    let lastShown = '';
    // Endpoint elements are CACHED across frames — a full-DOM querySelector
    // per frame scales with node count and is pure waste while the elements
    // live. Re-resolved only when missing, detached (`!isConnected` — the
    // SplitPane collapse/remount case makes this check load-bearing), or when
    // the contributing-id LIST changes.
    let nodeEls: (HTMLElement | null)[] = [];
    let anchorEls: (HTMLElement | null)[] = [];
    let cacheKey: string | null = null;
    // What the hover and the pane click measure against: the CLIENT-space
    // endpoints of the wires this loop actually DREW. Published to the shared
    // registry so NodeEditor's onPaneClick reads exactly these numbers.
    let live: LinkWire[] = [];
    // The hot wire is tracked by ID, never by index into `live`: that array is
    // rebuilt every frame, so an index survives a change of wire set while
    // naming something else entirely — the same trap the anchor cache's
    // id-list key closes one level up.
    let hotId: string | null = null;
    let labelW = 0;

    const escape = (id: string) =>
      (window.CSS && typeof window.CSS.escape === 'function') ? window.CSS.escape(id) : id;

    const setShown = (svg: SVGSVGElement, shown: boolean) => {
      const v = shown ? '1' : '0';
      if (v !== lastShown) {
        lastShown = v;
        svg.style.opacity = v;
      }
    };

    const setD = (paths: NodeListOf<SVGPathElement>, i: number, d: string) => {
      if (lastDs[i] !== d) {
        lastDs[i] = d;
        paths[i].setAttribute('d', d);
      }
    };

    const publish = (wiresNow: LinkWire[]) => {
      live = wiresNow;
      setLivePreviewWires(wiresNow);
      // A wire can stop being DRAWN without the id list moving — collapse the
      // group holding the hovered Output and its node rect goes 0x0, so the
      // path is blanked while the set is unchanged. Without this the hot class
      // sits on an empty path and the label stays up over nothing.
      if (hotId !== null && !wiresNow.some((w) => w.id === hotId)) clearHot();
    };

    /** Drop the hover state — the hot stroke and the label. Idempotent, and
     *  the ONE way out, so the cleanup, a gesture and a miss all agree. */
    const clearHot = () => {
      if (hotId !== null) {
        svgRef.current?.querySelectorAll<SVGPathElement>('path')
          .forEach((p) => p.classList.remove('preview-link__path--hot'));
        hotId = null;
      }
      const label = labelRef.current;
      if (label && !label.hidden) {
        label.hidden = true;
        label.textContent = '';
      }
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const svg = svgRef.current;
      if (!svg) return;

      // Freeze while a splitter / asset-bar seam drag is in flight. The
      // getBoundingClientRect calls below force a SYNCHRONOUS layout, and a
      // resize gesture has already dirtied the document — so this tick would
      // pay for a full layout on every frame of every drag. The wire is
      // decorative; nobody notices it holding still for the gesture, and
      // dragChrome already stamps this flag app-wide (styles/controls.css).
      if (document.documentElement.classList.contains('fs-dragging')) return;

      const list = wiresRef.current;
      const key = idsKey(list);
      if (key !== cacheKey) {
        cacheKey = key;
        nodeEls = list.map(() => null);
        anchorEls = list.map(() => null);
        // The dedupe cache describes <path> elements that now belong to other
        // nodes, and the hover state names a wire that may no longer exist.
        lastDs.length = 0;
        clearHot();
      }

      for (let i = 0; i < list.length; i++) {
        const el = nodeEls[i];
        if (!el || !el.isConnected) {
          nodeEls[i] = document.querySelector<HTMLElement>(
            `.react-flow__node[data-id="${escape(list[i].id)}"]`,
          );
          anchorEls[i] = null;
        }
        const a = anchorEls[i];
        if (!a || !a.isConnected) {
          // The wire leaves the node's own OUTPUT SOCKET — the permanently
          // connected dot the card draws. Reading its rect rather than
          // re-deriving the point keeps the two in step: move the socket in
          // CSS and the wire follows, with no second rule.
          anchorEls[i] = nodeEls[i]?.querySelector<HTMLElement>('.output-node__preview-socket') ?? null;
        }
      }

      const paths = svg.querySelectorAll<SVGPathElement>('path');
      // The dedupe cache must not outlive the elements it describes: a shrink
      // leaves stale entries past the new count, and a later regrow (an undo,
      // a re-added Output) mounts FRESH <path d=""> elements at those indices
      // — with nothing moved, the recomputed d is byte-identical to the stale
      // entry, setD would skip the write, and the regrown wire stayed
      // invisible until a pan/zoom/drag changed a coordinate.
      if (lastDs.length > paths.length) lastDs.length = paths.length;
      if (paths.length === 0) {
        setShown(svg, false);
        publish([]);
        return;
      }

      // The SVG's own box is the React Flow pane (it's an absolute-positioned
      // child filling `.react-flow`) and serves as the coordinate origin for
      // the client → local conversion below.
      // The getBoundingClientRect calls per frame ARE the tracking mechanism
      // (pan/zoom/drag/resize all land there) — don't cache those.
      const svgRect = svg.getBoundingClientRect();
      // Pane not laid out yet or collapsed → hide EXPLICITLY instead of relying
      // on (0,0) falling outside it.
      if (svgRect.width < 1 || svgRect.height < 1) {
        setShown(svg, false);
        publish([]);
        return;
      }

      // Deliberately NO off-screen clamp. Panning an Output node out of view
      // used to hide the wire, which read as the preview losing its connection
      // exactly when the user had scrolled away to work elsewhere. The link is
      // a statement about the GRAPH ("this node is what the viewer renders"),
      // not about what happens to be on screen, so it stays drawn: the pane's
      // own `overflow: hidden` trims it, and the wires simply enter from
      // whichever edge the node sits behind. React Flow keeps off-screen nodes
      // mounted (`onlyRenderVisibleElements` is left at its default false), so
      // the off-pane rects above are real and the geometry stays correct.
      // Each wire now ends on its OWN socket of the canvas rail, at the same
      // fraction of the pane's height the preview's mirroring socket sits at
      // (`previewRailGeometry`, which both ask). It used to aim at the 3D
      // preview's centre, which looked like a connection and was not: the SVG
      // lives inside `.react-flow` and `.node-editor__canvas` CLIPS it, so the
      // curve was cut off at the seam and never reached the pane it pointed at.
      // Ending on the rail is what makes the pair either side of the seam read
      // as one connection — and it needs no element in the OTHER pane at all,
      // so the lookup that used to find one is gone with it.
      const endX = svgRect.right - RAIL_INSET;

      // React writes `wiresRef` during RENDER, so for the one frame between a
      // render and its commit the list can be longer (or shorter) than the
      // paths actually in the DOM. Walk the overlap and blank the rest.
      const count = Math.min(paths.length, list.length);
      const next: LinkWire[] = [];
      for (let i = 0; i < paths.length; i++) {
        // Each wire has its OWN node, so a missing or `display: none` node (a
        // collapsed group member — the Groups convention hides members without
        // unmounting, and its rect reads 0x0) hides just that wire.
        const nodeRect = i < count ? nodeEls[i]?.getBoundingClientRect() : undefined;
        if (!nodeRect || nodeRect.width < 1) {
          setD(paths, i, '');
          continue;
        }
        // A socket not laid out yet (0-height, mid-mount) falls back to the
        // whole card: a 0-height rect would anchor the wire on the node's top
        // edge, and the card's centre is a frame's worth of wrong at most.
        const anchorRect = anchorEls[i]?.getBoundingClientRect();
        const startClient = rectCenter(
          anchorRect && anchorRect.height >= 1 ? anchorRect : nodeRect,
        );
        const start = { x: startClient.x - svgRect.left, y: startClient.y - svgRect.top };
        // This wire's own rail socket — client space, so the published
        // endpoints the hover and click hit-test against are the drawn ones.
        const endClient = { x: endX, y: railY(svgRect.top, svgRect.height, i, count) };
        const end = { x: endClient.x - svgRect.left, y: endClient.y - svgRect.top };
        setD(paths, i, linkPath(start, end));
        next.push({ id: list[i].id, label: list[i].label, start: startClient, end: endClient });
      }
      // `next` is dense and `paths` may carry blanked entries, so the hit test
      // and the hot class index the SAME array only while every path drew.
      // Publishing the drawn subset is what makes a hit always answer about a
      // wire the user can see; the hot class is looked up by id below.
      publish(next);
      setShown(svg, next.length > 0);
    };

    /** The <path> element drawing wire `id`, or null — `live` is the DRAWN
     *  subset, so its index is not the path index once a wire is hidden. */
    const pathFor = (id: string): SVGPathElement | null => {
      const l = wiresRef.current.findIndex((w) => w.id === id);
      if (l < 0) return null;
      return svgRef.current?.querySelectorAll<SVGPathElement>('path')[l] ?? null;
    };

    const onMove = (e: PointerEvent) => {
      const svg = svgRef.current;
      const label = labelRef.current;
      if (!svg || !label) return;
      // A canvas gesture owns the pointer: a node drag, a pan, a marquee or a
      // connection drag (`fs-canvas-busy`, NodeEditor's refcounted flag), or a
      // seam drag (`fs-dragging`). Nothing is being INSPECTED mid-gesture, and
      // a label following a drag is noise on top of it.
      const root = document.documentElement.classList;
      if (root.contains('fs-canvas-busy') || root.contains('fs-dragging')) {
        clearHot();
        return;
      }
      // Live only over the PANE — which is EXACTLY the condition under which a
      // press would reach React Flow's `onPaneClick`, so the hover and the
      // click can never disagree about what is hittable. It falls out for free:
      // React Flow marks the viewport and node layers `pointer-events: none`,
      // so the pane is the target for everything except a node, an edge, a
      // floating panel or the drawing layer — over any of which a wire is not
      // clickable and so must not light up either.
      const target = e.target as Element | null;
      if (!target || !target.classList || !target.classList.contains('react-flow__pane')) {
        clearHot();
        return;
      }
      const hit = pickLinkAt(live, e.clientX, e.clientY);
      if (!hit) {
        clearHot();
        return;
      }
      if (hotId !== hit.wire.id) {
        if (hotId !== null) pathFor(hotId)?.classList.remove('preview-link__path--hot');
        hotId = hit.wire.id;
        pathFor(hotId)?.classList.add('preview-link__path--hot');
        label.textContent = hit.wire.label;
        label.hidden = false;
        // ONE forced layout, and only when the text changed — not per move.
        labelW = label.offsetWidth;
      }
      // The label follows the pointer, clamped inside the pane: the wires all
      // converge on the preview, which is in the OTHER column, so a hover
      // usually happens near the canvas's right edge — where `overflow:
      // hidden` would eat an unclamped label whole.
      const r = svg.getBoundingClientRect();
      const maxX = Math.max(LABEL_EDGE_PAD, r.width - labelW - LABEL_EDGE_PAD);
      const x = Math.min(Math.max(e.clientX - r.left + LABEL_DX, LABEL_EDGE_PAD), maxX);
      const y = Math.min(Math.max(e.clientY - r.top + LABEL_DY, LABEL_EDGE_PAD), r.height - LABEL_EDGE_PAD);
      label.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    };

    raf = requestAnimationFrame(tick);
    // CAPTURE on the React Flow root: a bubble-phase listener can be cut off
    // by any descendant's stopPropagation (React Flow's own gesture code does
    // it), and this must see every move to know when the pointer LEAVES a
    // wire. It never preventDefaults and never stops propagation, so it cannot
    // interfere with a drag, a marquee or a connection.
    const host = svgRef.current?.closest('.react-flow') as HTMLElement | null;
    host?.addEventListener('pointermove', onMove, true);
    host?.addEventListener('pointerleave', clearHot);
    return () => {
      cancelAnimationFrame(raf);
      host?.removeEventListener('pointermove', onMove, true);
      host?.removeEventListener('pointerleave', clearHot);
      // Nothing imperative may outlive the canvas: the hot class would strand
      // on an element React is about to unmount anyway, but a stale registry
      // would answer a LATER pane click with wires that are no longer drawn.
      clearHot();
      setLivePreviewWires([]);
    };
  }, []);

  return (
    <>
      <svg ref={svgRef} className="preview-link" aria-hidden="true" style={{ opacity: 0 }}>
        {Array.from({ length: pathCount }, (_, i) => (
          <path key={i} className="preview-link__path" fill="none" d="" />
        ))}
      </svg>
      {/* The hover label. Its own HTML element rather than a `title` on the
          `<path>`: TooltipLayer resolves its host with `closest('[title]')`
          from an HTMLElement, so a title on an SVG element silently never
          opens one. `aria-hidden` because the wire is decorative and the
          Output node it names is already reachable and announced. */}
      <div ref={labelRef} className="preview-link__label" aria-hidden="true" hidden />
    </>
  );
});
