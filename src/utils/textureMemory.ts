/**
 * The texture-memory FIGURE: bytes of GPU memory the ACTIVE sink's textures
 * take. A NUMBER, not a verdict: no headset memory budget has been measured,
 * so nothing here compares it against a limit or raises a warning. Points
 * (nodeCost.ts) price per-pixel TIME; this is the second currency they leave
 * unpriced, reported beside them rather than folded in.
 *
 * Arithmetic, per UNIQUE texture:
 *   - 4 B/texel (RGBA8: every Image-node Texture is an HTMLImageElement source
 *     at three's default RGBAFormat).
 *   - A colour image is mipmapped (a Nearest one too: it gets
 *     NearestMipmapNearestFilter), so it is summed over its EXACT mip chain,
 *     not the x4/3 rule of thumb: the exact sum is an integer, within 2 bytes
 *     of ceil(x4/3) at every pinned size, and x4/3 slightly UNDER-counts a
 *     non-square texture (16x8: 683 against the real 684). A data map has no
 *     mipmaps (x1) -- graphToCode emits `generateMipmaps = false` for it.
 *   - An image wired FROM ITS COLOR SOCKET (`out`) into the Environment
 *     channel of a material graphToCode EMITS (material 0, or an added material naming a mesh -- an empty one
 *     or an `m<n>:` handle past the node's materials emits no envNode; an
 *     Alpha/R/G/B socket emits a scalar `vec3(imageN.a)` ambient, which
 *     builds no PMREM) is also prefiltered by three r184's PMREMGenerator
 *     (EnvironmentNode wraps a texture envNode in `pmremTexture`, cached per
 *     renderer + texture): a cubeUV render target PLUS its persistent
 *     same-size ping-pong target, each
 *     3*max(c, 112) x 4c texels of HalfFloat RGBA (8 B) with
 *     c = 2^floor(log2(W/4)). For a 2048x1024 equirect that is 48 MiB beside
 *     the image's own 10.7 MiB, so leaving it out would under-report an
 *     env-lit shader about 5.5x. The test reads three's source text and fails if
 *     those internals move (the r186 bump is planned).
 *
 * "Unique" is graphToCode's texture-sharing key (engine/imageTexturePlan.ts):
 * the payload x `readImageTextureSpec` (colour space, Nearest, Repeat,
 * Texture.flipY). UV maths -- tile, offset, the Flip X/Y checkboxes, a wired
 * uv -- never enters it. The planner keys on the CANONICAL payload (re-encoded
 * from the decoded bytes); this module keys on the RAW stored string, because
 * decoding every payload for a menu line is waste and `imageAssets` sits
 * behind a store import chain. The two are equal for every payload the app
 * writes; a crafted duplicate in non-canonical base64 over-reports by one
 * texture, which is the safe direction. A test pins the count to the number of
 * `new THREE.Texture(` graphToCode emits.
 *
 * "Reachable" is the set `computeReachableCost` prices: the active sink's
 * upstream closure over UNWRAPPED edges (the caller unwraps, as it does for
 * the cost walk -- otherwise a feeder inside a collapsed group drops out).
 * graphToCode still emits a Texture for an unreachable Image node, but nothing
 * samples it, so three never uploads it; the figure is GPU-only by design.
 *
 * Stored dimensions are ADVERSARIAL (they come out of `.fastshader` files):
 *   - A texture EXISTS iff emission would create one: the payload passes the
 *     `validImageDataUrl` whitelist AND decodeImageNode's COERCED dimension
 *     gate (`Number(x)` an integer in 1..8192, so `true` passes as 1).
 *   - Its stored size is TRUSTED only under imageNodeCost's STRICT gate
 *     (typeof number, integer, 1..8192). One that exists but fails it is
 *     sized at UNTRUSTED_TEXTURE_SIDE squared -- the size imageNodeCost's flat
 *     fallback prices -- so junk can neither vanish nor print NaN.
 *   - Stored dimensions can still UNDERSTATE a payload's real size (a file
 *     can claim 8x8 over a 2048-square image). That is the trust imageNodeCost
 *     extends too; reading the image header on the trusted side would close it.
 *
 * NOT counted: the preview model's own authored textures (the trusted side
 * never parses model bytes; the GLB import turns them into Image nodes), the
 * data nodes' LUT/column textures (each at most 8192x1 texels, i.e. KB),
 * driver padding, and the browser's CPU-side decoded copy of each image. An
 * atob-invalid payload that passes the regex IS counted although emission
 * falls back to vec3(0) -- an over-report reachable only from a crafted file.
 *
 * Import rule (the costTable.ts lesson): `outputMaterials` reaches the store
 * through `exposedPorts -> edgeUtils`, so this module sits on the store's
 * import cycle. That is harmless only while nothing here EVALUATES an import
 * at module scope -- every imported function is called inside a function
 * body, and the module-scope constants are literals. It must not import
 * edgeUtils, nodeCost or the store directly (the test pins that).
 */
import type { AppNode, AppEdge } from '@/types';
import { getNodeValues } from '@/types';
import { activeSink } from './sdfPartition';
import { parseChannelHandle, outputMaterials, materialTargetNames } from './outputMaterials';
import { validImageDataUrl } from './imageNode';
import { isImageChannelHandle } from './imageChannels';
import { readImageTextureSpec, imageTextureSpecKey } from './imageTextureSpec';
import { formatMiB } from './formatSize';
import { fillTemplate } from './fillTemplate';
import { t, type Language } from '@/i18n';

/** RGBA8: every Image-node Texture (Texture.format default RGBAFormat, image source). */
export const TEXTURE_BYTES_PER_TEXEL = 4;
/** HalfFloat RGBA: three r184 PMREMGenerator's `_createRenderTarget`. */
export const PMREM_BYTES_PER_TEXEL = 8;
/** decodeImageNode's field cap (imageNode.ts MAX_IMAGE_DIM_FIELD, nodeCost.ts IMAGE_COST_MAX_DIM). */
export const TEXTURE_DIM_FIELD_MAX = 8192;
/** Side a texture is sized at when it exists but its stored size is junk --
 *  the size imageNodeCost's flat fallback prices (IMAGE_COST_REF_SIDE). */
export const UNTRUSTED_TEXTURE_SIDE = 2048;
/** three r184 PMREMGenerator `_allocateTarget`: the cubeUV target is never
 *  narrower than 16 * 7 texels per face column. */
const PMREM_MIN_CUBE_WIDTH = 16 * 7;

export interface TextureMemoryInput {
  /** Sharing identity: equal keys are ONE GPU texture. */
  key: string;
  /** Stored dimensions, adversarial. */
  width: unknown;
  height: unknown;
  /** Summed over the exact mip chain when true, a single level when false. */
  mipmapped: boolean;
  /** Also prefiltered into PMREM's two cubeUV targets. */
  environment: boolean;
}

export interface TextureMemory {
  /** textureBytes + environmentBytes. */
  bytes: number;
  /** Unique textures. */
  count: number;
  textureBytes: number;
  environmentBytes: number;
  /** Unique textures with no mip chain (data maps). */
  dataMaps: number;
  /** Unique textures sized at UNTRUSTED_TEXTURE_SIDE because their stored size is junk. */
  untrustedSizes: number;
}

export const NO_TEXTURE_MEMORY: TextureMemory = Object.freeze({
  bytes: 0,
  count: 0,
  textureBytes: 0,
  environmentBytes: 0,
  dataMaps: 0,
  untrustedSizes: 0,
});

/** Texels in the full mip chain of a w x h texture, down to 1x1, each level
 *  floor-halved per axis (clamped at 1) -- what WebGPU/WebGL allocate. Inputs
 *  are expected to be trusted positive integers; anything else counts 0. */
export function mipChainTexels(w: number, h: number): number {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return 0;
  let total = 0;
  for (;;) {
    total += w * h;
    if (w === 1 && h === 1) return total;
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
  }
}

/** Bytes of the PMREM prefilter for an equirect `equirectWidth` texels wide:
 *  the cubeUV target AND the persistent ping-pong target, same size. */
export function pmremBytes(equirectWidth: number): number {
  if (!Number.isFinite(equirectWidth) || equirectWidth <= 0) return 0;
  const c = 2 ** Math.floor(Math.log2(equirectWidth / 4));
  const texels = 3 * Math.max(c, PMREM_MIN_CUBE_WIDTH) * (4 * c);
  return 2 * texels * PMREM_BYTES_PER_TEXEL;
}

/** imageNodeCost's gate: a stored dimension is trusted only as a real number. */
function strictDim(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= TEXTURE_DIM_FIELD_MAX;
}

/** decodeImageNode's gate, minus the base64 decode: `Number()`-coerced. */
function coercedDim(v: unknown): boolean {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= TEXTURE_DIM_FIELD_MAX;
}

interface TextureGroup {
  textureBytes: number;
  untrusted: boolean;
  widest: number;
  mipmapped: boolean;
  environment: boolean;
}

/**
 * The core: bytes and count for a list of planned textures. Equal keys are one
 * texture, sized at the LARGEST of its members (they share one payload, so a
 * disagreement is a tampered size; the larger errs high) and prefiltered if
 * ANY member feeds Environment. Never NaN, never throws. The GLB import dialog
 * (N12) reuses it with one input per planned (image, sampler, settings).
 */
export function textureMemory(inputs: readonly TextureMemoryInput[]): TextureMemory {
  const groups = new Map<string, TextureGroup>();
  for (const input of inputs) {
    const trusted = strictDim(input.width) && strictDim(input.height);
    const w = trusted ? (input.width as number) : UNTRUSTED_TEXTURE_SIDE;
    const h = trusted ? (input.height as number) : UNTRUSTED_TEXTURE_SIDE;
    const bytes = (input.mipmapped ? mipChainTexels(w, h) : w * h) * TEXTURE_BYTES_PER_TEXEL;
    const g = groups.get(input.key);
    if (!g) {
      groups.set(input.key, {
        textureBytes: bytes,
        untrusted: !trusted,
        widest: w,
        mipmapped: input.mipmapped,
        environment: input.environment,
      });
      continue;
    }
    if (bytes > g.textureBytes) {
      g.textureBytes = bytes;
      g.untrusted = !trusted;
    }
    g.widest = Math.max(g.widest, w);
    g.mipmapped ||= input.mipmapped;
    g.environment ||= input.environment;
  }
  if (groups.size === 0) return NO_TEXTURE_MEMORY;
  let textureBytes = 0;
  let environmentBytes = 0;
  let dataMaps = 0;
  let untrustedSizes = 0;
  for (const g of groups.values()) {
    textureBytes += g.textureBytes;
    if (g.environment) environmentBytes += pmremBytes(g.widest);
    if (!g.mipmapped) dataMaps++;
    if (g.untrusted) untrustedSizes++;
  }
  return {
    bytes: textureBytes + environmentBytes,
    count: groups.size,
    textureBytes,
    environmentBytes,
    dataMaps,
    untrustedSizes,
  };
}

/**
 * The graph adapter: the ACTIVE sink's reachable Image nodes, de-duplicated by
 * the emission sharing key. Pass UNWRAPPED edges (`unwrapCollapsedGroupEdges`).
 */
export function graphTextureMemory(nodes: readonly AppNode[], unwrappedEdges: readonly AppEdge[]): TextureMemory {
  const sink = activeSink(nodes, unwrappedEdges);
  if (!sink) return NO_TEXTURE_MEMORY;

  // Reverse BFS from the sink -- the same walk as nodeCost's `sumReachable`,
  // restated here (ten lines) because nodeCost may not be imported (header).
  const incoming = new Map<string, string[]>();
  for (const e of unwrappedEdges) {
    const list = incoming.get(e.target);
    if (list) list.push(e.source);
    else incoming.set(e.target, [e.source]);
  }
  const visited = new Set<string>();
  const queue = [sink.id];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    if (visited.has(id)) continue;
    visited.add(id);
    for (const src of incoming.get(id) ?? []) if (!visited.has(src)) queue.push(src);
  }

  // Environment is a plain Output's channel, on any material (`env`, `m<n>:env`)
  // that graphToCode EMITS: material 0 always, an added one only while it names
  // a mesh (an emptied one is kept but skipped), and never an `m<n>:` handle
  // past the node's materials -- no envNode, so no PMREM. Only from the Color
  // socket: an Alpha/R/G/B edge is a scalar ambient (graphToCode's env gate).
  const envSources = new Set<string>();
  if (sink.data.registryType === 'output') {
    const mats = outputMaterials(sink);
    for (const e of unwrappedEdges) {
      if (e.target !== sink.id) continue;
      const { index, channel } = parseChannelHandle(e.targetHandle ?? '');
      if (channel === 'env' && !isImageChannelHandle(e.sourceHandle) && index < mats.length && (index === 0 || materialTargetNames(mats[index]).length > 0)) {
        envSources.add(e.source);
      }
    }
  }

  // Payload identity by ordinal: the payload STRING is the Map key, never part
  // of a concatenated key (a multi-megabyte cons-string would flatten per call).
  const payloadOrdinal = new Map<string, number>();
  const inputs: TextureMemoryInput[] = [];
  for (const node of nodes) {
    if (!visited.has(node.id) || node.data?.registryType !== 'imageNode') continue;
    const v = getNodeValues(node); // plain property access below, never `in`
    const payload = validImageDataUrl(v.imageB64);
    if (payload === null || !coercedDim(v.width) || !coercedDim(v.height)) continue;
    let ordinal = payloadOrdinal.get(payload);
    if (ordinal === undefined) {
      ordinal = payloadOrdinal.size;
      payloadOrdinal.set(payload, ordinal);
    }
    const spec = readImageTextureSpec(v);
    inputs.push({
      key: `p${ordinal}:${imageTextureSpecKey(spec)}`,
      width: v.width,
      height: v.height,
      mipmapped: spec.colorSpace !== 'data',
      environment: envSources.has(node.id),
    });
  }
  return textureMemory(inputs);
}

export const TEXTURE_MEMORY_ONE_KEY = 'Texture memory: ~{mb} MB (1 texture)';
export const TEXTURE_MEMORY_MANY_KEY = 'Texture memory: ~{mb} MB ({n} textures)';
export const TEXTURE_MEMORY_HINT_KEY =
  "Estimated GPU memory for the textures this shader samples: width × height × 4 bytes for each distinct texture, a third more for a colour image's mipmaps (data maps have none), and for an image wired into Environment the prefiltered copy the lighting builds from it. Images with the same data and the same texture settings count once. Not counted: the preview model's own textures and the data nodes' small lookup textures. No headset memory limit has been measured yet, so this is a figure, not a warning.";

/** The Shader Settings line. `t()` has no plural rules, so the count picks
 *  one of two keys (EN "(1 textures)" otherwise); MB means MiB, rounded UP so
 *  a non-empty set never prints 0, with a decimal comma in Latvian. */
export function textureMemoryLine(bytes: number, count: number, lang: Language): string {
  const key = count === 1 ? TEXTURE_MEMORY_ONE_KEY : TEXTURE_MEMORY_MANY_KEY;
  return fillTemplate(t(key, lang), { mb: formatMiB(bytes, lang, 'up'), n: count });
}
