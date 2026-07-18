import { useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { AddNodeMenu } from './AddNodeMenu';
import { ConnectionStub } from './ConnectionStub';
import { NodeSettingsMenu } from './NodeSettingsMenu';
import { ShaderSettingsMenu } from './ShaderSettingsMenu';
import { EdgeContextMenu } from './EdgeContextMenu';
import { GroupSettingsMenu } from './GroupSettingsMenu';
import { NoteSettingsMenu } from './NoteSettingsMenu';
import { StripesSettingsMenu } from './StripesSettingsMenu';
import { DataVizSettingsMenu } from './DataVizSettingsMenu';
import './ContextMenu.css';

/** Gap kept between the menu and the viewport edge when clamping. */
const EDGE_MARGIN = 8;

export function ContextMenu() {
  const { open, x, y, type, nodeId, edgeId, sourceNodeId, sourceHandleId } = useAppStore(
    (s) => s.contextMenu,
  );
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
        {type === 'shader' && <ShaderSettingsMenu />}
        {type === 'edge' && edgeId && <EdgeContextMenu edgeId={edgeId} />}
        {type === 'group' && nodeId && <GroupSettingsMenu nodeId={nodeId} />}
        {type === 'note' && nodeId && <NoteSettingsMenu nodeId={nodeId} />}
        {type === 'stripes' && nodeId && <StripesSettingsMenu nodeId={nodeId} />}
        {type === 'dataviz' && nodeId && <DataVizSettingsMenu nodeId={nodeId} />}
      </div>
    </>
  );
}
