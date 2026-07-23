import { useEffect, useRef } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { linkPath, pointInRect, rectCenter } from './previewLinkGeometry';
import './PreviewLink.css';

/**
 * A purely decorative, non-interactive "symbolic edge" that ties the graph's
 * Output node to the 3D preview window — a wire aimed from the Output node's
 * center toward the center of the preview canvas, so it's visually obvious
 * that the Output node is what the viewer renders.
 *
 * It is mounted as a child of `<ReactFlow>` at `z-index: -1` (same layer as
 * React Flow's own background grid): that renders it ABOVE the opaque canvas
 * background but BEHIND the node cards (pane is z1, viewport/nodes z2), and the
 * canvas pane's `overflow: hidden` clips it at the divider — so the wire
 * emerges from behind the Output node and tucks behind the code/preview frames
 * exactly as if it ran underneath them.
 *
 * Both endpoints are read straight off the DOM every animation frame (the
 * Output node's rendered box via its React Flow `data-id`, the preview via
 * `.shader-preview__body`), which tracks pan/zoom, node drags, split-pane
 * resizes and window resizes uniformly without wiring into React Flow's
 * transform. The SVG is NOT inside the transformed viewport, so client rects
 * are converted to the SVG's local space by subtracting its own bounding box —
 * which keeps the wire a constant on-screen thickness at any zoom.
 *
 * The link fades out when the Output node is panned/scrolled out of the canvas
 * viewport, and when there is no Output node or the preview hasn't laid out yet.
 */
export function PreviewLink() {
  // Primitive selector → re-render only when the Output node's identity changes.
  const outputId = useAppStore(
    (s) => s.nodes.find((n) => n.data.registryType === 'output')?.id ?? null,
  );
  const outputIdRef = useRef(outputId);
  outputIdRef.current = outputId;

  const svgRef = useRef<SVGSVGElement>(null);
  const pathRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    let raf = 0;
    let lastD = '';
    let lastShown = '';
    // Endpoint elements are CACHED across frames — a full-DOM querySelector
    // per frame scales with node count and is pure waste while the elements
    // live. Re-resolved only when missing, detached (`!isConnected` — the
    // SplitPane collapse/remount case makes this check load-bearing), or —
    // for the node — when the Output node's id changed.
    let nodeEl: HTMLElement | null = null;
    let previewEl: HTMLElement | null = null;
    let nodeElId: string | null = null;

    const escape = (id: string) =>
      (window.CSS && typeof window.CSS.escape === 'function') ? window.CSS.escape(id) : id;

    const setShown = (svg: SVGSVGElement, shown: boolean) => {
      const v = shown ? '1' : '0';
      if (v !== lastShown) {
        lastShown = v;
        svg.style.opacity = v;
      }
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const svg = svgRef.current;
      if (!svg) return;

      const id = outputIdRef.current;
      if (!nodeEl || !nodeEl.isConnected || nodeElId !== id) {
        nodeEl = id
          ? document.querySelector<HTMLElement>(`.react-flow__node[data-id="${escape(id)}"]`)
          : null;
        nodeElId = id;
      }
      if (!previewEl || !previewEl.isConnected) {
        previewEl = document.querySelector<HTMLElement>('.shader-preview__body');
      }
      if (!nodeEl || !previewEl) {
        setShown(svg, false);
        return;
      }

      // The SVG's own box is the React Flow pane (it's an absolute-positioned
      // child filling `.react-flow`). It doubles as both the coordinate origin
      // (client → local) and the viewport rect for the visibility clamp.
      // The three getBoundingClientRect calls per frame ARE the tracking
      // mechanism (pan/zoom/drag/resize all land there) — don't cache those.
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

      const startClient = rectCenter(nodeRect);
      const endClient = rectCenter(previewRect);

      // Hide when the Output node's center is outside the canvas pane (it would
      // otherwise be clipped mid-line at the edge). svgRect === the pane rect.
      // Skip the path math entirely while hidden — a wire at opacity 0 doesn't
      // need its `d` maintained.
      if (!pointInRect(startClient, svgRect, 4)) {
        setShown(svg, false);
        return;
      }
      setShown(svg, true);

      // Convert client coordinates into the SVG's local space (its origin is the
      // pane's top-left, since it is not inside the zoom/pan transform).
      const start = { x: startClient.x - svgRect.left, y: startClient.y - svgRect.top };
      const end = { x: endClient.x - svgRect.left, y: endClient.y - svgRect.top };

      const d = linkPath(start, end);
      if (d !== lastD) {
        lastD = d;
        pathRef.current?.setAttribute('d', d);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <svg ref={svgRef} className="preview-link" aria-hidden="true" style={{ opacity: 0 }}>
      <path ref={pathRef} className="preview-link__path" fill="none" d="" />
    </svg>
  );
}
