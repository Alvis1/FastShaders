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
 *
 * The local-LLM half (src-tauri/src/llm.rs + llm/transport/*) pins its
 * commands, route lists, hosts, caps, frame tags and timers, and the bridge's
 * security shape: main webview only, raw bytes only, no origin header, no HTTP
 * client crate.
 *
 * The shell's own security shape is pinned here too: no capability reaches a
 * remote origin, the navigation allow-list is registered for every webview
 * (its logic is main.rs's `cargo test`), the podest comment no longer claims
 * the capability fences app commands, and the manual IPC probe
 * (docs/desktop-ipc-probe.js) still runs when the preview builds it.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ipc from './desktopIpc';
import * as autosave from './desktopAutosave';
import { safeJsonReviver } from './safeJson';
import { HARD_MAX_IMAGE_ENCODED_CHARS, IMAGE_REF_KEY } from './imageNode';
import { buildPreviewShaderModule } from '@/engine/tslToPreviewHTML';
import { RUST_TRANSPORT_CODES } from '@/llm/transport/tauriTransport';
import { CHAT_TIMEOUTS, LIST_TIMEOUTS, type TransportTimeouts } from '@/llm/transport/fetchTransport';

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
    for (const cmd of [
      'work_folder_status',
      'work_folder_read',
      'work_folder_write_bytes',
      'bench_server_start',
      'podest_open',
      'llm_local_models',
      'llm_local_chat',
      'llm_local_cancel',
    ]) {
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

  /**
   * No REMOTE capability, anywhere. The sandboxed preview frame and podest's
   * stage frame run shader code from shared files, and one reason they cannot
   * invoke a command is that the IPC treats their opaque `about:srcdoc` origin
   * as non-local (on Windows WebView2 the init scripts, invoke key included,
   * reach sub-frames too). A `remote` entry that matched them would hand every
   * app command to that code. (Read from the Tauri 2.11 sources; the built-app
   * check is docs/desktop-ipc-probe.js, platform-and-release.md.)
   */
  it('no capability file grants anything to a remote origin', () => {
    const dir = join(TAURI, 'capabilities');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files).toEqual(['default.json']);
    for (const f of files) {
      const caps = JSON.parse(readTauri(`capabilities/${f}`), safeJsonReviver) as Record<string, unknown>;
      expect(caps.remote, f).toBeUndefined();
    }
    // …and tauri.conf.json inlines none either.
    const conf = JSON.parse(readTauri('tauri.conf.json'), safeJsonReviver) as { app?: { security?: { capabilities?: unknown } } };
    expect(conf.app?.security?.capabilities).toBeUndefined();
  });

  /**
   * The capability scopes CORE (plugin) permissions only. App commands
   * registered in `invoke_handler` pass in every window from a local URL,
   * because build.rs declares no AppManifest — so the podest window can call
   * them too. Both texts used to say the opposite.
   */
  it('neither the capability nor podest_window.rs claims the ACL fences app commands', () => {
    const caps = JSON.parse(readTauri('capabilities/default.json'), safeJsonReviver) as { description: string };
    expect(caps.description).not.toMatch(/covered by core:default/);
    expect(caps.description).toMatch(/outside this ACL/);
    const podestDoc = readTauri('src/podest_window.rs')
      .split('\n')
      .filter((l) => l.startsWith('//!'))
      .map((l) => l.replace(/^\/\/!\s?/, ''))
      .join(' ');
    expect(podestDoc).not.toMatch(/are covered by it/);
    expect(podestDoc).not.toMatch(/no IPC permissions whatsoever/);
    expect(podestDoc).toMatch(/could call the work-folder and autosave commands/);
    expect(readTauri('build.rs')).not.toMatch(/AppManifest/);
  });
});

describe('the navigation allow-list (main.rs)', () => {
  /** main.rs above its test modules: the code that ships. */
  const shipped = mainRs.slice(0, mainRs.indexOf('#[cfg(test)]'));

  it('is registered as a PLUGIN, so it runs for every webview (the main window comes from tauri.conf.json)', () => {
    expect(mainRs).toContain('.plugin(navigation_guard())');
    expect(shipped).toMatch(/tauri::plugin::Builder::new\("navigation-guard"\)\s*\.on_navigation\(/);
    // Nothing else in the crate sets a navigation handler of its own that
    // could disagree with it (a builder's handler runs BEFORE the plugins).
    for (const [file, text] of rustSources()) {
      const hooks = [...text.matchAll(/\.on_navigation\(/g)].length;
      expect(hooks, file).toBe(file === 'main.rs' ? 1 : 0);
    }
  });

  it('reads the dev server from the config, and only under `tauri dev`', () => {
    // Never a literal port: tauri.conf.json's devUrl is the one place it lives.
    expect(shipped).toContain('tauri::is_dev()');
    expect(shipped).toContain('webview.config().build.dev_url');
    expect(shipped).not.toMatch(/5173/);
    expect(shipped).toContain('cfg!(windows)');
  });

  it('its logic is unit-tested by the crate on both platform branches', () => {
    expect(mainRs).toMatch(/#\[cfg\(test\)\]\s*mod navigation_tests\b/);
    const tests = mainRs.slice(mainRs.indexOf('mod navigation_tests'));
    // The inventory rows (docs/dev/platform-and-release.md) are each pinned.
    for (const url of [
      'about:blank',
      'about:srcdoc',
      'tauri://localhost/podest.html',
      'http://tauri.localhost/',
      'mailto:',
      'blob:tauri://localhost/',
      'blob:null/',
      'data:text/html',
      'http://127.0.0.1:',
    ]) {
      expect(tests, url).toContain(url);
    }
  });
});

/**
 * The manual IPC probe is a shader: it only answers the question if the
 * preview's module builder keeps its code. The first version did not — an
 * expression-bodied `Fn(() => verdict)` is not read, the module fell back to
 * the builder's plain red, and red was the "invoke succeeded, do not ship"
 * colour. So the probe is built here exactly as the preview builds it, and the
 * resulting module is RUN against stand-ins for each frame the two platforms
 * can present.
 */
describe('the manual IPC probe (docs/desktop-ipc-probe.js)', () => {
  const probe = readFileSync(join(ROOT, 'docs', 'desktop-ipc-probe.js'), 'utf8');
  const built = buildPreviewShaderModule(probe);
  const GREEN = { vec3: [0, 0.8, 0.2] };
  const YELLOW = { vec3: [1, 0.85, 0] };
  const MAGENTA = { vec3: [1, 0, 1] };

  /** Runs the built module with the frame's globals, timers and console replaced. */
  async function runProbe(frame: Record<string, unknown>, fireTimers: boolean) {
    const IMPORT = /^import \{([^}]*)\} from 'three\/tsl';$/m;
    expect(built).toMatch(IMPORT);
    const body = built
      .replace(IMPORT, 'const {$1} = fsTsl;')
      .replace(/^export const threeRevision\b/m, 'const threeRevision')
      .replace(/^export default function\s*\(/m, 'return function (');
    expect(body).not.toMatch(/^\s*(?:import|export)\b/m);
    const lines: string[] = [];
    const tsl = {
      vec3: (...c: number[]) => ({ vec3: c }),
      Fn: (f: unknown) => f,
    };
    const timer = (cb: () => void) => {
      if (fireTimers) cb();
      return 0;
    };
    const fakeConsole = { error: (...a: unknown[]) => lines.push(a.map(String).join(' ')) };
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (...args: unknown[]) => Promise<() => { colorNode: unknown }>;
    const shaderFn = await new AsyncFunction('fsTsl', 'globalThis', 'setTimeout', 'console', body)(
      tsl,
      frame,
      timer,
      fakeConsole,
    );
    return { colour: shaderFn().colorNode, lines };
  }

  it('survives the module build: its code is in the module and the colour is its verdict', () => {
    expect(built).toContain("fsProbeInternals.invoke('work_folder_status')");
    expect(built).toMatch(/return \{ colorNode: fsProbeVerdict \};/);
    // The command it tries exists, so a refusal is the IPC's, not a typo's.
    expect(registeredCommands().get('work_folder_status')).toBe('work_folder');
  });

  it("no verdict is the builder's own fallback red (which means the probe did not run)", () => {
    expect(buildPreviewShaderModule("const shader = Fn(() => vec3(0, 1, 0));")).toContain(
      'colorNode: vec3(1, 0, 0)',
    );
    for (const v of [GREEN, YELLOW, MAGENTA]) expect(v.vec3).not.toEqual([1, 0, 0]);
    expect(probe).toMatch(/RED\s+the preview's own fallback colour: the probe did NOT run/);
  });

  it('GREEN when nothing Tauri is in the frame (macOS: only the message handler is page-wide)', async () => {
    const applied: Array<() => void> = [];
    const frame = {
      webkit: { messageHandlers: { ipc: {} } },
      addEventListener: (type: string, cb: () => void, opts: { once?: boolean }) => {
        expect(type).toBe('shader-applied');
        expect(opts.once).toBe(true);
        applied.push(cb);
      },
    };
    const { colour, lines } = await runProbe(frame, true);
    expect(colour).toEqual(GREEN);
    expect(lines).toEqual(['[desktop-ipc-probe] no invoke | seen: webkit.messageHandlers.ipc']);
    // Said again once the shader applies: a successful apply clears the line.
    expect(applied).toHaveLength(1);
    applied[0]();
    expect(lines).toEqual([lines[0], lines[0]]);
  });

  it('YELLOW when the bridge is in the frame but the invoke never answers (Windows, predicted)', async () => {
    const frame = {
      __TAURI_INTERNALS__: { invoke: () => new Promise(() => {}) },
      __TAURI__: {},
      ipc: {},
      chrome: { webview: {} },
    };
    const { colour, lines } = await runProbe(frame, true);
    expect(colour).toEqual(YELLOW);
    expect(lines[0]).toBe(
      '[desktop-ipc-probe] no invoke | seen: __TAURI_INTERNALS__, __TAURI__, window.ipc, chrome.webview, invoke no answer in 3 s',
    );
  });

  it('YELLOW when the invoke is refused', async () => {
    const frame = { __TAURI_INTERNALS__: { invoke: () => Promise.reject(new Error('Origin header is not a valid URL')) } };
    const { colour, lines } = await runProbe(frame, false);
    expect(colour).toEqual(YELLOW);
    expect(lines[0]).toContain('invoke refused: Error: Origin header is not a valid URL');
  });

  it('MAGENTA when an invoke from the frame succeeds', async () => {
    const frame = { __TAURI_INTERNALS__: { invoke: () => Promise.resolve({ folder: null }) } };
    const { colour, lines } = await runProbe(frame, false);
    expect(colour).toEqual(MAGENTA);
    expect(lines[0]).toBe('[desktop-ipc-probe] INVOKE SUCCEEDED | seen: __TAURI_INTERNALS__');
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

/**
 * Rust source with its `//` comments removed. String literals are kept whole,
 * so the `//` of "http://" is not taken for a comment. (src-tauri uses no
 * block comments and no `'"'` char literal, the two things this would misread.)
 */
function rustCode(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let inString = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inString) {
          if (c === '\\') i++;
          else if (c === '"') inString = false;
        } else if (c === '"') inString = true;
        else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

describe('the local-LLM bridge (llm.rs)', () => {
  const llmRs = readTauri('src/llm.rs');
  /** Everything above the test module, comments removed: the shipped code. */
  const shipped = rustCode(llmRs.slice(0, llmRs.indexOf('#[cfg(test)]')));
  const commands = [ipc.LLM_LOCAL_MODELS, ipc.LLM_LOCAL_CHAT, ipc.LLM_LOCAL_CANCEL];
  const commandBody = (cmd: string) => {
    const at = llmRs.indexOf(`pub async fn ${cmd}(`);
    expect(at, cmd).toBeGreaterThan(-1);
    return llmRs.slice(at, llmRs.indexOf('\n}\n', at));
  };
  const rustStrings = (name: string): string[] => {
    const m = new RegExp(String.raw`const ${name}: \[&str; (\d+)\] = \[([\s\S]*?)\];`).exec(llmRs);
    expect(m, name).not.toBeNull();
    const items = [...m![2].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    expect(items.length, `${name} declares ${m![1]}`).toBe(Number(m![1]));
    return items;
  };
  const rustConst = (name: string, type: string): number => {
    const m = new RegExp(String.raw`const ${name}: ${type} = ([^;]+);`).exec(llmRs);
    expect(m, name).not.toBeNull();
    return evalRustProduct(m![1]);
  };

  it('registers the three commands from llm.rs, each async', () => {
    const registered = registeredCommands();
    for (const cmd of commands) {
      expect(registered.get(cmd), cmd).toBe('llm');
      expect(llmRs, cmd).toMatch(new RegExp(String.raw`#\[tauri::command\]\s*pub\s+async\s+fn\s+${cmd}\b`));
    }
    expect(mainRs).toMatch(/^mod llm;$/m);
    expect(mainRs).toContain('.manage(llm::LlmState::default())');
  });

  it('every command refuses any webview but main, first thing', () => {
    expect(llmRs).toContain('const MAIN_WEBVIEW: &str = "main";');
    for (const cmd of commands) {
      const body = commandBody(cmd);
      const check = body.indexOf('if webview.label() != MAIN_WEBVIEW {');
      expect(check, cmd).toBeGreaterThan(-1);
      // Before the state is touched or anything is spawned.
      expect(check, cmd).toBeLessThan(body.indexOf('state.0'));
    }
  });

  it('main.rs registers the page-load guard that cancels an orphaned request', () => {
    expect(mainRs).toContain('.plugin(llm::page_load_guard())');
    const guard = shipped.slice(shipped.indexOf('pub fn page_load_guard'));
    expect(guard).toContain('webview.label() == MAIN_WEBVIEW && payload.event() == PageLoadEvent::Started');
    expect(guard).toContain('cancel_all()');
  });

  it('the route lists and loopback hosts are the same on both sides', () => {
    expect(rustStrings('GET_ROUTES')).toEqual([...ipc.LLM_LOCAL_GET_ROUTES]);
    expect(rustStrings('POST_ROUTES')).toEqual([...ipc.LLM_LOCAL_POST_ROUTES]);
    expect(rustStrings('LOOPBACK_HOSTS')).toEqual([...ipc.LLM_LOOPBACK_HOSTS]);
  });

  it('the caps and frame tags are the same on both sides', () => {
    expect(rustConst('MAX_REQUEST_BYTES', 'usize')).toBe(ipc.LLM_MAX_REQUEST_BYTES);
    expect(rustConst('MAX_STREAM_BYTES', 'usize')).toBe(ipc.LLM_MAX_STREAM_BYTES);
    expect(rustConst('MAX_MODEL_LIST_BYTES', 'usize')).toBe(ipc.LLM_MAX_MODEL_LIST_BYTES);
    expect(rustConst('MAX_HEADER_BYTES', 'usize')).toBe(16 * 1024);
    expect(rustConst('FRAME_DATA', 'u8')).toBe(ipc.LLM_FRAME_DATA);
    expect(rustConst('FRAME_END', 'u8')).toBe(ipc.LLM_FRAME_END);
    expect(ipc.LLM_FRAME_DATA).not.toBe(ipc.LLM_FRAME_END);
  });

  it("the fetch transport's timers are Rust's", () => {
    const timers = (name: string): TransportTimeouts => {
      const m = new RegExp(String.raw`const ${name}: Timeouts = Timeouts \{([\s\S]*?)\};`).exec(llmRs);
      expect(m, name).not.toBeNull();
      const secs = (field: string) => {
        const f = new RegExp(String.raw`${field}: Duration::from_secs\((\d+)\)`).exec(m![1]);
        expect(f, `${name}.${field}`).not.toBeNull();
        return Number(f![1]) * 1000;
      };
      expect(secs('connect'), `${name}.connect`).toBe(3000);
      return { firstByteMs: secs('first_byte'), betweenChunksMs: secs('between_chunks'), totalMs: secs('total') };
    };
    expect(timers('CHAT_TIMEOUTS')).toEqual(CHAT_TIMEOUTS);
    expect(timers('LIST_TIMEOUTS')).toEqual(LIST_TIMEOUTS);
  });

  it('every code the transports map has its E_ literal in llm.rs', () => {
    for (const code of RUST_TRANSPORT_CODES) expect(llmRs, code).toContain(`"E_${code}`);
  });

  /**
   * A String sent through `Channel<InvokeResponseBody>` becomes the `Json`
   * variant, which Tauri pastes UNQUOTED into an eval in the main window — so
   * whatever answers on the loopback port could run script there. Server bytes
   * therefore cross only as `Raw` (2026-10-01 bridge review).
   */
  it('server bytes cross to the webview only as Raw', () => {
    expect(llmRs).not.toContain('InvokeResponseBody::Json');
    expect(shipped).not.toContain('InvokeResponseBody::from');
    const sends = [...shipped.matchAll(/\.send\(/g)].length;
    const rawSends = [...shipped.matchAll(/\.send\(InvokeResponseBody::Raw\(/g)].length;
    expect(rawSends).toBeGreaterThanOrEqual(2); // the data frames and END
    expect(sends).toBe(rawSends);
    const responses = [...shipped.matchAll(/Response::new\(/g)].length;
    expect(responses).toBeGreaterThanOrEqual(1);
    expect([...shipped.matchAll(/Response::new\(InvokeResponseBody::Raw\(/g)].length).toBe(responses);
    for (const m of shipped.matchAll(/Channel<([^>]*)>/g)) expect(m[1]).toBe('InvokeResponseBody');
  });

  it('writes no origin header (nor anything else naming one)', () => {
    expect(rustCode(llmRs)).not.toMatch(/origin/i);
    // The exact header set the request writes.
    expect(shipped).toContain('Host: {host}');
    expect(shipped).toContain('Accept-Encoding: identity');
    expect(shipped).toContain('Connection: close');
  });

  it('the exchange runs off the async workers, on a non-blocking socket', () => {
    expect([...shipped.matchAll(/tauri::async_runtime::spawn_blocking\(/g)].length).toBe(2);
    expect(shipped).toContain('set_nonblocking(true)');
    expect(shipped).not.toMatch(/set_read_timeout|set_write_timeout/);
    expect(shipped).not.toMatch(/to_socket_addrs|lookup_host/); // no DNS
  });

  it('the shared URL vectors live under src-tauri and the Rust tests read them', () => {
    expect(existsSync(join(TAURI, 'tests', 'llm-urls.json'))).toBe(true);
    expect(llmRs).toContain('include_str!("../tests/llm-urls.json")');
  });

  /** Hand-written HTTP over std::net is the decision (no TLS, proxies,
   *  redirects or compression to switch off). `tiny_http` is a SERVER and is
   *  already here for the bench, so the pin names the client crates. */
  it('pulls in no HTTP client crate', () => {
    const CLIENTS = ['reqwest', 'ureq', 'hyper', 'httparse', 'attohttpc', 'minreq', 'isahc', 'curl', 'surf', 'http_req'];
    const lockEntry = /\[\[package\]\]\nname = "fastshaders"\n[\s\S]*?(?=\n\[\[package\]\]|$)/.exec(cargoLock);
    expect(lockEntry).not.toBeNull();
    for (const crate of CLIENTS) {
      expect(cargoToml, crate).not.toMatch(new RegExp(String.raw`^\s*${crate}\s*=`, 'm'));
      expect(lockEntry![0], crate).not.toMatch(new RegExp(String.raw`"${crate}(?: [^"]*)?"`));
    }
  });
});
