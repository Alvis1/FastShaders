import { memo, useCallback, type ChangeEvent } from 'react';
import { NodeResizeControl, type NodeProps } from '@xyflow/react';
import type { NoteFlowNode } from '@/types';
import { useAppStore } from '@/store/useAppStore';
import { getContrastColor } from '@/utils/colorUtils';
import { assetText, t } from '@/i18n';
import './NoteNode.css';

const DEFAULT_BODY = '#fff7cc';
const DEFAULT_HEADER = '#ffd24a';

/**
 * Sticky note — a free-floating canvas annotation with no shader semantics.
 * Renders ABOVE the resting graph (z-index, see CSS) so its text stays readable
 * over nodes/edges, and is dragged only by its colored header bar (`dragHandle`
 * on the node), so
 * the body textarea stays freely editable. Resized only from the bottom-right
 * corner (single enlarged handle) so the other edges stay clear of the text.
 * Heading + colors + scale are changed via the right-click NoteSettingsMenu;
 * only the body text is inline-editable.
 *
 * A built-in preset's explainer note shows in Latvian (`assetText`, matched on
 * the stored ENGLISH text) — display only: the node keeps its English data, so
 * a saved file never carries whoever-made-it's UI language. Typing into the
 * Latvian body stores what was typed, which then no longer matches and simply
 * shows as written, in both languages.
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
  const language = useAppStore((s) => s.language);

  const onBody = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => updateNoteData(id, { text: e.target.value }),
    [id, updateNoteData],
  );

  return (
    <div
      className={`note-node${selected ? ' note-node--selected' : ''}`}
      style={{ background: bodyColor, width: '100%', height: '100%' }}
    >
      {/* Resize from the bottom-right corner only; enlarged handle (3× the 5px
          React Flow default) for an easier grab target. */}
      {selected && (
        <NodeResizeControl
          position="bottom-right"
          color={headerColor}
          minWidth={120}
          minHeight={70}
          style={{ width: 15, height: 15, borderRadius: 0, border: '2px solid #fff' }}
        />
      )}
      {/* The header is the drag handle (see addNote's `dragHandle`). */}
      <div
        className="note-node__header"
        style={{ background: headerColor, color: headText, fontSize: `calc(12px * ${scale})` }}
        title={t('Drag to move', language)}
      >
        {/* A note's text is file data with no restore sanitizer: anything but
            a string reads as absent rather than reaching React as a child. */}
        {typeof data.heading === 'string' && data.heading ? assetText(data.heading, language) : t('Note', language)}
      </div>
      <textarea
        className="note-node__body nodrag nowheel"
        value={typeof data.text === 'string' ? assetText(data.text, language) : ''}
        onChange={onBody}
        onPointerDown={(e) => e.stopPropagation()}
        placeholder={t('Note…', language)}
        style={{ color: bodyText, fontSize: `calc(11px * ${scale})` }}
      />
    </div>
  );
});
