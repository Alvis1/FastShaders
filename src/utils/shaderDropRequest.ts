/**
 * Raise the dropped-shader dialog — the ONE gate the three drop surfaces (the
 * canvas, the 3D preview, the code panel) call before importing a shader file,
 * so "a drop asks Open or Add" means the same thing wherever the file landed.
 *
 * Returns TRUE when the dialog has taken the file: the surface is done, and
 * `components/Modals/ShaderImportModal.tsx` owns the import and every message
 * about it. FALSE means the dialog is not offered here and the caller runs its
 * own import, unchanged — which is exactly one case:
 *
 *   A STUDY SESSION. `/eval`, `/evalpro` and `/evalp` keep today's drop, byte
 *   for byte: a drop replaces the document with no question. A dialog is a UI
 *   change, and a study measures the editor as the participants in front of it
 *   were given it — the same reason the model-drop dialog is never offered
 *   there (`docs/dev/eval-mode.md`). It also keeps `fs:graph-imported` firing
 *   where the telemetry chokepoints expect it.
 *
 * SECURITY. `source` records where the drop landed, for the record only. An
 * iframe-forwarded drop must already have passed its surface's
 * forwarded-shader `window.confirm` BEFORE it gets here — sandboxed shader
 * code can forge a drop, and a dialog it forged is one the user might answer.
 * The confirm stays on the surface that received the message, where the
 * decision about trusting the sandbox belongs.
 */
import { useAppStore } from '@/store/useAppStore';
import { generateId } from '@/utils/idGenerator';
import { sanitizeDroppedName } from '@/utils/shaderDropName';
import { isEvalMode } from '@/eval/evalMode';

export function requestShaderImport(
  file: File,
  source: 'dom' | 'iframe' = 'dom',
  onResolved?: (outcome: 'imported' | 'failed' | 'cancelled') => void,
): boolean {
  if (isEvalMode()) return false;
  useAppStore.getState().enqueueShaderImport({
    id: generateId(),
    file,
    onResolved,
    // A dropped file name is attacker-chosen and this one is RENDERED — the
    // dialog's title and every message it shows. Bounded here, once, so no
    // reader of the queue has to remember to do it.
    fileName: sanitizeDroppedName(file.name) || file.name.slice(0, 64),
    source,
  });
  return true;
}
