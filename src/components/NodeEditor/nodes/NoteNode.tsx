import { memo, useCallback, type ChangeEvent } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import type { NoteFlowNode } from '@/types';
import { useAppStore } from '@/store/useAppStore';
import { getContrastColor } from '@/utils/colorUtils';
import './NoteNode.css';

const DEFAULT_BODY = '#fff7cc';
const DEFAULT_HEADER = '#ffd24a';

/**
 * Sticky note — a free-floating canvas annotation with no shader semantics.
 * Renders BEHIND the nodes (z-index, see CSS) so it acts as a background label,
 * and is dragged only by its colored header bar (`dragHandle` on the node), so
 * the body textarea stays freely editable. Heading + colors + scale are changed
 * via the right-click NoteSettingsMenu; only the body text is inline-editable.
 */
export const NoteNode = memo(function NoteNode({
  id,
  data,
  selected,
}: NodeProps<NoteFlowNode>) {
  const bodyColor = data.color ?? DEFAULT_BODY;
  const headerColor = data.headerColor ?? DEFAULT_HEADER;
  const scale = data.scale ?? 1;
  const bodyText = getContrastColor(bodyColor);
  const headText = getContrastColor(headerColor);
  const updateNoteData = useAppStore((s) => s.updateNoteData);

  const onBody = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => updateNoteData(id, { text: e.target.value }),
    [id, updateNoteData],
  );

  return (
    <div
      className={`note-node${selected ? ' note-node--selected' : ''}`}
      style={{ background: bodyColor, width: '100%', height: '100%' }}
    >
      <NodeResizer color={headerColor} isVisible={selected} minWidth={120} minHeight={70} />
      {/* The header is the drag handle (see addNote's `dragHandle`). */}
      <div
        className="note-node__header"
        style={{ background: headerColor, color: headText, fontSize: `calc(12px * ${scale})` }}
        title="Drag to move"
      >
        {data.heading || 'Note'}
      </div>
      <textarea
        className="note-node__body nodrag nowheel"
        value={data.text ?? ''}
        onChange={onBody}
        onPointerDown={(e) => e.stopPropagation()}
        placeholder="Note…"
        style={{ color: bodyText, fontSize: `calc(11px * ${scale})` }}
      />
    </div>
  );
});
