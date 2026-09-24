import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore, resolveDeviceTextureDim } from '@/store/useAppStore';
import { readGltfModel, type GltfModelReport } from '@/utils/gltfReader';
import { modelTextureSources, modelTextureKey, type ModelTextureSource } from '@/utils/modelTextureSources';
import { encodeGltfImages } from '@/utils/gltfTextureEncode';
import { MAX_LISTED_TEXTURE_SOURCES } from '@/utils/textureSources';

/**
 * The texture picker's MODEL half: every picture still inside the loaded 3D
 * model, plus a thumbnail for each (`utils/modelTextureSources.ts` decides
 * WHAT is offered; this runs the DOM half that module deliberately has none
 * of).
 *
 * Three costs, each bounded on purpose:
 *
 *  1. THE PARSE. `readGltfModel` over `previewMesh.bytes` — up to 64 MiB
 *     (MESH_MAX_BYTES) — runs at most ONCE per loaded model, and only while
 *     the grid is open. The subscription is `modelTextureKey`, a short string,
 *     so a drag frame (which replaces the nodes array and notifies every
 *     selector) bails on `Object.is` instead of re-reading a model. Closed,
 *     the key is '' and this hook costs nothing at all.
 *  2. THE THUMBNAILS. Sequential, one encoder at a time, in list order —
 *     the import's own rule, because N concurrent encoders compound into one
 *     frozen tab. Each is asked for {@link THUMB_MAX_DIM} px, so the decode
 *     dominates and the result is a few hundred bytes. Cells render as they
 *     arrive.
 *  3. THE ABORT. Closing the grid, switching model, or unmounting fires the
 *     signal; `encodeGltfImages` checks it between images and resolves early.
 *     Nothing is kept: the report (whose image `bytes` are VIEWS into the
 *     model buffer) is dropped with the effect, and only the encoded `data:`
 *     URLs — which are what an `<img>` may safely be given — outlive it.
 *
 * The thumbnails go through `encodeGltfImages`, the import's own encoder,
 * rather than a blob: URL over the model's bytes. That is the whole security
 * story of this feature: raw bytes out of an attacker-supplied model never
 * reach the DOM, and what does is a re-encoded `data:` URL of the same shape
 * every other picture in the app has.
 */

/** Long side a thumbnail is encoded at. The grid cell is far smaller; this is
 *  chosen so a cell still looks right on a 2× display. */
export const THUMB_MAX_DIM = 96;

export interface ModelTextures {
  /** Every offerable picture of the loaded model ([] when there is none). */
  readonly sources: readonly ModelTextureSource[];
  /** glTF image index → an encoded thumbnail, as it arrives. */
  readonly thumbs: ReadonlyMap<number, string>;
  /** A thumbnail pass is still running. */
  readonly loading: boolean;
  /** The loaded model's display name — the encoder derives file names from it
   *  and the pick path needs the same one. */
  readonly modelName: string;
}

const NO_SOURCES: readonly ModelTextureSource[] = [];
const NO_THUMBS: ReadonlyMap<number, string> = new Map();

/**
 * Read the loaded model once (`open` gates everything) and return what it
 * offers. `report` is returned too — the pick path re-reads the LIVE bytes
 * rather than reusing it, so this copy never escapes the picker.
 */
export function useModelTextures(open: boolean): ModelTextures {
  // The cheap key IS the subscription: `previewMesh` itself is replaced on
  // every mesh change and nothing else, but subscribing to the object would
  // re-run the parse effect on an unrelated store notify that replaced it.
  const key = useAppStore((s) => (open ? modelTextureKey(s.previewMesh) : ''));
  const [thumbs, setThumbs] = useState<ReadonlyMap<number, string>>(NO_THUMBS);
  const [loading, setLoading] = useState(false);
  /** The key the current `thumbs` belong to — a stale map must never be shown
   *  against a different model (an index means nothing across two files). */
  const thumbKey = useRef('');

  /** The model the parse belongs to: the last key seen while OPEN. Closing the
   *  grid drops `key` to '' but not this, so a reopen of the same model reuses
   *  the parse instead of re-reading up to 64 MiB on the main thread. */
  const parseKeyRef = useRef('');
  if (key) parseKeyRef.current = key;
  const parseKey = parseKeyRef.current;

  /** The parse. Re-run only when the model moves; `getState()` for the bytes,
   *  the two-step selector's other half. */
  const parsed = useMemo<{ model: GltfModelReport; name: string } | null>(() => {
    if (!parseKey) return null;
    const mesh = useAppStore.getState().previewMesh;
    if (!mesh || (mesh.kind !== 'glb' && mesh.kind !== 'gltf')) return null;
    const res = readGltfModel(mesh.bytes, mesh.kind);
    // The reader never throws and a refusal is not an error here: a model this
    // strict reader will not open simply offers no textures.
    return res.ok ? { model: res.model, name: mesh.name } : null;
  }, [parseKey]);

  const sources = useMemo(
    () => (parsed ? modelTextureSources(parsed.model, parsed.name) : NO_SOURCES),
    [parsed],
  );

  useEffect(() => {
    // CLOSED (key '') is not "no model": the hook stays mounted across the
    // toggle, so clearing here would throw away the thumbnails on every
    // collapse and re-parse the whole model — up to 64 MiB — plus re-encode
    // every picture on the next open. The cache guard below is only reachable
    // because of this branch.
    if (!key) {
      setLoading(false);
      return;
    }
    if (!parsed || sources.length === 0) {
      setThumbs(NO_THUMBS);
      setLoading(false);
      thumbKey.current = '';
      return;
    }
    // A model the thumbnails already belong to: keep them (reopening the grid
    // must not re-encode the same pictures).
    if (thumbKey.current === key) return;
    const ctrl = new AbortController();
    let live = true;
    setThumbs(NO_THUMBS);
    setLoading(true);
    const store = useAppStore.getState();
    const deviceMaxDim = resolveDeviceTextureDim(store.selectedHeadsetId, store.costProfiles);
    void (async () => {
      const acc = new Map<number, string>();
      // Only the pictures a cell can actually show. The grid draws at most
      // MAX_LISTED_TEXTURE_SOURCES of them and the reader admits up to 4096
      // images, so encoding the whole list would decode thousands of pictures
      // nobody asked to see — one at a time, for minutes.
      for (const src of sources.slice(0, MAX_LISTED_TEXTURE_SOURCES)) {
        if (!live || ctrl.signal.aborted) return;
        const res = await encodeGltfImages(
          parsed.model,
          [{ image: src.image, slot: src.slot }],
          {
            modelName: parsed.name,
            maxDim: THUMB_MAX_DIM,
            deviceMaxDim,
            // A thumbnail is not a payload: it is never stored, never counted
            // against the project budget, and must not be refused for being a
            // big source — the picture the user is deciding about is exactly
            // the one a limit would hide.
            ignoreLimits: true,
            budgetChars: Infinity,
            // No origin stash either: Revert is about a payload this node
            // holds, and a thumbnail is not one. Stashing here would churn the
            // 32-record LRU for every grid the user opens.
            stash: () => null,
            signal: ctrl.signal,
          },
        );
        const enc = res.encoded.get(src.image);
        if (!live || ctrl.signal.aborted) return;
        // An image the encoder refuses is simply left without a thumbnail —
        // the cell stays, named, and picking it reports the same refusal.
        if (enc) {
          acc.set(src.image, enc.payload.dataUrl);
          setThumbs(new Map(acc));
        }
      }
      if (live) {
        thumbKey.current = key;
        setLoading(false);
      }
    })();
    return () => {
      live = false;
      ctrl.abort();
      setLoading(false);
    };
  }, [parsed, sources, key]);

  // `key` is '' while the grid is closed, which makes `parsed` null — but the
  // thumbnails it produced are kept, so reopening is instant.
  return { sources, thumbs, loading, modelName: parsed?.name ?? '' };
}
