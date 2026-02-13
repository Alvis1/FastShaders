import { useAppStore } from '@/store/useAppStore';
import { AddNodeMenu } from './AddNodeMenu';
import { NodeSettingsMenu } from './NodeSettingsMenu';
import { ShaderSettingsMenu } from './ShaderSettingsMenu';
import './ContextMenu.css';

export function ContextMenu() {
  const { open, x, y, type, nodeId } = useAppStore((s) => s.contextMenu);

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
    </div>
  );
}
