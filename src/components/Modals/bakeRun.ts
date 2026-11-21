/**
 * BAKE TO TEXTURE — one run, from the dialog's Bake press to the commit
 * (docs/dev/baking.md). Per socket:
 *
 *   1. the module (`bakeModuleText`) is rendered by the sandboxed stage
 *      (`requestPreviewBake`) and its reply validated (`validateBakeReply`);
 *   2. the pixels become an 8-bit picture (`bakeImage`: range, dilation, sRGB);
 *   3. the picture goes through the SAME encoder a dropped picture does
 *      (`encodeImageFile`: the device's size cap, the per-image budget walk,
 *      WebP where the browser has it) and the same stash, and becomes the ONE
 *      Image node construction (`makeImageNodeFromEncode`).
 *
 * Then the project image budget is asked as every path that ADDS a payload
 * asks it, and `commitBake` writes the graph — but only if the graph still
 * renders what was baked: the modules are rebuilt from the live store and
 * compared, so an edit made while the stage was busy is never baked over.
 */
import type { AppEdge, AppNode, ShaderNodeData } from '@/types';
import { useAppStore, resolveDeviceTextureDim } from '@/store/useAppStore';
import { bakeModuleText, type BakePass } from '@/engine/bakeModule';
import { requestPreviewBake } from '@/components/Preview/previewBake';
import { BAKE_SIZES, bakeMeshFilter, type BakeSocketPlan } from '@/utils/bakePlan';
import { bakeImage, validateBakeReply, type BakeImageResult } from '@/utils/bakePixels';
import { encodeBlob, encodeImageFile } from '@/utils/imageImport';
import {
  MAX_IMAGE_DIM_RELAXED,
  exceedsImageBudgetAdding,
  makeImageNodeFromEncode,
  resolveImageDrop,
} from '@/utils/imageNode';
import { stashImageOrigin } from '@/utils/imageOriginCache';
import { getCost, imageNodeCost } from '@/utils/nodeCost';
import { loadedModelOf, shownPreviewMesh } from '@/utils/outputMaterials';
import type { BakeCommitSocket, BakedPicture } from '@/utils/bakeCommit';

/** Why a run stopped. A CLOSED set: each has its own sentence in the dialog. */
export type BakeRunError =
  | 'no-preview'     // no preview to render on
  | 'timeout'        // the stage did not answer
  | 'render'         // the stage answered with a failure (its message rides along)
  | 'bad-reply'      // the reply was not the picture asked for
  | 'non-finite'     // the shader produced NaN or Infinity
  | 'empty'          // no triangle of the shown model reached a texel
  | 'encode'         // the browser could not encode the picture
  | 'too-large'      // the picture does not fit the per-image limit
  | 'over-budget'    // the project's image budget is full
  | 'changed';       // the graph changed while baking

export type BakeRunOutcome =
  | { ok: true; images: number; parked: number }
  | {
      ok: false;
      error: BakeRunError;
      detail?: string;
      /** `over-budget` only: the dialog's "Add anyway" — commits the pictures
       *  already made, past the project budget (never past the hard caps the
       *  encoder already applied), without rendering them again. */
      proceed?: () => BakeRunOutcome;
    };

/** The largest size the dialog offers: the selected device's texture cap,
 *  raised to the relaxed cap while limits are ignored (the encoder's own rule). */
export function bakeSizeCap(): number {
  const s = useAppStore.getState();
  const cap = resolveDeviceTextureDim(s.selectedHeadsetId, s.costProfiles);
  return s.ignoreImageLimits ? Math.max(cap, MAX_IMAGE_DIM_RELAXED) : cap;
}

/** The sizes offered, smallest first (never empty: the smallest always is). */
export function bakeSizesOffered(): number[] {
  const cap = bakeSizeCap();
  const out = BAKE_SIZES.filter((s) => s <= cap);
  return out.length > 0 ? [...out] : [BAKE_SIZES[0]];
}

function fileNameFor(plan: BakeSocketPlan, pass: BakePass): string {
  const base = plan.label.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'baked';
  return `baked-${base}${pass === 'alpha' ? '-alpha' : ''}.png`;
}

async function renderPass(
  nodes: AppNode[],
  edges: AppEdge[],
  plan: BakeSocketPlan,
  pass: BakePass,
  size: number,
): Promise<BakeImageResult | { error: BakeRunError; detail?: string }> {
  const code = bakeModuleText(nodes, edges, plan, pass);
  const filter = plan.layout === 'mesh'
    ? bakeMeshFilter(nodes, edges, plan.consumers, loadedModelOf(shownPreviewMesh(useAppStore.getState())))
    : null;
  const reply = await requestPreviewBake({ code, nodes, size, layout: plan.layout, filter });
  if (!reply.ok) {
    const e = reply.error;
    if (e === 'no-preview' || e === 'timeout') return { error: e };
    return { error: e === 'no-mesh' ? 'empty' : 'render', detail: e };
  }
  const raw = validateBakeReply(reply, size);
  if (!raw) return { error: 'bad-reply' };
  const img = bakeImage(raw, {
    channels: pass === 'alpha' ? 1 : plan.shape === 1 ? 1 : plan.shape === 2 ? 2 : 3,
    colorSpace: pass === 'alpha' ? 'data' : plan.colorSpace,
    meshLayout: plan.layout === 'mesh',
  });
  return 'error' in img ? { error: img.error } : img;
}

/** A finished picture → the Image node's data, through the drop path's encoder. */
async function encodePicture(
  img: BakeImageResult,
  fileName: string,
  uvSet: number,
): Promise<BakedPicture | { error: BakeRunError }> {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { error: 'encode' };
  ctx.putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
  const blob = await encodeBlob(canvas, 'image/png');
  if (!blob) return { error: 'encode' };
  const store = useAppStore.getState();
  const res = await encodeImageFile(
    new File([blob], fileName, { type: 'image/png' }),
    store.ignoreImageLimits,
    bakeSizeCap(),
    'convert',
    // A data map stays bit-exact where the budget allows; a colour may go lossy.
    { preferLossless: img.colorSpace === 'data' },
  );
  if (!res.ok) return { error: res.reason === 'too-large' || res.reason === 'pixels' ? 'too-large' : 'encode' };
  const { payload, origin } = resolveImageDrop(res, fileName, (p) => stashImageOrigin(p, Date.now()));
  const cost = imageNodeCost(getCost('imageNode'), payload.width, payload.height);
  const data: ShaderNodeData = makeImageNodeFromEncode(payload, cost, fileName, origin);
  data.values = {
    ...data.values,
    colorSpace: img.colorSpace,
    // CLAMP, never repeat: a bake holds exactly the 0..1 square, so a repeat
    // would blend its u = 0 and u = 1 edges along every UV seam.
    repeat: 0,
    ...(uvSet === 1 || uvSet === 2 || uvSet === 3 ? { uvSet } : {}),
  };
  return { data, remap: img.remap };
}

/**
 * Bake `plans` (every one bakeable — the dialog checks) at `size`, then commit.
 * `onProgress` names the socket being rendered (0-based).
 */
export async function runBake(
  selectedIds: string[],
  plans: readonly BakeSocketPlan[],
  size: number,
  opts: { onProgress?: (index: number) => void } = {},
): Promise<BakeRunOutcome> {
  const start = useAppStore.getState();
  const nodes = start.nodes;
  const edges = start.edges;
  const sockets: BakeCommitSocket[] = [];
  const baked: { plan: BakeSocketPlan; value: string; alpha: string | null }[] = [];

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    opts.onProgress?.(i);
    const value = await renderPass(nodes, edges, plan, 'value', size);
    if ('error' in value) return { ok: false, error: value.error, detail: value.detail };
    const picture = await encodePicture(value, fileNameFor(plan, 'value'), plan.uvSet);
    if ('error' in picture) return { ok: false, error: picture.error };
    let alpha: BakedPicture | null = null;
    if (plan.shape === 4) {
      const a = await renderPass(nodes, edges, plan, 'alpha', size);
      if ('error' in a) return { ok: false, error: a.error, detail: a.detail };
      const p = await encodePicture(a, fileNameFor(plan, 'alpha'), plan.uvSet);
      if ('error' in p) return { ok: false, error: p.error };
      alpha = p;
    }
    sockets.push({ socket: { nodeId: plan.nodeId, handleId: plan.handleId }, shape: plan.shape, picture, alpha });
    baked.push({
      plan,
      value: bakeModuleText(nodes, edges, plan, 'value'),
      alpha: plan.shape === 4 ? bakeModuleText(nodes, edges, plan, 'alpha') : null,
    });
  }

  const layout = plans.some((p) => p.layout === 'mesh') ? 'mesh' : 'uv';
  const commit = (overBudgetOk: boolean): BakeRunOutcome => {
    // Still the graph that was baked? Its modules, rebuilt from the live store.
    const live = useAppStore.getState();
    for (const b of baked) {
      if (bakeModuleText(live.nodes, live.edges, b.plan, 'value') !== b.value) return { ok: false, error: 'changed' };
      if (b.alpha !== null && bakeModuleText(live.nodes, live.edges, b.plan, 'alpha') !== b.alpha) {
        return { ok: false, error: 'changed' };
      }
    }
    const payloads: string[] = [];
    for (const s of sockets) {
      for (const p of [s.picture, s.alpha]) {
        const url = p ? (p.data.values as { imageB64?: unknown }).imageB64 : undefined;
        if (typeof url === 'string') payloads.push(url);
      }
    }
    if (!overBudgetOk && exceedsImageBudgetAdding(live.nodes, payloads, live.ignoreImageLimits)) {
      return { ok: false, error: 'over-budget', proceed: () => commit(true) };
    }
    const plan = live.commitBake({ selectedIds, sockets, layout, size });
    if (!plan) return { ok: false, error: 'changed' };
    return { ok: true, images: plan.imageIds.length, parked: plan.parked };
  };
  return commit(false);
}
