/**
 * The desktop IPC contract, pinned as TEXT across the two halves.
 *
 * The frontend (utils/desktopIpc.ts, the `invokeDesktop` call sites) and the
 * Rust shell (src-tauri/src/*.rs) can only run together on a real `tauri
 * build`, and a drifted literal fails there with nothing to say which side
 * moved: a renamed command rejects at runtime, a header name that differs by
 * one character makes every save `E_BAD_NAME`, and a read cap that disagrees
 * with the reader's refuses a file the reader would have opened. This file
 * reads the Rust sources, main.rs's handler list, Cargo.toml/Cargo.lock and the
 * capability file, and holds each shared value to its TS twin. It proves the
 * TEXT agrees; the crate's own `cargo test` proves the Rust behaves.
 *
 * The autosave half (src-tauri/src/autosave.rs + utils/desktopAutosave.ts,
 * Phase 6 S6) pins its command table, the slot header, the flush event and the
 * `fsimg-<64 hex>` ref format the same way. Since S6 landed the Rust file is
 * REQUIRED: a checkout without autosave.rs is broken, not skipped.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ipc from './desktopIpc';
import * as autosave from './desktopAutosave';
import { safeJsonReviver } from './safeJson';
import { HARD_MAX_IMAGE_ENCODED_CHARS, IMAGE_REF_KEY } from './imageNode';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SRC = join(ROOT, 'src');
const TAURI = join(ROOT, 'src-tauri');
const readTauri = (rel: string) => readFileSync(join(TAURI, rel), 'utf8');

const mainRs = readTauri('src/main.rs');
const workFolderRs = readTauri('src/work_folder.rs');
const cargoToml = readTauri('Cargo.toml');
const cargoLock = readTauri('Cargo.lock');
const AUTOSAVE_RS = join(TAURI, 'src/autosave.rs');

const rustSources = (): Array<[string, string]> =>
  readdirSync(join(TAURI, 'src'))
    .filter((f) => f.endsWith('.rs'))
    .map((f) => [f, readTauri(join('src', f))]);

function appSources(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push([p, readFileSync(p, 'utf8')]);
    }
  };
  walk(SRC);
  return out;
}

/** A Rust integer constant expression: digits (with `_`) joined by `*`. */
function evalRustProduct(expr: string): number {
  const factors = expr.split('*').map((f) => f.trim().replace(/_/g, ''));
  for (const f of factors) expect(f, expr).toMatch(/^\d+$/);
  const n = factors.reduce((acc, f) => acc * Number(f), 1);
  expect(Number.isSafeInteger(n)).toBe(true);
  return n;
}

/** Every command the frontend invokes, resolved to its string. */
function invokedCommands(): Map<string, string> {
  const found = new Map<string, string>(); // command → first file that invokes it
  const constants = ipc as unknown as Record<string, unknown>;
  const CALL = /\binvokeDesktop\s*(?:<[^()]*?>)?\s*\(\s*([^\s,)]+)/g;
  for (const [file, text] of appSources()) {
    if (file.endsWith(join('utils', 'tauriBridge.ts'))) continue; // the definition
    for (const m of text.matchAll(CALL)) {
      const token = m[1];
      let cmd: string;
      const tableKey = /^AUTOSAVE_CMD\.(\w+)$/.exec(token);
      if (/^'[a-z0-9_]+'$/.test(token)) {
        cmd = token.slice(1, -1);
      } else if (tableKey) {
        const value = (autosave.AUTOSAVE_CMD as Record<string, unknown>)[tableKey[1]];
        expect(typeof value, `${file}: ${token} is not an AUTOSAVE_CMD entry`).toBe('string');
        cmd = value as string;
      } else if (/^[A-Z][A-Z0-9_]*$/.test(token)) {
        const value = constants[token];
        expect(typeof value, `${file}: ${token} is not a desktopIpc string constant`).toBe('string');
        cmd = value as string;
      } else {
        throw new Error(`${file}: invokeDesktop called with an unresolvable command ${token}`);
      }
      if (!found.has(cmd)) found.set(cmd, file);
    }
  }
  return found;
}

function registeredCommands(): Map<string, string> {
  const block = /generate_handler!\[([\s\S]*?)\]/.exec(mainRs);
  expect(block, 'main.rs has no generate_handler! list').not.toBeNull();
  const out = new Map<string, string>(); // command → module
  for (const m of block![1].matchAll(/(\w+)::(\w+)/g)) out.set(m[2], m[1]);
  return out;
}

/** Commands that may stay synchronous: none of them reads or writes a file the
 *  user picked, so running on the main thread cannot freeze the window on a
 *  large folder. Everything else must be `async` (CLAUDE.md, src-tauri). */
const MAY_BE_SYNC = new Set([
  'work_folder_status',
  'work_folder_forget',
  'autosave_close_ready',
  'bench_server_start',
  'bench_server_stop',
  'bench_server_status',
  'podest_open',
]);

describe('command registration', () => {
  const invoked = invokedCommands();
  const registered = registeredCommands();

  it('finds the invoke sites (a vacuous sweep would pass on nothing)', () => {
    for (const cmd of ['work_folder_status', 'work_folder_read', 'work_folder_write_bytes', 'bench_server_start', 'podest_open']) {
      expect(invoked.has(cmd), cmd).toBe(true);
    }
    // Every autosave command is invoked by the bridge, none is left unused.
    for (const cmd of Object.values(autosave.AUTOSAVE_CMD)) expect(invoked.has(cmd), cmd).toBe(true);
  });

  it('every invoked command is registered and defined directly under #[tauri::command]', () => {
    for (const [cmd, file] of invoked) {
      const mod = registered.get(cmd);
      expect(mod, `${cmd} (invoked in ${file}) is not in generate_handler!`).toBeTruthy();
      const rsPath = join(TAURI, 'src', `${mod}.rs`);
      const rs = readFileSync(rsPath, 'utf8');
      const def = new RegExp(String.raw`#\[tauri::command\]\s*pub\s+(async\s+)?fn\s+${cmd}\b`).exec(rs);
      expect(def, `${mod}.rs defines no #[tauri::command] pub fn ${cmd}`).not.toBeNull();
      if (!MAY_BE_SYNC.has(cmd)) expect(def![1], `${cmd} must be async`).toBeTruthy();
    }
  });

  it('the base64 write is gone from both sides', () => {
    for (const [file, text] of appSources()) {
      expect(text, file).not.toMatch(/\bwork_folder_write\b/);
    }
    for (const [file, text] of rustSources()) {
      expect(text, file).not.toMatch(/\bwork_folder_write\b/);
      expect(text, file).not.toContain('data_b64');
      expect(text, file).not.toMatch(/\bbase64::/);
    }
    expect(registered.has('work_folder_write')).toBe(false);
    // `dataB64` is also the Data node's payload key, so the rule is scoped to
    // the IPC call sites.
    for (const [file, text] of appSources()) {
      if (text.includes('invokeDesktop')) expect(text, file).not.toContain('dataB64');
    }
  });
});

describe('shared literals', () => {
  it('the file-name header is the same string on both sides', () => {
    const m = /pub const FILE_NAME_HEADER: &str = "([^"]+)";/.exec(workFolderRs);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(ipc.FILE_NAME_HEADER);
    // An HTTP header name is case-insensitive on the wire but `http`'s
    // HeaderMap stores it lowercase; a capital would never match.
    expect(ipc.FILE_NAME_HEADER).toBe(ipc.FILE_NAME_HEADER.toLowerCase());
  });

  it('the write command reads that header and a RAW body', () => {
    const fn = workFolderRs.slice(workFolderRs.indexOf('pub async fn work_folder_write_bytes('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('tauri::ipc::InvokeBody::Raw(bytes)');
    expect(body).toContain('.get(FILE_NAME_HEADER)');
    expect(body).toContain('.and_then(decode_header_name)');
    expect(body).toContain('write_file(&app, &state, &name, bytes)');
  });

  it('decode_header_name is the percent decoder the frontend encodes for', () => {
    expect(workFolderRs).toContain('percent_encoding::percent_decode_str(v)');
    expect(workFolderRs).toContain('.decode_utf8()');
    // And its cargo cases exist (the owner runs them with `cargo test`).
    expect(workFolderRs).toContain(`decode_header_name("${ipc.encodeHeaderName('Zīle.zip')}")`);
    expect(workFolderRs).toContain('decode_header_name("%FF"), None');
  });

  it('MAX_READ_BYTES equals DESKTOP_MAX_READ_BYTES', () => {
    const m = /const MAX_READ_BYTES: u64 = ([^;]+);/.exec(workFolderRs);
    expect(m).not.toBeNull();
    expect(evalRustProduct(m![1])).toBe(ipc.DESKTOP_MAX_READ_BYTES);
  });

  it('the too-large refusal carries the size and MAX_READ_BYTES, and parses', () => {
    expect(workFolderRs).toMatch(
      /format!\("E_TOO_LARGE \{\} \{\}",\s*meta\.len\(\),\s*MAX_READ_BYTES\)/,
    );
    expect(ipc.parseDesktopError(`E_TOO_LARGE 300 ${ipc.DESKTOP_MAX_READ_BYTES}`)).toEqual({
      code: 'TOO_LARGE',
      value: 300,
      limit: ipc.DESKTOP_MAX_READ_BYTES,
    });
  });

  it('every E_ string Rust returns parses to its own code', () => {
    let count = 0;
    for (const [file, text] of rustSources()) {
      for (const m of text.matchAll(/"(E_[A-Z_]+[^"\\]*)"/g)) {
        count++;
        const literal = m[1];
        const code = /^E_([A-Z_]+)/.exec(literal)![1];
        const sample = literal.replace(/\{[^}]*\}/g, '1');
        expect(ipc.parseDesktopError(sample)?.code, `${file}: ${literal}`).toBe(code);
      }
    }
    expect(count).toBeGreaterThanOrEqual(3); // E_TOO_LARGE, E_BAD_BODY, E_BAD_NAME
  });

  it('every code a consumer switches on exists in Rust', () => {
    const consumed = new Set<string>();
    for (const [file, text] of appSources()) {
      if (file.endsWith(join('utils', 'desktopIpc.ts')) || !text.includes('parseDesktopError(')) continue;
      for (const m of text.matchAll(/\.code\s*===\s*'([A-Z_]+)'/g)) consumed.add(m[1]);
    }
    expect(consumed.has('TOO_LARGE')).toBe(true);
    const rust = rustSources().map(([, t]) => t).join('\n');
    for (const code of consumed) {
      expect(rust, code).toContain(`"E_${code}`);
    }
  });
});

describe('the crate', () => {
  it('main.rs registers the raw write and not the base64 one', () => {
    expect(mainRs).toContain('work_folder::work_folder_write_bytes');
  });

  it('Cargo.toml has no base64 dependency, and keeps percent-encoding', () => {
    expect(cargoToml).not.toMatch(/^\s*base64\s*=/m);
    expect(cargoToml).toMatch(/^\s*percent-encoding\s*=/m);
  });

  it("Cargo.lock's own package entry lost its base64 edge", () => {
    const m = /\[\[package\]\]\nname = "fastshaders"\n[\s\S]*?(?=\n\[\[package\]\]|$)/.exec(cargoLock);
    expect(m).not.toBeNull();
    expect(m![0]).not.toContain('base64');
    expect(m![0]).toContain('"percent-encoding"');
  });

  it('capabilities stay bare core:default for the main window only', () => {
    const caps = JSON.parse(readTauri('capabilities/default.json'), safeJsonReviver) as {
      windows: unknown;
      permissions: unknown;
    };
    expect(caps.permissions).toEqual(['core:default']);
    expect(caps.windows).toEqual(['main']);
  });
});

describe('the autosave half (S6)', () => {
  const autosaveRs = readFileSync(AUTOSAVE_RS, 'utf8');

  it('main.rs flushes before the main window closes and before a user quit', () => {
    expect(mainRs).toContain('.on_window_event(');
    expect(mainRs).toContain('CloseRequested');
    expect(mainRs).toContain('prevent_close()');
    expect(mainRs).toContain('window.label() != "main"');
    expect(mainRs).toMatch(/ExitRequested\s*\{\s*code:\s*None/);
    expect(mainRs).toContain('prevent_exit()');
    expect(mainRs).toContain('.manage(autosave::CloseState::default())');
  });

  it('Cargo.toml carries sha2', () => {
    expect(cargoToml).toMatch(/^\s*sha2\s*=/m);
  });

  it('the Rust image cap is the hard image ceiling', () => {
    const m = /MAX_IMAGE_BYTES: u64 = ([^;]+);/.exec(autosaveRs);
    expect(m).not.toBeNull();
    expect(evalRustProduct(m![1])).toBe(HARD_MAX_IMAGE_ENCODED_CHARS);
  });

  it('refs are fsimg-<64 hex>, spelled the same on both sides', () => {
    // Rust scans the stored JSON for the STRING token `"fsimg-` + 64 hex + `"`.
    const m = /const REF_PREFIX: &\[u8\] = b"\\"([a-z]+-)";/.exec(autosaveRs);
    expect(m, 'autosave.rs REF_PREFIX').not.toBeNull();
    expect(m![1]).toBe(autosave.desktopImageRef(''));
    expect(autosaveRs).toContain('const DIGEST_LEN: usize = 64;');
    const d = 'a'.repeat(64);
    expect(autosave.DESKTOP_IMAGE_REF_RE.test(autosave.desktopImageRef(d))).toBe(true);
    expect(autosave.DESKTOP_IMAGE_REF_RE.test(autosave.desktopImageRef(d.slice(1)))).toBe(false);
    expect(autosave.DESKTOP_IMAGE_REF_RE.test(autosave.desktopImageRef(d + 'a'))).toBe(false);
    expect(autosave.DESKTOP_IMAGE_REF_RE.test(autosave.desktopImageRef('A'.repeat(64)))).toBe(false);
  });

  it('the missing-image check reads the exact key the writer emits', () => {
    // autosave_write refuses a document only for an `"imageRef":"fsimg-` token
    // (JSON.stringify writes no whitespace), never for a string that merely
    // contains a ref; GC keeps the broad `"fsimg-` scan.
    const m = /const IMAGE_REF_TOKEN: &\[u8\] = b"((?:\\.|[^"\\])*)";/.exec(autosaveRs);
    expect(m, 'autosave.rs IMAGE_REF_TOKEN').not.toBeNull();
    expect(m![1].replace(/\\"/g, '"')).toBe(`"${IMAGE_REF_KEY}":"${autosave.desktopImageRef('')}`);
    expect(autosaveRs).toMatch(/fn missing_image\([^)]*\)[^{]*\{[^}]*image_ref_digests\(/);
    expect(autosaveRs).toMatch(/missing_image\(&dir, bytes\)/);
  });

  it('the header and event literals are the ones the frontend uses', () => {
    expect(autosaveRs).toContain(`pub const SLOT_HEADER: &str = "${autosave.SLOT_HEADER}";`);
    expect(autosaveRs).toContain(`pub const FLUSH_EVENT: &str = "${autosave.AUTOSAVE_FLUSH_EVENT}";`);
    expect(autosave.SLOT_HEADER).toBe(autosave.SLOT_HEADER.toLowerCase());
    expect(autosaveRs).toContain('.get(SLOT_HEADER)');
  });

  it('every AUTOSAVE_CMD entry is registered from autosave.rs', () => {
    const registered = registeredCommands();
    for (const cmd of Object.values(autosave.AUTOSAVE_CMD)) {
      expect(registered.get(cmd), cmd).toBe('autosave');
      expect(autosaveRs).toMatch(new RegExp(String.raw`#\[tauri::command\]\s*pub\s+(async\s+)?fn\s+${cmd}\b`));
    }
  });

  it('the slot vocabulary is the same on both sides', () => {
    expect([...autosave.DESKTOP_SLOTS].sort()).toEqual(['graph', 'savedGroups']);
  });

  it('writes are refused when they name a missing image, and the reader re-verifies', () => {
    expect(autosaveRs).toContain('format!("E_MISSING_IMAGE {d}")');
    expect(autosaveRs).toContain('"E_CORRUPT_IMAGE"');
    expect(autosaveRs).toMatch(/format!\("E_TOO_LARGE \{\} \{\}",\s*bytes\.len\(\),\s*MAX_DOC_BYTES\)/);
  });

  it('slot_files maps exactly graph and savedGroups', () => {
    const at = autosaveRs.indexOf('fn slot_files');
    expect(at).toBeGreaterThan(-1);
    const body = autosaveRs.slice(at, autosaveRs.indexOf('\n}\n', at));
    const arms = [...body.matchAll(/"([A-Za-z]+)"\s*=>/g)].map((m) => m[1]).sort();
    expect(arms).toEqual(['graph', 'savedGroups']);
  });
});
