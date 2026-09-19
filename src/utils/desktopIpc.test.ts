/**
 * The frontend half of the desktop IPC contract (utils/desktopIpc.ts) and the
 * Work-folder control's use of it. The Rust half is pinned against this one in
 * desktopIpcContract.test.ts; WorkFolder.tsx cannot mount under the `node`
 * environment, so its wiring is source-pinned here.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import lv from '@/i18n/lv.json';
import {
  ARCHIVE_SLACK_BYTES,
  DESKTOP_MAX_READ_BYTES,
  FILE_NAME_HEADER,
  WORK_FOLDER_WRITE_BYTES,
  describeDesktopError,
  desktopBytes,
  encodeHeaderName,
  parseDesktopError,
} from './desktopIpc';
import { invokeDesktop } from './tauriBridge';
import {
  DESKTOP_MAX_TOTAL_UNCOMPRESSED,
  MAX_ARCHIVE_BYTES,
  MAX_TOTAL_UNCOMPRESSED,
} from './zipReader';

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('parseDesktopError', () => {
  it('reads a value and a limit', () => {
    expect(parseDesktopError('E_TOO_LARGE 300 276824064')).toEqual({
      code: 'TOO_LARGE',
      value: 300,
      limit: 276824064,
    });
  });

  it('reads a free-text detail', () => {
    expect(parseDesktopError('E_IO permission denied')).toEqual({
      code: 'IO',
      detail: 'permission denied',
    });
    // A detail may span lines (OS error text can).
    expect(parseDesktopError('E_IO first\nsecond')).toEqual({ code: 'IO', detail: 'first\nsecond' });
  });

  it('reads a bare code', () => {
    expect(parseDesktopError('E_NOT_FOUND')).toEqual({ code: 'NOT_FOUND' });
    expect(parseDesktopError('E_BAD_NAME')).toEqual({ code: 'BAD_NAME' });
  });

  it('reads an Error the same way as a string', () => {
    expect(parseDesktopError(new Error('E_TOO_LARGE 1 2'))).toEqual({
      code: 'TOO_LARGE',
      value: 1,
      limit: 2,
    });
  });

  it('is null for everything older builds and untouched commands still say', () => {
    expect(parseDesktopError('file is too large')).toBeNull();
    expect(parseDesktopError('invalid file name')).toBeNull();
    expect(parseDesktopError('no work folder is linked')).toBeNull();
    expect(parseDesktopError('Desktop bridge unavailable')).toBeNull();
    expect(parseDesktopError('e_too_large 1 2')).toBeNull();
    expect(parseDesktopError(' E_TOO_LARGE 1 2')).toBeNull();
    expect(parseDesktopError('E_')).toBeNull();
    expect(parseDesktopError(undefined)).toBeNull();
  });

  it('a code with one number is a detail, not a half-parsed limit', () => {
    expect(parseDesktopError('E_TOO_LARGE 300')).toEqual({ code: 'TOO_LARGE', detail: '300' });
  });
});

describe('describeDesktopError', () => {
  it('prefers the detail, then the code, then the raw message', () => {
    expect(describeDesktopError('E_IO permission denied')).toBe('permission denied');
    expect(describeDesktopError('E_BAD_BODY')).toBe('BAD_BODY');
    expect(describeDesktopError(new Error('could not stage: x'))).toBe('could not stage: x');
  });
});

describe('encodeHeaderName', () => {
  it('percent-encodes a Latvian name to what Rust decode_header_name expects', () => {
    expect(encodeHeaderName('Zīle.zip')).toBe('Z%C4%ABle.zip');
    expect(encodeHeaderName('my-shader.js')).toBe('my-shader.js');
  });

  it('always yields visible ASCII (header values must be ISO-8859-1)', () => {
    for (const name of ['Zīle.zip', 'Ķermenis āda.js', '猫.js', 'a/b\\c:d.zip', 'x y.js', 'x\u0000y.js']) {
      const v = encodeHeaderName(name);
      expect(v, name).toMatch(/^[\x21-\x7e]*$/);
      expect(decodeURIComponent(v)).toBe(name);
    }
  });
});

describe('desktopBytes', () => {
  it('wraps an ArrayBuffer', () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    const out = desktopBytes(buf);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it('COPIES a typed-array view, honouring its offset', () => {
    const backing = new Uint8Array([9, 1, 2, 3, 9]);
    const view = backing.subarray(1, 4);
    const out = desktopBytes(view);
    expect(Array.from(out)).toEqual([1, 2, 3]);
    expect(out.buffer.byteLength).toBe(3);
    backing[2] = 77;
    expect(out[1]).toBe(2);
    expect(Array.from(desktopBytes(new DataView(backing.buffer, 3, 2)))).toEqual([3, 9]);
  });

  it('accepts a number array', () => {
    expect(Array.from(desktopBytes([4, 5, 6]))).toEqual([4, 5, 6]);
  });

  it('throws on anything else', () => {
    for (const bad of ['abc', null, undefined, 42, {}, { length: 2 }]) {
      expect(() => desktopBytes(bad)).toThrow('Unexpected binary payload');
    }
  });
});

describe('the read cap is the desktop reader cap plus the archive slack', () => {
  it('is 264 MiB', () => {
    expect(DESKTOP_MAX_READ_BYTES).toBe(264 * 1024 * 1024);
    expect(DESKTOP_MAX_READ_BYTES).toBe(DESKTOP_MAX_TOTAL_UNCOMPRESSED + ARCHIVE_SLACK_BYTES);
  });

  it("the slack is zipReader's own archive-over-unpacked slack", () => {
    expect(ARCHIVE_SLACK_BYTES).toBe(MAX_ARCHIVE_BYTES - MAX_TOTAL_UNCOMPRESSED);
  });
});

describe('invokeDesktop forwards raw bodies and headers untouched', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes cmd, a Uint8Array body and the options object straight through', async () => {
    const calls: unknown[][] = [];
    vi.stubGlobal('window', {
      __TAURI__: {
        core: {
          invoke: (...args: unknown[]) => {
            calls.push(args);
            return Promise.resolve('ok');
          },
        },
      },
    });
    const body = new Uint8Array([1, 2, 3]);
    const options = { headers: { [FILE_NAME_HEADER]: encodeHeaderName('Zīle.zip') } };
    await expect(invokeDesktop<string>(WORK_FOLDER_WRITE_BYTES, body, options)).resolves.toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('work_folder_write_bytes');
    expect(calls[0][1]).toBe(body);
    expect(calls[0][2]).toBe(options);
  });

  it('rejects (never throws) without the bridge', async () => {
    vi.stubGlobal('window', {});
    await expect(invokeDesktop('work_folder_status')).rejects.toThrow('Desktop bridge unavailable');
  });
});

describe('WorkFolder saves raw bytes and maps E_TOO_LARGE', () => {
  const src = read('components/Layout/WorkFolder.tsx');
  const slice = (from: string, to: string) => {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a);
    expect(a, from).toBeGreaterThan(-1);
    expect(b, to).toBeGreaterThan(a);
    return src.slice(a, b);
  };

  it('Save writes through work_folder_write_bytes with the name in the header', () => {
    const save = slice('const save = useCallback(', 'const toggleList');
    expect(save).toContain('await invokeDesktop<void>(WORK_FOLDER_WRITE_BYTES, bundle.bytes, {');
    expect(save).toContain('headers: { [FILE_NAME_HEADER]: encodeHeaderName(writeName) },');
  });

  it('no base64 path is left', () => {
    expect(src).not.toContain('bytesToBase64');
    expect(src).not.toContain('dataB64');
    expect(src).not.toMatch(/'work_folder_write'/);
    expect(src).not.toContain('function toBytes');
  });

  it('a read normalises through desktopBytes', () => {
    const load = slice('const loadEntry = useCallback(', 'if (!info)');
    expect(load).toContain('desktopBytes(data)');
  });

  it('the load catch asks parseDesktopError BEFORE reportZipImportError', () => {
    const load = slice('const loadEntry = useCallback(', 'if (!info)');
    const parse = load.indexOf('parseDesktopError(e)');
    const zip = load.indexOf('reportZipImportError(e, entry.fileName)');
    expect(parse).toBeGreaterThan(-1);
    expect(zip).toBeGreaterThan(parse);
    // The zip notice prints the UNPACKED cap, so the archive slack comes off.
    expect(load).toContain("kind: 'zip-limit'");
    expect(load).toContain('de.limit - ARCHIVE_SLACK_BYTES');
    // A non-zip gets the Work-folder sentence, filled in one pass.
    expect(load).toContain(
      "fillTemplate(\n                  t('{name} is larger than {limit} MB, the most the Work folder opens. Nothing was changed.', language),",
    );
    expect(load).toContain('limit: formatMiB(de.limit, language)');
  });

  it('the save catch turns E_BAD_BODY / E_BAD_NAME into a sentence, never the raw code', () => {
    // Tauri's postMessage fallback (once its custom-protocol fetch fails, for
    // the rest of the session) re-serialises the raw body as JSON, so Rust
    // answers `E_BAD_BODY` and every later Save would print that literal.
    const save = slice('const save = useCallback(', 'const toggleList');
    const catchBlock = save.slice(save.lastIndexOf('} catch (e) {'));
    const parse = catchBlock.indexOf('const de = parseDesktopError(e);');
    const text = catchBlock.indexOf('errorText(e)');
    expect(parse).toBeGreaterThan(-1);
    expect(text).toBeGreaterThan(parse);
    expect(catchBlock).toContain("de?.code === 'BAD_BODY' || de?.code === 'BAD_NAME'");
    expect(catchBlock).toContain(
      "? t('The desktop app could not receive the file. Nothing was written.', language)",
    );
    expect(catchBlock).toContain(': errorText(e),');
    const key = 'The desktop app could not receive the file. Nothing was written.';
    const value = (lv as { ui: Record<string, string> }).ui[key];
    expect(value).toBeTruthy();
    expect(value).not.toBe(key);
  });

  it('the Work-folder sentence has a Latvian entry carrying both placeholders', () => {
    const key = '{name} is larger than {limit} MB, the most the Work folder opens. Nothing was changed.';
    const value = (lv as { ui: Record<string, string> }).ui[key];
    expect(value).toBeTruthy();
    expect(value).not.toBe(key);
    expect(value).toContain('{name}');
    expect(value).toContain('{limit}');
  });
});
