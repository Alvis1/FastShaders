/**
 * The trusted side's decoder fetch (utils/meshDecoders.ts): which files a model
 * needs, fetched once per session, a failed file forgotten, every bound
 * enforced in bytes before anything is decoded — and ONE file vocabulary
 * shared with the loader, since the sandbox accepts no other key.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BUNDLED_DECODERS } from './previewMesh';
import { decoderLoadMessage, MESH_DECODER_LOAD_KEY } from './previewMeshMessage';
import { safeJsonReviver } from './safeJson';
import {
  DECODER_DIR,
  DECODER_FILES,
  DecoderLoadError,
  MAX_DECODER_FILE_BYTES,
  __resetDecoderCacheForTests,
  decoderFilesFor,
  loadDecoderPayload,
  type DecoderFile,
} from './meshDecoders';
import { REPO, evalLoader, loaderAvailable } from '../shaderloaderHarness';

const url = (f: DecoderFile) => `https://app.example/${DECODER_DIR}${f}`;

/** A fake fetch serving `body(file)` per file name, counting calls. */
function fakeFetch(body: (file: string) => { status?: number; bytes?: Uint8Array } | Error) {
  return vi.fn(async (u: string) => {
    const file = u.slice(u.lastIndexOf('/') + 1);
    const r = body(file);
    if (r instanceof Error) throw r;
    return new Response(new Uint8Array(r.bytes ?? [1]), { status: r.status ?? 200 });
  });
}

const ascii = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  __resetDecoderCacheForTests();
});

describe('meshDecoders: which files', () => {
  it('Draco needs the wrapper and the wasm, meshopt its module, KTX2 the basis pair', () => {
    expect(decoderFilesFor({ draco: false, meshopt: false, ktx2: false })).toEqual([]);
    expect(decoderFilesFor({ draco: true, meshopt: false, ktx2: false })).toEqual([
      'draco_wasm_wrapper.js',
      'draco_decoder.wasm',
    ]);
    expect(decoderFilesFor({ draco: false, meshopt: true, ktx2: false })).toEqual(['meshopt_decoder.module.js']);
    expect(decoderFilesFor({ draco: false, meshopt: false, ktx2: true })).toEqual([
      'basis_transcoder.js',
      'basis_transcoder.wasm',
    ]);
    expect(decoderFilesFor({ draco: true, meshopt: true, ktx2: true })).toHaveLength(5);
  });

  it('the payload type follows the EXTENSION, not the name: every .wasm is bytes', async () => {
    const fetchImpl = fakeFetch((f) => ({ bytes: f.endsWith('.wasm') ? new Uint8Array([0, 97, 115, 109]) : ascii(`// ${f}`) }));
    const all = await loadDecoderPayload({ draco: true, meshopt: true, ktx2: true }, url, fetchImpl);
    for (const f of Object.values(DECODER_FILES)) {
      expect(typeof all[f], f).toBe(f.endsWith('.wasm') ? 'object' : 'string');
      if (f.endsWith('.wasm')) expect(all[f], f).toBeInstanceOf(ArrayBuffer);
    }
    // Both wasm files — Draco's and Basis's — take the bytes branch.
    expect(Object.values(DECODER_FILES).filter((f) => f.endsWith('.wasm'))).toHaveLength(2);
  });

  it('every file is served from public/js/decoders', () => {
    for (const f of Object.values(DECODER_FILES)) {
      expect(existsSync(path.join(REPO, 'public', DECODER_DIR, f)), f).toBe(true);
    }
  });

  it.skipIf(!loaderAvailable('0.8'))('is the SAME vocabulary as loader 0.8\'s FastShaders.decoders.FILES', () => {
    const FS = evalLoader('0.8', { aframe: false }).FastShaders;
    expect({ ...FS?.decoders.FILES }).toEqual({ ...DECODER_FILES });
  });

  it('is the SAME vocabulary as podest\'s DECODER_FILES literal', () => {
    const page = readFileSync(path.join(REPO, 'public/podest.html'), 'utf8');
    const m = /var DECODER_FILES = (\[[^\]]*\]);/.exec(page);
    expect(m, 'podest.html has no DECODER_FILES literal').toBeTruthy();
    expect(JSON.parse(m![1], safeJsonReviver)).toEqual(Object.values(DECODER_FILES));
  });

  it('BUNDLED_DECODERS claims only what public/js/decoders really ships', () => {
    expect(BUNDLED_DECODERS).toEqual({ draco: true, meshopt: true, ktx2: true });
    const claimed = decoderFilesFor(BUNDLED_DECODERS);
    expect(claimed).toHaveLength(5);
    for (const f of claimed) {
      expect(existsSync(path.join(REPO, 'public', DECODER_DIR, f)), f).toBe(true);
    }
  });
});

describe('meshDecoders: the preview pushes the bytes (ShaderPreview, source)', () => {
  const src = readFileSync(path.join(REPO, 'src/components/Preview/ShaderPreview.tsx'), 'utf8');
  const start = src.indexOf('const handleIframeLoad = useCallback(');
  // `bootAssetKeys` joined the deps with the image-asset feed (GLB Phase 6 S3):
  // the load handler re-seeds the feed's sent set from the boot list.
  const end = src.indexOf(
    '}, [previewGeometry, previewMesh, previewModule, bakedModule, bootAssetKeys, postShaderSwap, language, showDropNotice]);',
    start,
  );
  const body = src.slice(start, end);

  it('slices out handleIframeLoad, whose deps include the language the error is written in', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it('fetches the decoders only when the mesh needs them, and posts them with the model', () => {
    expect(body).toContain('const needs = mesh.decoders;');
    expect(body).toContain('if (needs) {');
    expect(body).toContain('loadDecoderPayload(needs, decoderAssetUrl).then(post,');
    expect(body).toContain("const extra = decoders ? { decoders } : {};");
    // The no-decoder path posts synchronously, exactly as before decoders.
    expect(body).toMatch(/\} else \{\s*post\(\);\s*\}/);
  });

  it('re-reads the live window AND the store\'s mesh before every post, since the fetch outlives both', () => {
    expect(body).toContain('useAppStore.getState().previewMesh?.id === mesh.id');
    expect(body.split('liveWindow()').length - 1).toBeGreaterThanOrEqual(2);
    expect(body).not.toContain('win.postMessage');
  });

  it('a failed MESH decoder ends in the overlay\'s error, in the reader\'s language', () => {
    expect(body).toContain("type: 'fs:obj-model-error', geometry: key, message: decoderLoadMessage(err, needs, language)");
  });

  it('a failed KTX2 transcoder still POSTS the model, as an info line', () => {
    // KTX2 decodes textures, not geometry: without it the parse still finishes
    // and the loader's plugin falls back to each texture's own PNG/JPEG. So the
    // model must go (it rendered before the transcoder was wired in, and
    // podest's parent posts it too); only Draco/meshopt may suppress it.
    const at = body.indexOf('if (!needs.draco && !needs.meshopt) {');
    expect(at, 'the KTX2-only branch is gone').toBeGreaterThan(-1);
    // Up to the error post that follows it, so the whole branch is in view.
    const branch = body.slice(at, body.indexOf("type: 'fs:obj-model-error'", at));
    expect(branch).toContain("showDropNotice(decoderLoadMessage(err, needs, language), 'info')");
    expect(branch).toContain('post();');
    // Inside the rejection handler, above the error post — not after it.
    expect(at).toBeGreaterThan(body.indexOf('loadDecoderPayload(needs, decoderAssetUrl).then(post,'));
    expect(at).toBeLessThan(body.indexOf("type: 'fs:obj-model-error'"));
  });
});

describe('meshDecoders: the decoder-load notice', () => {
  it('names the file\'s decoder and the reason, in English and Latvian', () => {
    const err = new DecoderLoadError('draco_decoder.wasm', 'HTTP 404');
    expect(decoderLoadMessage(err, { draco: true, meshopt: false, ktx2: false }, 'en')).toBe(
      'Could not load the Draco decoder (HTTP 404). Reload to retry.',
    );
    expect(decoderLoadMessage(err, { draco: true, meshopt: false, ktx2: false }, 'lv')).toBe(
      'Neizdevās ielādēt Draco dekodētāju (HTTP 404). Pārlādējiet lapu, lai mēģinātu vēlreiz.',
    );
    expect(MESH_DECODER_LOAD_KEY).toBe('Could not load the {ext} decoder ({reason}). Reload to retry.');
  });

  it("translates the reasons the app writes itself, and keeps the engine's own text as it came", async () => {
    const needs = { draco: false, meshopt: true, ktx2: false };
    const fail = (body: Parameters<typeof fakeFetch>[0]) => {
      __resetDecoderCacheForTests();
      return loadDecoderPayload(needs, url, fakeFetch(body)).catch((e) => e);
    };
    const empty = await fail(() => ({ bytes: new Uint8Array(0) }));
    expect(empty.kind).toBe('empty');
    expect(decoderLoadMessage(empty, needs, 'en')).toBe(
      'Could not load the meshopt decoder (the file is empty). Reload to retry.',
    );
    expect(decoderLoadMessage(empty, needs, 'lv')).toBe(
      'Neizdevās ielādēt meshopt dekodētāju (fails ir tukšs). Pārlādējiet lapu, lai mēģinātu vēlreiz.',
    );
    const big = await fail(() => ({ bytes: new Uint8Array(MAX_DECODER_FILE_BYTES + 1) }));
    expect(big.kind).toBe('too-large');
    expect(decoderLoadMessage(big, needs, 'en')).toBe(
      'Could not load the meshopt decoder (the file is over 1 MB). Reload to retry.',
    );
    expect(decoderLoadMessage(big, needs, 'lv')).toBe(
      'Neizdevās ielādēt meshopt dekodētāju (fails pārsniedz 1 MB). Pārlādējiet lapu, lai mēģinātu vēlreiz.',
    );
    const http = await fail(() => ({ status: 404 }));
    expect(http.kind).toBe('http');
    expect(decoderLoadMessage(http, needs, 'lv')).toContain('(HTTP 404)');
    const net = await fail(() => new TypeError('Failed to fetch'));
    expect(net.kind).toBe('network');
    expect(decoderLoadMessage(net, needs, 'lv')).toContain('(Failed to fetch)');
  });

  it('names the KTX2 transcoder for either basis file', () => {
    for (const f of ['basis_transcoder.js', 'basis_transcoder.wasm'] as const) {
      const err = new DecoderLoadError(f, 'HTTP 404');
      expect(err.ext).toBe('KTX2');
      expect(decoderLoadMessage(err, { draco: false, meshopt: false, ktx2: true }, 'en')).toBe(
        'Could not load the KTX2 decoder (HTTP 404). Reload to retry.',
      );
    }
    // …and a non-DecoderLoadError falls back to what the model needed.
    expect(decoderLoadMessage('offline', { draco: false, meshopt: false, ktx2: true }, 'en')).toBe(
      'Could not load the KTX2 decoder (offline). Reload to retry.',
    );
  });

  it('falls back to the first decoder the model needed, and keeps a reason spelling a placeholder literal', () => {
    expect(decoderLoadMessage(new Error('{ext} went away'), { draco: false, meshopt: true, ktx2: false }, 'en')).toBe(
      'Could not load the meshopt decoder ({ext} went away). Reload to retry.',
    );
    expect(decoderLoadMessage('offline', { draco: true, meshopt: true, ktx2: false }, 'en')).toBe(
      'Could not load the Draco decoder (offline). Reload to retry.',
    );
  });
});

describe('meshDecoders: loadDecoderPayload', () => {
  it('fetches only the files the model needs: text for .js, bytes for .wasm', async () => {
    const fetchImpl = fakeFetch((f) => ({ bytes: f.endsWith('.wasm') ? new Uint8Array([0, 97, 115, 109]) : ascii(`// ${f}`) }));
    const draco = await loadDecoderPayload({ draco: true, meshopt: false, ktx2: false }, url, fetchImpl);
    expect(Object.keys(draco).sort()).toEqual(['draco_decoder.wasm', 'draco_wasm_wrapper.js']);
    expect(draco['draco_wasm_wrapper.js']).toBe('// draco_wasm_wrapper.js');
    expect(draco['draco_decoder.wasm']).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(draco['draco_decoder.wasm'] as ArrayBuffer)).toEqual(new Uint8Array([0, 97, 115, 109]));
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      url('draco_wasm_wrapper.js'),
      url('draco_decoder.wasm'),
    ]);

    const none = await loadDecoderPayload({ draco: false, meshopt: false, ktx2: false }, url, fetchImpl);
    expect(none).toEqual({});
  });

  it('fetches each file ONCE for the session', async () => {
    const fetchImpl = fakeFetch(() => ({ bytes: ascii('x') }));
    await loadDecoderPayload({ draco: true, meshopt: true, ktx2: false }, url, fetchImpl);
    await loadDecoderPayload({ draco: true, meshopt: false, ktx2: false }, url, fetchImpl);
    await Promise.all([
      loadDecoderPayload({ draco: false, meshopt: true, ktx2: false }, url, fetchImpl),
      loadDecoderPayload({ draco: false, meshopt: true, ktx2: false }, url, fetchImpl),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('forgets a failed file, so the next model retries it (and only it)', async () => {
    let wasmStatus = 500;
    const fetchImpl = fakeFetch((f) => (f.endsWith('.wasm') ? { status: wasmStatus } : { bytes: ascii('x') }));
    const err = await loadDecoderPayload({ draco: true, meshopt: false, ktx2: false }, url, fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(DecoderLoadError);
    expect(err.file).toBe('draco_decoder.wasm');
    expect(err.ext).toBe('Draco');
    expect(err.reason).toBe('HTTP 500');

    wasmStatus = 200;
    const ok = await loadDecoderPayload({ draco: true, meshopt: false, ktx2: false }, url, fetchImpl);
    expect(Object.keys(ok)).toHaveLength(2);
    // The wrapper stayed cached; the wasm was fetched again.
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      url('draco_wasm_wrapper.js'),
      url('draco_decoder.wasm'),
      url('draco_decoder.wasm'),
    ]);
  });

  it('refuses an empty file, a file over 1 MiB, and a network failure — naming the file and the extension', async () => {
    const cases: Array<[Parameters<typeof fakeFetch>[0], RegExp]> = [
      [() => ({ bytes: new Uint8Array(0) }), /empty/],
      [() => ({ bytes: new Uint8Array(MAX_DECODER_FILE_BYTES + 1) }), /over 1048576 bytes/],
      [() => new TypeError('Failed to fetch'), /Failed to fetch/],
      [() => ({ status: 404 }), /HTTP 404/],
    ];
    for (const [body, reason] of cases) {
      __resetDecoderCacheForTests();
      const err = await loadDecoderPayload({ draco: false, meshopt: true, ktx2: false }, url, fakeFetch(body)).catch((e) => e);
      expect(err).toBeInstanceOf(DecoderLoadError);
      expect(err.name).toBe('DecoderLoadError');
      expect(err.file).toBe('meshopt_decoder.module.js');
      expect(err.ext).toBe('meshopt');
      expect(err.reason).toMatch(reason);
    }
    // Exactly the cap is fine.
    __resetDecoderCacheForTests();
    const full = await loadDecoderPayload(
      { draco: false, meshopt: true, ktx2: false },
      url,
      fakeFetch(() => ({ bytes: new Uint8Array(MAX_DECODER_FILE_BYTES).fill(32) })),
    );
    expect((full['meshopt_decoder.module.js'] as string).length).toBe(MAX_DECODER_FILE_BYTES);
  });

  it('a urlOf that throws is a load error, not an escape', async () => {
    const err = await loadDecoderPayload(
      { draco: true, meshopt: false, ktx2: false },
      () => {
        throw new Error('no base');
      },
      fakeFetch(() => ({ bytes: ascii('x') })),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(DecoderLoadError);
    expect(err.reason).toBe('no base');
  });
});
