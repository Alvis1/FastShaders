import { useAppStore } from '@/store/useAppStore';
import { AddNodeMenu } from './AddNodeMenu';
import { NodeSettingsMenu } from './NodeSettingsMenu';
import { ShaderSettingsMenu } from './ShaderSettingsMenu';
import { EdgeContextMenu } from './EdgeContextMenu';
import { GroupSettingsMenu } from './GroupSettingsMenu';
import { NoteSettingsMenu } from './NoteSettingsMenu';
import { StripesSettingsMenu } from './StripesSettingsMenu';
import { DataVizSettingsMenu } from './DataVizSettingsMenu';
import './ContextMenu.css';

export function ContextMenu() {
  const { open, x, y, type, nodeId, edgeId } = useAppStore((s) => s.contextMenu);

  if (!open) return null;

  return (
    <div
      className="context-menu"
      style={{ left: x, top: y }}
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
  );
}
