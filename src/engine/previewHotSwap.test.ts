/**
 * The shader HOT-SWAP channel's contract, driven for real.
 *
 * A shader edit no longer swaps the preview iframe's `srcDoc` — the parent
 * posts the new module down `fs:shader` and the document reloads it in place
 * (SHADER_HOT_SWAP_SCRIPT in tslToPreviewHTML.ts). That is what lets the
 * camera, the spin phase, the animation playhead, the tuned uniforms and
 * `time` survive an edit, and it is also the one change here that can fail
 * INVISIBLY: a swap that reaches nothing leaves the previous picture on screen
 * looking perfectly correct.
 *
 * The vitest env is `node`, so none of this can be verified in a browser. What
 * CAN be verified is the receiver's logic, and it is verified by EXECUTING it:
 * the script is extracted from the generated document verbatim and driven
 * against stub A-Frame/URL/Blob objects — the `feedbackReport.test.ts`
 * technique. Every message-shape, idempotency, revoke and acknowledgement rule
 * below is therefore the shipped bytes' behaviour, not a restatement of it.
 * What remains browser-only, and is stated here so nobody mistakes this file
 * for full cover: that the r184 renderer survives a live material swap, and
 * that a failed apply really does drop the mesh to its stored grey original.
 */
import { describe, it, expect } from 'vitest';
import {
  SHADER_SWAP_MESSAGE,
  buildPreviewShaderModule,
  tslToPreviewHTML,
} from './tslToPreviewHTML';

const TSL = "import { vec3 } from 'three/tsl';\nconst shader = Fn(() => { return vec3(1); });\nexport default shader;\n";

/** Pull the hot-swap script's body out of a generated document. */
function extractSwapScript(html: string): string {
  const marker = `msg.type !== "${SHADER_SWAP_MESSAGE}"`;
  const at = html.indexOf(marker);
  expect(at, 'hot-swap receiver missing from the document').toBeGreaterThan(-1);
  const open = html.lastIndexOf('<script>', at);
  const close = html.indexOf('</script>', at);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return html.slice(open + '<script>'.length, close);
}

interface Listener { (ev: unknown): void }

/**
 * A minimal stand-in for the sandboxed document: one `#preview-entity`
 * carrying a `shader` component, an object-URL registry that records every
 * mint and revoke, and a parent that records every posted message.
 */
function makeHarness(html: string, opts: { booted?: boolean } = {}) {
  const posted: Record<string, unknown>[] = [];
  const minted: string[] = [];
  const revoked: string[] = [];
  let urlSeq = 0;

  const entityListeners = new Map<string, Set<Listener>>();
  const shaderComp: { _propertyUniforms: Record<string, unknown> | null } = {
    _propertyUniforms: { alpha: 1 },
  };
  const setAttrCalls: unknown[][] = [];
  const entity = {
    components: { shader: shaderComp },
    setAttribute: (...args: unknown[]) => { setAttrCalls.push(args); },
    addEventListener: (type: string, fn: Listener) => {
      if (!entityListeners.has(type)) entityListeners.set(type, new Set());
      entityListeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      entityListeners.get(type)?.delete(fn);
    },
  };
  const emit = (type: string, detail?: unknown) => {
    for (const fn of [...(entityListeners.get(type) ?? [])]) fn({ detail });
  };

  const messageListeners: Listener[] = [];
  const bootCallbacks: (() => void)[] = [];
  let booted = opts.booted ?? true;

  const parent = { postMessage: (m: Record<string, unknown>) => { posted.push(m); } };
  const win: Record<string, unknown> = {
    __shaderCode: 'BOOT_MODULE',
    __shaderUrl: 'blob:boot',
    parent,
    addEventListener: (type: string, fn: Listener) => {
      if (type === 'message') messageListeners.push(fn);
    },
    __fsWhenSceneBooted: (fn: () => void) => {
      if (booted) fn();
      else bootCallbacks.push(fn);
    },
  };
  const doc = {
    getElementById: (id: string) => (id === 'preview-entity' ? entity : null),
  };
  const URLStub = {
    createObjectURL: () => { const u = `blob:u${++urlSeq}`; minted.push(u); return u; },
    revokeObjectURL: (u: string) => { revoked.push(u); },
  };
  class BlobStub { constructor(public parts: unknown[]) {} }

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('window', 'document', 'URL', 'Blob', extractSwapScript(html))(
    win, doc, URLStub, BlobStub,
  );

  return {
    posted, minted, revoked, setAttrCalls, shaderComp, emit,
    /** Deliver a message as if it came from the parent window. */
    send(data: unknown, source: unknown = parent) {
      for (const fn of messageListeners) fn({ source, data });
    },
    bootScene() {
      booted = true;
      const q = bootCallbacks.splice(0);
      for (const fn of q) fn();
    },
  };
}

const html = tslToPreviewHTML(TSL, { geometry: 'sphere', shaderModule: 'BOOT_MODULE' });

describe('preview shader hot-swap: where it is emitted', () => {
  it('rides every sandboxed preview document', () => {
    for (const geometry of ['sphere', 'cube', 'plane', 'teapot', 'bunny'] as const) {
      expect(tslToPreviewHTML(TSL, { geometry })).toContain(`msg.type !== "${SHADER_SWAP_MESSAGE}"`);
    }
  });

  it('is absent from the XR popup, which is top-level and has no parent to ack to', () => {
    expect(tslToPreviewHTML(TSL, { xr: true })).not.toContain(SHADER_SWAP_MESSAGE);
  });

  it('is attached AFTER the boot shader attach, so a swap can never revoke the url the boot is about to load', () => {
    const boot = html.indexOf('setAttribute("shader", "src: " + window.__shaderUrl)');
    const hot = html.indexOf(`msg.type !== "${SHADER_SWAP_MESSAGE}"`);
    expect(boot).toBeGreaterThan(-1);
    expect(hot).toBeGreaterThan(boot);
  });

  it('bakes the module the parent will hot-swap against, byte for byte', () => {
    // The parent builds the module for the channel and hands the SAME string
    // back to be baked, so the document's copy and the receiver's idempotency
    // seed cannot differ — otherwise every cold rebuild is followed by one
    // redundant re-apply.
    const mod = buildPreviewShaderModule(TSL);
    expect(tslToPreviewHTML(TSL, { shaderModule: mod })).toBe(tslToPreviewHTML(TSL));
    expect(mod).toContain('export default');
  });
});

describe('preview shader hot-swap: applying a module', () => {
  it('revokes the old url, mints one for the new bytes and points the loader at it', () => {
    const h = makeHarness(html);
    h.send({ type: SHADER_SWAP_MESSAGE, code: 'NEXT', gen: 1 });
    // The boot url is the seed, so the very first swap releases it too —
    // without that seed every document leaks exactly one object URL.
    expect(h.revoked).toEqual(['blob:boot']);
    expect(h.minted).toEqual(['blob:u1']);
    expect(h.setAttrCalls).toEqual([['shader', 'src', 'blob:u1']]);
  });

  it('drops the outgoing uniform map so nothing reads the superseded shader in the gap', () => {
    const h = makeHarness(html);
    h.send({ type: SHADER_SWAP_MESSAGE, code: 'NEXT', gen: 1 });
    expect(h.shaderComp._propertyUniforms).toBeNull();
  });

  it('revokes exactly one url per swap — no leak per keystroke', () => {
    const h = makeHarness(html);
    for (let i = 1; i <= 5; i++) h.send({ type: SHADER_SWAP_MESSAGE, code: `C${i}`, gen: i });
    expect(h.minted).toHaveLength(5);
    // Every url except the live one has been released.
    expect(h.revoked).toEqual(['blob:boot', 'blob:u1', 'blob:u2', 'blob:u3', 'blob:u4']);
  });

  it('ignores a message that is not ours, is malformed, or is not from the parent', () => {
    const h = makeHarness(html);
    h.send({ type: 'fs:bg-color', color: '#fff' });
    h.send({ type: SHADER_SWAP_MESSAGE, code: 42, gen: 1 });
    h.send(null);
    h.send({ type: SHADER_SWAP_MESSAGE, code: 'NEXT', gen: 1 }, { postMessage() {} });
    expect(h.setAttrCalls).toEqual([]);
    expect(h.minted).toEqual([]);
  });
});

describe('preview shader hot-swap: the acknowledgement', () => {
  it('answers a successful apply with a gen-tagged ready carrying the NEW uniform names', () => {
    const h = makeHarness(html);
    h.send({ type: SHADER_SWAP_MESSAGE, code: 'NEXT', gen: 7 });
    h.shaderComp._propertyUniforms = { speed: 1, tint: '#fff' };
    h.emit('shader-applied');
    expect(h.posted).toEqual([
      { type: 'fs:preview-ready', hot: 7, uniforms: ['speed', 'tint'] },
    ]);
  });

  it('answers a failed apply with a gen-tagged error', () => {
    const h = makeHarness(html);
    h.send({ type: SHADER_SWAP_MESSAGE, code: 'NEXT', gen: 3 });
    h.emit('shader-error', { message: 'boom' });
    expect(h.posted).toEqual([{ type: 'fs:preview-error', hot: 3, message: 'boom' }]);
  });

  it('acks once per swap, whichever event fires first', () => {
    const h = makeHarness(html);
    h.send({ type: SHADER_SWAP_MESSAGE, code: 'NEXT', gen: 1 });
    h.emit('shader-applied');
    h.emit('shader-applied');
    h.emit('shader-error', { message: 'late' });
    expect(h.posted).toHaveLength(1);
  });

  it('never lets a superseded swap answer for the one in flight', () => {
    // The parent's watchdog trusts the gen, so a late ack from swap 1 must not
    // clear the wait on swap 2 — that would hand a lost swap another six
    // seconds of the previous picture.
    const h = makeHarness(html);
    h.send({ type: SHADER_SWAP_MESSAGE, code: 'A', gen: 1 });
    h.send({ type: SHADER_SWAP_MESSAGE, code: 'B', gen: 2 });
    // Swap A's listeners are still attached (it never settled), so the event
    // reaches both — only the current generation may answer. Uniforms read
    // empty because swap B nulled the map and no apply has rebuilt it.
    h.emit('shader-applied');
    expect(h.posted).toEqual([{ type: 'fs:preview-ready', hot: 2, uniforms: [] }]);
  });

  it('acks bytes the document is already running instead of re-applying them', () => {
    // React StrictMode double-fires mount effects, and an effect always runs
    // once with the value already baked into the HTML. Re-applying would cost
    // a redundant shader compile; NOT acking would make the parent's watchdog
    // rebuild the document over a no-op.
    const h = makeHarness(html);
    h.send({ type: SHADER_SWAP_MESSAGE, code: 'BOOT_MODULE', gen: 1 });
    expect(h.setAttrCalls).toEqual([]);
    expect(h.minted).toEqual([]);
    expect(h.posted).toEqual([{ type: 'fs:preview-ready', hot: 1, uniforms: [] }]);
  });
});

describe('preview shader hot-swap: arriving before the scene exists', () => {
  it('holds the payload until the scene boots, then applies the LATEST', () => {
    // The WebGPU pre-flight injects the <a-scene> asynchronously (up to a 2 s
    // adapter timeout), so a swap can land before there is an entity — the
    // model feed holds its payload for exactly the same reason.
    const h = makeHarness(html, { booted: false });
    h.send({ type: SHADER_SWAP_MESSAGE, code: 'A', gen: 1 });
    h.send({ type: SHADER_SWAP_MESSAGE, code: 'B', gen: 2 });
    expect(h.setAttrCalls).toEqual([]);
    h.bootScene();
    expect(h.setAttrCalls).toEqual([['shader', 'src', 'blob:u1']]);
    h.emit('shader-applied');
    expect(h.posted).toEqual([{ type: 'fs:preview-ready', hot: 2, uniforms: [] }]);
  });

  it('resumes normal per-message application once booted', () => {
    const h = makeHarness(html, { booted: false });
    h.send({ type: SHADER_SWAP_MESSAGE, code: 'A', gen: 1 });
    h.bootScene();
    h.send({ type: SHADER_SWAP_MESSAGE, code: 'B', gen: 2 });
    expect(h.setAttrCalls).toEqual([
      ['shader', 'src', 'blob:u1'],
      ['shader', 'src', 'blob:u2'],
    ]);
  });
});
