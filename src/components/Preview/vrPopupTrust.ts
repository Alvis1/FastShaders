/**
 * Does the VR popup's code need the user's word before it runs?
 *
 * The popup (ShaderPreview's `handleOpenVR`) is a TOP-LEVEL document at the
 * app's REAL origin running `previewCode`: no sandbox, and the origin's
 * localStorage, IndexedDB and Cache Storage within reach. `previewCode` has
 * exactly two writers (store/useAppStore.ts): the sync engine's graph→code
 * pass, which writes the graph's own CONNECTED-ONLY panel codegen
 * (engine/panelCode.ts `panelCodegen(…, false)`: dead chains and muted nodes
 * left out) — or, in Preview mode, that of the DERIVED graph `previewGraph`
 * builds — and `requestCodeSync`, which copies the code panel's text in on an
 * Apply or a bare-script import. The first is the validated emission (unknown
 * nodes pass the allow-list, every stored string is re-encoded); the second
 * is whatever the user typed or opened.
 *
 * So provenance is decided by RECOMPUTING, never by a flag: the text is the
 * graph's own exactly when it is byte-equal to what the sync engine makes of
 * the graph now (`vrPopupSafety.test.ts` pins the restatement to the hook's
 * text). `syncSource` cannot answer it — it is 'graph' for a Preview-mode
 * reroute and 'code' after any Apply. The cost is one codegen pass at the
 * click, two in Preview mode (milliseconds). The one spurious "no" is the
 * unknown-expression validator landing between the last pass and the click
 * (the sync engine re-runs on that, so a second click passes); a "yes" for
 * applied text needs that text to BE the graph's codegen, which is then
 * exactly what runs.
 *
 * Pure, so `vrPopupSafety.test.ts` can run it — ShaderPreview itself has never
 * been rendered in a test (see bootMeshWait.ts).
 */
import type { AppEdge, AppNode } from '@/types';
import { panelCodegen } from '@/engine/panelCode';
import { previewGraph, resolveNodePreview, type NodePreviewTarget } from '@/utils/nodePreview';

/**
 * The question asked before the popup runs code the graph did not generate —
 * the `t()` key (lv.json `ui`). It names what makes it a real decision: the
 * popup is outside the sandbox, and it can read what this site has saved.
 */
export const VR_RAW_CODE_CONFIRM_KEY =
  'The VR window will run code you applied or opened, outside the preview’s sandbox, where it can read this site’s saved data. Continue only if you trust that code.';

/**
 * True when `previewCode` is the code the sync engine writes for this graph:
 * its panel codegen, or — while a node is previewed — the derived graph's,
 * computed the way useSyncEngine computes them. FAILS CLOSED: a codegen that
 * throws cannot vouch for anything, so the answer is false and the user is
 * asked — rather than the click dying with a blank window already open.
 */
export function previewCodeIsGraphCodegen(
  previewCode: string,
  nodes: AppNode[],
  edges: AppEdge[],
  nodePreview: NodePreviewTarget | null,
): boolean {
  try {
    if (previewCode === panelCodegen(nodes, edges, false).result.code) return true;
    const live = resolveNodePreview(nodes, nodePreview);
    if (!live) return false;
    const derived = previewGraph(nodes, edges, live);
    return previewCode === panelCodegen(derived.nodes, derived.edges, false).result.code;
  } catch {
    return false;
  }
}
