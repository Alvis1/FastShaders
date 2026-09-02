import { useEffect, useRef } from 'react';
import { findDefaultOutput, outputDormancyFromState } from '@/utils/outputMaterials';
import { drivingSdfOutput } from '@/utils/sdfPartition';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { useAppStore } from '@/store/useAppStore';
import { linkPath, rectCenter } from './previewLinkGeometry';
import './PreviewLink.css';

/**
 * Purely decorative, non-interactive "symbolic edges" that tie the graph's
 * Output node to the 3D preview window — ONE WIRE PER MATERIAL SECTION, each
 * leaving that section's own preview socket, so a multimesh Output visibly
 * feeds the viewer once per material (the design sketch's multimesh reading);
 * a plain single-material Output keeps the one quiet wire it always had.
 *
 * It is mounted as a child of `<ReactFlow>` at `z-index: -1` (same layer as
 * React Flow's own background grid): that renders it ABOVE the opaque canvas
 * background but BEHIND the node cards (pane is z1, viewport/nodes z2), and the
 * canvas pane's `overflow: hidden` clips it at the divider — so the wires
 * emerge from behind the Output node and tuck behind the code/preview frames
 * exactly as if they ran underneath them.
 *
 * Endpoints are read straight off the DOM every animation frame (the sockets
 * via their class inside the node's React Flow `data-id` element, the preview
 * via `.shader-preview__body`), which tracks pan/zoom, node drags, split-pane
 * resizes and window resizes uniformly without wiring into React Flow's
 * transform. The SVG is NOT inside the transformed viewport, so client rects
 * are converted to the SVG's local space by subtracting its own bounding box —
 * which keeps the wires a constant on-screen thickness at any zoom.
 *
 * The link hides ONLY when there is nothing meaningful to draw: no Output node,
 * no preview element, a collapsed pane, or an Output node rendered `display:
 * none` (a collapsed group member). It deliberately does NOT hide when the
 * Output node is merely panned off screen — see the tick loop.
 */
export function PreviewLink() {
  // Primitive selectors → re-render only when the Output's identity or its
  // MATERIAL COUNT changes (the count is how many <path> elements React must
  // keep mounted; the per-frame geometry never re-renders anything).
  // The node that FEEDS the preview: a DRIVING SDF Output (field wired)
  // replaces the Output node in emission, so the wire leaves it instead — a
  // wire from an ignored Output would claim the viewer renders what it does
  // not. An unwired SDF Output is inert and the Output keeps its wire.
  const sdfDrives = useAppStore(
    (s) => drivingSdfOutput(s.nodes, unwrapCollapsedGroupEdges(s.nodes, s.edges)) !== null,
  );
  const outputId = useAppStore(
    (s) =>
      drivingSdfOutput(s.nodes, unwrapCollapsedGroupEdges(s.nodes, s.edges))?.id
      ?? findDefaultOutput(s.nodes)?.id
      ?? null,
  );
  // VISIBLE materials only: the node hides DORMANT sections (their every
  // mesh absent from the loaded model), and each <path> here pairs with a
  // RENDERED socket — counting raw materials would leave the anchor cache
  // below chasing a socket count the DOM can never reach, re-querying every
  // frame for as long as a section sleeps. outputDormancyFromState is the
  // shared derivation (inventory-unknown hold-off + the 0.6 single-mesh
  // fallback exemption included), so this count cannot drift from what the
  // node actually renders.
  const materialCount = useAppStore((s) => outputDormancyFromState(s).visibleCount);
  const outputIdRef = useRef(outputId);
  outputIdRef.current = outputId;
  // One wire from the SDF Output (it has one section); else one per material.
  const pathCount = sdfDrives ? 1 : Math.max(1, materialCount);
  const pathCountRef = useRef(pathCount);
  pathCountRef.current = pathCount;

  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    let raf = 0;
    const lastDs: string[] = [];
    let lastShown = '';
    // Endpoint elements are CACHED across frames — a full-DOM querySelector
    // per frame scales with node count and is pure waste while the elements
    // live. Re-resolved only when missing, detached (`!isConnected` — the
    // SplitPane collapse/remount case makes this check load-bearing), when
    // the Output node's id changed, or when the socket count stops matching
    // the material count (adding/removing a material re-renders the node's
    // subtree, so the cached spans go stale together).
    let nodeEl: HTMLElement | null = null;
    let previewEl: HTMLElement | null = null;
    let nodeElId: string | null = null;
    // The wires leave the node's own OUTPUT SOCKETS — one permanently-connected
    // dot per material section, in DOM order = material order. Reading the
    // sockets' rects rather than re-deriving the points keeps the two in step:
    // move a socket in CSS and its wire follows, with no second rule.
    let anchorEls: HTMLElement[] = [];

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

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const svg = svgRef.current;
      if (!svg) return;

      // Freeze while a splitter / asset-bar grip drag is in flight. The
      // getBoundingClientRect calls below force a SYNCHRONOUS layout, and a
      // resize gesture has already dirtied the document — so this tick would
      // pay for a full layout on every frame of every drag. The wire is
      // decorative; nobody notices it holding still for the gesture, and
      // dragChrome already stamps this flag app-wide (styles/controls.css).
      if (document.documentElement.classList.contains('fs-dragging')) return;

      const id = outputIdRef.current;
      if (!nodeEl || !nodeEl.isConnected || nodeElId !== id) {
        nodeEl = id
          ? document.querySelector<HTMLElement>(`.react-flow__node[data-id="${escape(id)}"]`)
          : null;
        nodeElId = id;
        anchorEls = [];
      }
      // Re-resolved whenever any socket is missing/detached or the count no
      // longer matches the store's material count (mid-re-render frames simply
      // retry next frame — the query is scoped to the one node element).
      if (
        nodeEl &&
        (anchorEls.length !== pathCountRef.current || anchorEls.some((a) => !a.isConnected))
      ) {
        anchorEls = Array.from(
          nodeEl.querySelectorAll<HTMLElement>('.output-node__preview-socket'),
        );
      }
      if (!previewEl || !previewEl.isConnected) {
        previewEl = document.querySelector<HTMLElement>('.shader-preview__body');
      }
      const paths = svg.querySelectorAll<SVGPathElement>('path');
      // The dedupe cache must not outlive the elements it describes: a shrink
      // leaves stale entries past the new count, and a later regrow (redo,
      // "+ Add output" again) mounts FRESH <path d=""> elements at those
      // indices — with nothing moved, the recomputed d is byte-identical to
      // the stale entry, setD would skip the write, and the regrown wire
      // stayed invisible until a pan/zoom/drag changed a coordinate.
      if (lastDs.length > paths.length) lastDs.length = paths.length;
      if (!nodeEl || !previewEl || paths.length === 0) {
        setShown(svg, false);
        return;
      }

      // The SVG's own box is the React Flow pane (it's an absolute-positioned
      // child filling `.react-flow`) and serves as the coordinate origin for
      // the client → local conversion below.
      // The getBoundingClientRect calls per frame ARE the tracking mechanism
      // (pan/zoom/drag/resize all land there) — don't cache those.
      const svgRect = svg.getBoundingClientRect();
      const previewRect = previewEl.getBoundingClientRect();
      const nodeRect = nodeEl.getBoundingClientRect();
      // Preview not laid out yet, the pane collapsed, or the Output node
      // display:none (a collapsed group member — CLAUDE.md Groups convention
      // hides members without unmounting; its rect reads 0×0 at (0,0)) →
      // hide EXPLICITLY instead of relying on (0,0) falling outside the pane.
      if (svgRect.width < 1 || previewRect.width < 1 || previewRect.height < 1 || nodeRect.width < 1) {
        setShown(svg, false);
        return;
      }

      // Deliberately NO off-screen clamp. Panning the Output node out of view
      // used to hide the wire, which read as the preview losing its connection
      // exactly when the user had scrolled away to work elsewhere. The link is
      // a statement about the GRAPH ("this node is what the viewer renders"),
      // not about what happens to be on screen, so it stays drawn: the pane's
      // own `overflow: hidden` trims it, and the wires simply enter from
      // whichever edge the node sits behind. React Flow keeps off-screen nodes
      // mounted (`onlyRenderVisibleElements` is left at its default false), so
      // the off-pane rects above are real and the geometry stays correct.
      setShown(svg, true);

      const endClient = rectCenter(previewRect);
      const end = { x: endClient.x - svgRect.left, y: endClient.y - svgRect.top };

      for (let i = 0; i < paths.length; i++) {
        // Each path takes its own socket's centre; a socket not laid out yet
        // (0-height, mid-mount) falls back to the whole card for path 0 — a
        // 0-height rect would anchor the wire on the node's top edge — and
        // simply hides the extra path otherwise.
        const anchorRect = anchorEls[i]?.getBoundingClientRect();
        const usable = anchorRect && anchorRect.height >= 1;
        if (!usable && i > 0) {
          setD(paths, i, '');
          continue;
        }
        const startClient = rectCenter(usable ? anchorRect! : nodeRect);
        const start = { x: startClient.x - svgRect.left, y: startClient.y - svgRect.top };
        setD(paths, i, linkPath(start, end));
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <svg ref={svgRef} className="preview-link" aria-hidden="true" style={{ opacity: 0 }}>
      {Array.from({ length: pathCount }, (_, i) => (
        <path key={i} className="preview-link__path" fill="none" d="" />
      ))}
    </svg>
  );
}
