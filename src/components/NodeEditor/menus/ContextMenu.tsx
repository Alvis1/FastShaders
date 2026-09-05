import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { AddNodeMenu } from './AddNodeMenu';
import { ConnectionStub } from './ConnectionStub';
import { NodeSettingsMenu } from './NodeSettingsMenu';
import { ShaderSettingsMenu } from './ShaderSettingsMenu';
import { RaymarchSettingsMenu } from './RaymarchSettingsMenu';
import { EdgeContextMenu } from './EdgeContextMenu';
import { GroupSettingsMenu } from './GroupSettingsMenu';
import { NoteSettingsMenu } from './NoteSettingsMenu';
import { StripesSettingsMenu } from './StripesSettingsMenu';
import { DataVizSettingsMenu } from './DataVizSettingsMenu';
import { ColormapSettingsMenu } from './ColormapSettingsMenu';
import { DataRangeSettingsMenu } from './DataRangeSettingsMenu';
import './ContextMenu.css';

/** Gap kept between the menu and the viewport edge when clamping. */
const EDGE_MARGIN = 8;

export function ContextMenu() {
  const { open, x, y, type, nodeId, edgeId, sourceNodeId, sourceHandleId } = useAppStore(
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

  // Escape closes the menu — every OTHER overlay in the app already does this
  // (the modals, GraphModal, DesignerModal, PaletteColorPicker, and the toolbar
  // popovers via useDismiss); the context-menu family was the only one without
  // it. Lives on the DISPATCHER so all menu types get it at once. Mirrors
  // useDismiss's keydown half only, NOT its capture-phase outside-click closer,
  // which would race the existing closeContextMenu path from NodeEditor's pane
  // handlers.
  //
  // The editable-target skip is load-bearing, not tidiness: DragNumberInput
  // (inputs/DragNumberInput.tsx) cancels an in-progress number edit on Escape,
  // and every settings menu is full of them — without the skip, cancelling a
  // mistyped number would also close the menu. AddNodeMenu's search box is
  // likewise an INPUT and is handled by its own onKeyDown.
  //
  // SELECT is in the skip list for the same reason as INPUT: Escape already
  // means "dismiss this dropdown" there, and five of the menus this dispatcher
  // renders contain one — MicNodeSettings, GroupSettingsMenu,
  // ShaderSettingsMenu, NoteSettingsMenu, ImageNodeSettings. Chromium usually
  // swallows the keydown while a select popup is open; WebKit (Safari and the
  // Tauri WKWebView build) does not reliably, and there a dismissed dropdown
  // would take the whole settings menu with it.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      closeContextMenu();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, closeContextMenu]);

  if (!open) return null;

  return (
    <>
      {/* A wire dropped on empty canvas opens this menu with its source pin
          pending; redraw that wire to the menu so the pending connection stays
          visible instead of being invisible state. */}
      {type === 'canvas' && sourceNodeId && sourceHandleId && (
        <ConnectionStub
          sourceNodeId={sourceNodeId}
          sourceHandleId={sourceHandleId}
          to={pos}
        />
      )}
      <div
        ref={ref}
        className={`context-menu${type === 'canvas' ? ' context-menu--add-node' : ''}`}
        style={{ left: pos.left, top: pos.top }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {type === 'canvas' && <AddNodeMenu />}
        {type === 'node' && nodeId && <NodeSettingsMenu nodeId={nodeId} />}
        {type === 'shader' && <ShaderSettingsMenu nodeId={nodeId} />}
        {type === 'raymarch' && nodeId && <RaymarchSettingsMenu nodeId={nodeId} />}
        {type === 'edge' && edgeId && <EdgeContextMenu edgeId={edgeId} />}
        {type === 'group' && nodeId && <GroupSettingsMenu nodeId={nodeId} />}
        {type === 'note' && nodeId && <NoteSettingsMenu nodeId={nodeId} />}
        {type === 'stripes' && nodeId && <StripesSettingsMenu nodeId={nodeId} />}
        {type === 'dataviz' && nodeId && <DataVizSettingsMenu nodeId={nodeId} />}
        {type === 'colormap' && nodeId && <ColormapSettingsMenu nodeId={nodeId} />}
        {type === 'dataRange' && nodeId && <DataRangeSettingsMenu nodeId={nodeId} />}
      </div>
    </>
  );
}
