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
import { isTypingTarget } from '@/utils/isTypingTarget';
import './ContextMenu.css';

/** Gap kept between the menu and the viewport edge when clamping. */
const EDGE_MARGIN = 8;

export function ContextMenu() {
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
  // renders contain one — SoundNodeSettings, GroupSettingsMenu,
  // ShaderSettingsMenu, NoteSettingsMenu, ImageNodeSettings. Chromium usually
  // swallows the keydown while a select popup is open; WebKit (Safari and the
  // Tauri WKWebView build) does not reliably, and there a dismissed dropdown
  // would take the whole settings menu with it.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // The ONE shared predicate (utils/isTypingTarget), so this dispatcher
      // and the canvas's own key handlers cannot disagree about what counts as
      // typing. It skips only the input types that take a CHARACTER, which is
      // what the paragraph above actually argues for: a checkbox or a colour
      // swatch has no in-progress edit for Escape to cancel, so Escape there
      // means "close this menu" like everywhere else on it.
      if (isTypingTarget(e.target)) return;
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
        // `nowheel` — React Flow's opt-out, which NodeEditor's own capture-phase
        // wheel listener honours too. This menu is rendered INSIDE
        // `.node-editor__canvas`, so without it a wheel aimed at the settings
        // list panned the graph out from under it (with trackpad scrolling on)
        // and the list never moved: a capture listener on an ancestor beats the
        // scroll container it is aimed at. Floating chrome over the canvas must
        // never move the canvas, scrollable or not — the canvas bar and the
        // note body carry the same class.
        className={`context-menu nowheel${type === 'canvas' ? ' context-menu--add-node' : ''}`}
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
