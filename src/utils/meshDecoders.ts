/**
 * The mesh DECODER files — three r184's glTF Draco build, meshopt 1.1 and the
 * Basis Universal KTX2 transcoder — as the trusted side of the app sees them.
 *
 * They are vendored beside the loader (`a-frame-shaderloader/js/decoders/`,
 * synced to `public/js/decoders/`), and loader 0.8's `FastShaders.decoders`
 * section installs them on every GLTFLoader. A sandboxed preview document cannot
 * fetch them itself (its URL allowlist admits only blob:/data:, and its opaque
 * origin could not read the app's files anyway), so the parent fetches the bytes
 * here and pushes them inside the model message it already sends; the sandbox
 * mints blob: URLs from them.
 *
 * Pure apart from the injected fetch. `DECODER_FILES` is the TS twin of the
 * loader's `FastShaders.decoders.FILES` (meshDecoders.test.ts pins the two
 * equal): one vocabulary, because the sandbox refuses any other key.
 */

export const DECODER_FILES = {
  dracoWrapper: 'draco_wasm_wrapper.js',
  dracoWasm: 'draco_decoder.wasm',
  meshopt: 'meshopt_decoder.module.js',
  basisJs: 'basis_transcoder.js',
  basisWasm: 'basis_transcoder.wasm',
} as const;

export type DecoderFile = (typeof DECODER_FILES)[keyof typeof DECODER_FILES];

/** Where the app serves them, relative to its base. */
export const DECODER_DIR = 'js/decoders/';

/** No decoder file comes near this (the largest is the 515 KB basis wasm). */
export const MAX_DECODER_FILE_BYTES = 1 << 20;

/** What one model needs decoded. */
export interface DecoderNeeds {
  draco: boolean;
  meshopt: boolean;
  ktx2: boolean;
}

/** What a surface can decode. */
export interface DecoderSupport {
  draco: boolean;
  meshopt: boolean;
  ktx2: boolean;
}

/** Draco needs the wrapper and the wasm; meshopt its module; KTX2 the basis pair. */
export function decoderFilesFor(needs: DecoderNeeds): DecoderFile[] {
  const files: DecoderFile[] = [];
  if (needs.draco) files.push(DECODER_FILES.dracoWrapper, DECODER_FILES.dracoWasm);
  if (needs.meshopt) files.push(DECODER_FILES.meshopt);
  if (needs.ktx2) files.push(DECODER_FILES.basisJs, DECODER_FILES.basisWasm);
  return files;
}

/** The `decoders` field of a model message: JS files as text, the wasm as bytes. */
export type DecoderPayload = Partial<Record<DecoderFile, string | ArrayBuffer>>;

/**
 * Why a file failed. `empty` and `too-large` are the app's OWN verdicts, so the
 * notice translates them (previewMeshMessage.ts); `http` and `network` carry the
 * status line or the engine's own text, which stays as it came.
 */
export type DecoderLoadKind = 'network' | 'http' | 'empty' | 'too-large';

export class DecoderLoadError extends Error {
  override name = 'DecoderLoadError';
  readonly file: DecoderFile;
  readonly ext: 'Draco' | 'meshopt' | 'KTX2';
  /** English, for the console; the notice reads `kind` first. */
  readonly reason: string;
  readonly kind: DecoderLoadKind;

  constructor(file: DecoderFile, reason: string, kind: DecoderLoadKind = 'network') {
    super(`Could not load ${file}: ${reason}`);
    this.file = file;
    this.ext =
      file === DECODER_FILES.meshopt
        ? 'meshopt'
        : file === DECODER_FILES.basisJs || file === DECODER_FILES.basisWasm
          ? 'KTX2'
          : 'Draco';
    this.reason = reason;
    this.kind = kind;
  }
}

type FetchLike = (url: string) => Promise<Response>;

const cache = new Map<DecoderFile, Promise<string | ArrayBuffer>>();

async function fetchDecoderFile(
  file: DecoderFile,
  urlOf: (f: DecoderFile) => string,
  fetchImpl: FetchLike,
): Promise<string | ArrayBuffer> {
  let res: Response;
  try {
    res = await fetchImpl(urlOf(file));
  } catch (e) {
    throw new DecoderLoadError(file, e instanceof Error && e.message ? e.message : String(e));
  }
  if (!res.ok) throw new DecoderLoadError(file, `HTTP ${res.status}`, 'http');
  let bytes: ArrayBuffer;
  try {
    bytes = await res.arrayBuffer();
  } catch (e) {
    throw new DecoderLoadError(file, e instanceof Error && e.message ? e.message : String(e));
  }
  // Measured in BYTES before anything is decoded, so the cap is exact.
  if (bytes.byteLength === 0) throw new DecoderLoadError(file, 'the file is empty', 'empty');
  if (bytes.byteLength > MAX_DECODER_FILE_BYTES) {
    throw new DecoderLoadError(file, `the file is over ${MAX_DECODER_FILE_BYTES} bytes`, 'too-large');
  }
  return file.endsWith('.wasm') ? bytes : new TextDecoder().decode(bytes);
}

/**
 * The decoder files one model needs, fetched once per file for the session.
 * A file that failed to load is forgotten, so a later model can retry it.
 *
 * Post the result WITHOUT a transfer list: the cache keeps these buffers, and
 * structured clone copies them into each message.
 */
export function loadDecoderPayload(
  needs: DecoderNeeds,
  urlOf: (f: DecoderFile) => string,
  fetchImpl: FetchLike = (url) => fetch(url),
): Promise<DecoderPayload> {
  const files = decoderFilesFor(needs);
  return Promise.all(
    files.map((file) => {
      let p = cache.get(file);
      if (!p) {
        const pending = fetchDecoderFile(file, urlOf, fetchImpl);
        cache.set(file, pending);
        pending.catch(() => {
          if (cache.get(file) === pending) cache.delete(file);
        });
        p = pending;
      }
      return p;
    }),
  ).then((values) => {
    const payload: DecoderPayload = {};
    files.forEach((file, i) => {
      payload[file] = values[i];
    });
    return payload;
  });
}

/** Forget every fetched file (tests only). */
export function __resetDecoderCacheForTests(): void {
  cache.clear();
}
