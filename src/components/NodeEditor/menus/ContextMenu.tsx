import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Connection } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { AddNodeMenu } from './AddNodeMenu';
import { ConnectionStub } from './ConnectionStub';
import { NodeSettingsMenu } from './NodeSettingsMenu';
import { ShaderSettingsMenu } from './ShaderSettingsMenu';
import { RaymarchSettingsMenu } from './RaymarchSettingsMenu';
import { SplatSettingsMenu } from './SplatSettingsMenu';
import { EdgeContextMenu } from './EdgeContextMenu';
import { GroupSettingsMenu } from './GroupSettingsMenu';
import { NoteSettingsMenu } from './NoteSettingsMenu';
import { StripesSettingsMenu } from './StripesSettingsMenu';
import { DataVizSettingsMenu } from './DataVizSettingsMenu';
import { ColormapSettingsMenu } from './ColormapSettingsMenu';
import { DataRangeSettingsMenu } from './DataRangeSettingsMenu';
import { AttachMenu } from './AttachMenu';
import { isTypingTarget } from '@/utils/isTypingTarget';
import './ContextMenu.css';

/** Gap kept between the menu and the viewport edge when clamping. */
const EDGE_MARGIN = 8;

/** The popovers a settings menu opens portal OUT of its subtree, so a press in
 *  one must not dismiss the menu (each dismisses itself). */
const DISMISS_EXEMPT = '.palette-pop, .mesh-picker__pop';

/** `onAttach` is NodeEditor's connect path (history + `applyConnection`), handed
 *  down so the Attach list wires exactly as a dragged wire does. */
export function ContextMenu({ onAttach }: { onAttach: (c: Connection) => void }) {
  const { open, x, y, type, nodeId, edgeId, sourceNodeId, sourceHandleId, sourceHandleType } = useAppStore(
    (s) => s.contextMenu,
  );
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Opening near the right/bottom edge would otherwise push the search box and
  // list off-screen with no way to scroll them back. Measure the rendered menu
  // and clamp it into the viewport in a layout effect, i.e. before paint, so
  // the correction is never visible as a jump.
  useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(EDGE_MARGIN, Math.min(x, window.innerWidth - width - EDGE_MARGIN)),
      top: Math.max(EDGE_MARGIN, Math.min(y, window.innerHeight - height - EDGE_MARGIN)),
    });
  }, [open, x, y, type, nodeId, edgeId]);

  // Escape closes every menu type (it lives on the DISPATCHER). A typing
  // target is skipped: Escape there cancels a number edit or dismisses a
  // <select>, whose keydown WebKit does not reliably swallow.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The ONE shared predicate: only inputs that take a CHARACTER count, so
      // Escape on a checkbox or a swatch still closes the menu.
      if (isTypingTarget(e.target)) return;
      closeContextMenu();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, closeContextMenu]);

  // A press ANYWHERE else closes the menu: pointerdown in the CAPTURE phase,
  // armed only while open. Why: docs/dev/canvas-interaction.md; pinned by
  // contextMenuDismiss.test.ts.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      if (target.closest?.(DISMISS_EXEMPT)) return;
      closeContextMenu();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, closeContextMenu]);

  if (!open) return null;

  return (
    <>
      {/* A wire dropped on empty canvas opens this menu with its source pin
          pending; redraw that wire to the menu so the pending connection stays
          visible instead of being invisible state. */}
      {type === 'canvas' && sourceNodeId && sourceHandleId && sourceHandleType && (
        <ConnectionStub
          sourceNodeId={sourceNodeId}
          sourceHandleId={sourceHandleId}
          sourceHandleType={sourceHandleType}
          to={pos}
        />
      )}
      <div
        ref={ref}
        // `nowheel`: floating chrome over the canvas must never move the canvas
        // (docs/dev/canvas-interaction.md; pinned by canvasWheel.test.ts).
        className={`context-menu nowheel${type === 'canvas' ? ' context-menu--add-node' : ''}`}
        style={{ left: pos.left, top: pos.top }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {type === 'canvas' && <AddNodeMenu />}
        {type === 'node' && nodeId && <NodeSettingsMenu nodeId={nodeId} />}
        {type === 'shader' && <ShaderSettingsMenu nodeId={nodeId} />}
        {type === 'raymarch' && nodeId && <RaymarchSettingsMenu nodeId={nodeId} />}
        {type === 'splat' && nodeId && <SplatSettingsMenu nodeId={nodeId} />}
        {type === 'edge' && edgeId && <EdgeContextMenu edgeId={edgeId} />}
        {type === 'group' && nodeId && <GroupSettingsMenu nodeId={nodeId} />}
        {type === 'note' && nodeId && <NoteSettingsMenu nodeId={nodeId} />}
        {type === 'stripes' && nodeId && <StripesSettingsMenu nodeId={nodeId} />}
        {type === 'dataviz' && nodeId && <DataVizSettingsMenu nodeId={nodeId} />}
        {type === 'colormap' && nodeId && <ColormapSettingsMenu nodeId={nodeId} />}
        {type === 'dataRange' && nodeId && <DataRangeSettingsMenu nodeId={nodeId} />}
        {type === 'attach' && nodeId && <AttachMenu nodeId={nodeId} onAttach={onAttach} />}
      </div>
    </>
  );
}
