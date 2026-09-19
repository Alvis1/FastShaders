/**
 * THE preview rail — one socket per contributing Output, on the node editor's
 * right edge, where each decorative wire ends.
 *
 * It is the wires' far end made visible. They used to aim at the 3D preview's
 * CENTRE, which looked like a connection and was not: the SVG lives inside
 * `.react-flow` and `.node-editor__canvas` CLIPS it, so the curve was cut off
 * at the seam and never reached the pane it pointed at. Half of each disc hangs
 * past the pane's edge and is clipped away, so a socket reads as meeting the
 * seam rather than sitting beside it.
 *
 * CANVAS ONLY, and that is a decision rather than a stage. A mirroring rail was
 * built on the 3D preview's left edge and REMOVED: the two panes are different
 * boxes — the canvas starts under the toolbar and runs the column's full
 * height, the preview body starts lower still (under the preview's own control
 * bar) and is only the top pane of the right split — so a socket placed at the
 * same FRACTION of each landed at visibly different heights, which is what the
 * owner reported. Aligning them means measuring both panes in client space and
 * holding them in step through split drags, a control bar that wraps, pane
 * collapse and fullscreen: a third tracking loop for a decorative mirror. The
 * socket that carries the meaning is this one, where the wire actually ends.
 *
 * It answers two gestures:
 *  - HOVER names what the wire shades, through `linkLabelText` — the same
 *    wording the wire's own hover chip uses, so the socket and the wire cannot
 *    describe one material two ways. A plain `title`, raised by the app-wide
 *    TooltipLayer.
 *  - CLICK glides to that Output, through a CustomEvent rather than a direct
 *    `focusNode`: the rail is chrome outside <ReactFlow> and NodeEditor is what
 *    holds `fitView`.
 *
 * The EMPTY state is a single hollow socket, and clicking it adds the first
 * Output node — a graph with no Output renders nothing, and the rail is the one
 * place already saying "this is what feeds the preview".
 *
 * The CONTAINER is `pointer-events: none` with only the discs opting back in:
 * a full-height box down the canvas edge would eat presses aimed at the graph,
 * and the seam's own hit zone reaches ~4px into this pane.
 */
import { useMemo } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { linkLabelText } from '@/components/NodeEditor/nodes/sectionLabelText';
import { railFraction } from './previewRailGeometry';
import { resolveWireTargets, wireTargetsKey } from './previewWires';
import { requestAddFirstOutput, requestFocusNode } from './previewRailEvents';
import './PreviewRail.css';

/** The hollow socket's own words: it is the one control that ADDS something. */
export const RAIL_EMPTY_KEY = 'No output yet — click to add one';

export function PreviewRail() {
  const language = useAppStore((s) => s.language);
  // The cheap-string two-step: subscribe to a KEY so a notify that moves no
  // wire re-renders nothing, then rebuild the list from getState(). The key is
  // language-free (it carries the label as DATA), so a language switch re-words
  // through the memo's own dependency without touching the wire set.
  const key = useAppStore(wireTargetsKey);
  const wires = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => resolveWireTargets(useAppStore.getState()).map((w) => ({
      id: w.id,
      label: linkLabelText(w.label, language),
    })),
    [key, language],
  );

  const count = wires.length;

  return (
    <div className="preview-rail" aria-hidden="true">
      {count === 0 ? (
        <button
          type="button"
          className="preview-rail__socket preview-rail__socket--empty nodrag"
          style={{ top: `${railFraction(0, 1) * 100}%` }}
          title={t(RAIL_EMPTY_KEY, language)}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            requestAddFirstOutput();
          }}
        />
      ) : (
        wires.map((w, i) => (
          <button
            key={w.id}
            type="button"
            className="preview-rail__socket nodrag"
            style={{ top: `${railFraction(i, count) * 100}%` }}
            title={w.label}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              requestFocusNode(w.id);
            }}
          />
        ))
      )}
    </div>
  );
}
