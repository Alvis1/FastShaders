/**
 * Raise the dropped-shader dialog — the ONE gate the three drop surfaces (the
 * canvas, the 3D preview, the code panel) call before importing a shader file,
 * so "a drop asks Open or Add" means the same thing wherever the file landed.
 *
 * The dialog takes the file: the surface is done, and
 * `components/Modals/ShaderImportModal.tsx` owns the import and every message
 * about it. A study session asks too (since 2026-11-10; through the first
 * study round a study drop replaced the document with no question). Open
 * fires `fs:graph-imported` as before; Add is logged from its
 * `fs:graph-merged` (`import {how: 'add'}`, eval/telemetry.ts).
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

export function requestShaderImport(
  file: File,
  source: 'dom' | 'iframe' = 'dom',
  onResolved?: (outcome: 'imported' | 'failed' | 'cancelled') => void,
): void {
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
}
