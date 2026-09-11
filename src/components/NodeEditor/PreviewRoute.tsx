import { memo, useEffect, useRef } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { findDefaultOutput } from '@/utils/outputMaterials';
import { PREVIEW_CHANNEL } from '@/utils/nodePreview';
import './PreviewRoute.css';

/**
 * The STRAIGHT LINE of Preview mode (utils/nodePreview.ts): from the previewed
 * node's output socket to the Output node's Color socket — the exact route the
 * rerouted `previewCode` takes, drawn straight rather than as a wire so it can
 * never be mistaken for a connection that exists in the graph.
 *
 * Mounted inside `<ReactFlow>` beside PreviewLink and tracked the same way:
 * both sockets are read off the DOM every animation frame, which follows
 * pan/zoom, node drags and pane resizes without wiring into React Flow's
 * transform. The SVG is not inside the transformed viewport, so client rects
 * are converted to its own box and the line keeps a constant on-screen
 * thickness at any zoom. Unlike PreviewLink it sits ABOVE the node layer (z 5
 * — CSS): on a dimmed canvas the route is the one thing that must be neither
 * dimmed nor covered.
 *
 * Anchors: the source's `.react-flow__handle.source[data-handleid]` and the
 * Output's Color input handle — falling back to the card's right / left edge
 * midpoint when a handle is not mounted (the user may have hidden Color in
 * the Output's settings; the module still routes to it). Nothing is drawn
 * when the graph has no plain Output on the canvas: the module then feeds a
 * synthesized one (PREVIEW_OUTPUT_ID) and there is no socket to draw to.
 */
export const PreviewRoute = memo(function PreviewRoute() {
  const srcId = useAppStore((s) => s.nodePreview?.nodeId ?? null);
  const srcHandle = useAppStore((s) => s.nodePreview?.handleId ?? null);
  const dstId = useAppStore((s) => (s.nodePreview ? findDefaultOutput(s.nodes)?.id ?? null : null));
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!srcId || !srcHandle || !dstId) return;
    let raf = 0;
    let last = '';
    // Cached across frames, re-resolved only when missing or detached — the
    // PreviewLink rule; a full-document query per frame scales with the graph.
    let srcNode: HTMLElement | null = null;
    let dstNode: HTMLElement | null = null;
    let srcSock: HTMLElement | null = null;
    let dstSock: HTMLElement | null = null;

    const escape = (id: string) =>
      (window.CSS && typeof window.CSS.escape === 'function') ? window.CSS.escape(id) : id;
    const nodeEl = (id: string) =>
      document.querySelector<HTMLElement>(`.react-flow__node[data-id="${escape(id)}"]`);
    const sockEl = (node: HTMLElement, kind: 'source' | 'target', handle: string) =>
      node.querySelector<HTMLElement>(`.react-flow__handle.${kind}[data-handleid="${escape(handle)}"]`);
    // A socket's centre, or the card's edge midpoint when the socket is not
    // laid out (mid-mount, or hidden). Null when the node itself is not laid
    // out — display:none inside a collapsed group reads 0×0 at (0,0).
    const anchor = (
      sock: HTMLElement | null,
      node: HTMLElement,
      side: 'left' | 'right',
    ): { x: number; y: number } | null => {
      const r = sock?.getBoundingClientRect();
      if (r && r.width >= 1 && r.height >= 1) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      const n = node.getBoundingClientRect();
      if (n.width < 1 || n.height < 1) return null;
      return { x: side === 'right' ? n.right : n.left, y: n.top + n.height / 2 };
    };

    const paint = (svg: SVGSVGElement, key: string, a: { x: number; y: number } | null, b: { x: number; y: number } | null) => {
      if (key === last) return;
      last = key;
      const line = svg.querySelector<SVGLineElement>('line');
      const dots = svg.querySelectorAll<SVGCircleElement>('circle');
      if (!a || !b) {
        svg.style.opacity = '0';
        return;
      }
      svg.style.opacity = '1';
      line?.setAttribute('x1', String(a.x));
      line?.setAttribute('y1', String(a.y));
      line?.setAttribute('x2', String(b.x));
      line?.setAttribute('y2', String(b.y));
      dots[0]?.setAttribute('cx', String(a.x));
      dots[0]?.setAttribute('cy', String(a.y));
      dots[1]?.setAttribute('cx', String(b.x));
      dots[1]?.setAttribute('cy', String(b.y));
    };

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const svg = svgRef.current;
      if (!svg) return;
      // Frozen for the length of a splitter / asset-bar drag, as PreviewLink
      // is: the rect reads below force a synchronous layout on an already
      // dirtied document.
      if (document.documentElement.classList.contains('fs-dragging')) return;
      if (!srcNode || !srcNode.isConnected) { srcNode = nodeEl(srcId); srcSock = null; }
      if (!dstNode || !dstNode.isConnected) { dstNode = nodeEl(dstId); dstSock = null; }
      if (!srcNode || !dstNode) { paint(svg, 'none', null, null); return; }
      if (!srcSock || !srcSock.isConnected) srcSock = sockEl(srcNode, 'source', srcHandle);
      if (!dstSock || !dstSock.isConnected) dstSock = sockEl(dstNode, 'target', PREVIEW_CHANNEL);
      const box = svg.getBoundingClientRect();
      if (box.width < 1) { paint(svg, 'none', null, null); return; }
      const a = anchor(srcSock, srcNode, 'right');
      const b = anchor(dstSock, dstNode, 'left');
      if (!a || !b) { paint(svg, 'none', null, null); return; }
      const A = { x: a.x - box.left, y: a.y - box.top };
      const B = { x: b.x - box.left, y: b.y - box.top };
      paint(svg, `${A.x},${A.y},${B.x},${B.y}`, A, B);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [srcId, srcHandle, dstId]);

  if (!srcId || !dstId) return null;
  return (
    <svg ref={svgRef} className="preview-route" aria-hidden="true" style={{ opacity: 0 }}>
      <line className="preview-route__line" x1="0" y1="0" x2="0" y2="0" />
      <circle className="preview-route__dot" r="3.5" cx="0" cy="0" />
      <circle className="preview-route__dot" r="3.5" cx="0" cy="0" />
    </svg>
  );
});
