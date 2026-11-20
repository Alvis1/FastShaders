/**
 * The Tauri transport's half of the channel protocol (src-tauri/src/llm.rs's
 * header): DATA frames in order, completion on the ONE END frame — never on
 * the invoke promise — a rejection as the other final state, and cancel sent
 * exactly once. Driven through a fake `LlmDesktopBridge`; the Rust half has its
 * own fake-server tests, and the real pairing needs a desktop build.
 */
import { describe, it, expect } from 'vitest';
import { LLM_FRAME_DATA, LLM_FRAME_END, LLM_MAX_REQUEST_BYTES } from '@/utils/desktopIpc';
import type { DesktopChannel } from '@/utils/tauriBridge';
import {
  ENGINE_BASE,
  RUST_TRANSPORT_CODES,
  engineTransport,
  failureFromStatus,
  nextRequestId,
  tauriLlmBridge,
  tauriTransport,
  type LlmDesktopBridge,
} from './tauriTransport';
import type { TransportResult } from './types';

const BASE = 'http://127.0.0.1:1234';
const enc = new TextEncoder();

const frame = (tag: number, text = ''): ArrayBuffer => {
  const bytes = enc.encode(text);
  const out = new Uint8Array(bytes.length + 1);
  out[0] = tag;
  out.set(bytes, 1);
  return out.buffer;
};
const data = (text: string) => frame(LLM_FRAME_DATA, text);
const end = (status = '') => frame(LLM_FRAME_END, status);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

class FakeBridge implements LlmDesktopBridge {
  isAvailable = true;
  giveChannel = true;
  channels: DesktopChannel[] = [];
  calls: Array<{ cmd: 'models' | 'chat' | 'cancel'; args: Record<string, unknown> }> = [];
  chatReply = deferred<unknown>();
  modelsReply = deferred<unknown>();

  available() {
    return this.isAvailable;
  }
  channel(onMessage: (message: unknown) => void): DesktopChannel | null {
    if (!this.giveChannel) return null;
    const ch: DesktopChannel = { id: this.channels.length, onmessage: onMessage };
    this.channels.push(ch);
    return ch;
  }
  models(args: { base: string; path: string; requestId: number }) {
    this.calls.push({ cmd: 'models', args });
    return this.modelsReply.promise;
  }
  chat(args: { base: string; path: string; body: string; requestId: number; onEvent: DesktopChannel }) {
    this.calls.push({ cmd: 'chat', args });
    return this.chatReply.promise;
  }
  cancel(args: { requestId: number }) {
    this.calls.push({ cmd: 'cancel', args });
    return Promise.resolve();
  }
  /** Rust sending a frame. */
  send(message: unknown) {
    const ch = this.channels[this.channels.length - 1];
    ch.onmessage(message);
  }
  count(cmd: 'models' | 'chat' | 'cancel') {
    return this.calls.filter((c) => c.cmd === cmd).length;
  }
}

/** Start a post and watch whether it has settled. */
function startPost(bridge: FakeBridge, signal = new AbortController().signal, body = '{}') {
  const chunks: string[] = [];
  let settled: TransportResult<void> | undefined;
  const pending = tauriTransport(bridge)
    .post(BASE, '/v1/chat/completions', body, (bytes) => chunks.push(new TextDecoder().decode(bytes)), signal)
    .then((r) => {
      settled = r;
      return r;
    });
  return { chunks, pending, settled: () => settled };
}

describe('tauriTransport.post', () => {
  it('hands DATA frames over in order and completes on END, not on the invoke promise', async () => {
    const bridge = new FakeBridge();
    const run = startPost(bridge);
    expect(bridge.count('chat')).toBe(1);
    const args = bridge.calls[0].args;
    expect(args).toMatchObject({ base: BASE, path: '/v1/chat/completions', body: '{}' });
    expect(args.onEvent).toBe(bridge.channels[0]);

    // The command resolves FIRST — a fetched (≥ 1 KiB) frame can land after it.
    bridge.chatReply.resolve(undefined);
    await tick();
    expect(run.settled()).toBeUndefined();

    bridge.send(data('data: {"a":1}\n\n'));
    bridge.send(data('data: {"a":2}\n\n'));
    await tick();
    expect(run.settled()).toBeUndefined();
    bridge.send(end());
    expect(await run.pending).toEqual({ ok: true, value: undefined });
    expect(run.chunks).toEqual(['data: {"a":1}\n\n', 'data: {"a":2}\n\n']);
  });

  it('decodes the number arrays of Tauri’s postMessage fallback the same way', async () => {
    const bridge = new FakeBridge();
    const run = startPost(bridge);
    bridge.send(Array.from(new Uint8Array(data('hi'))));
    bridge.send(Array.from(new Uint8Array(end())));
    expect(await run.pending).toEqual({ ok: true, value: undefined });
    expect(run.chunks).toEqual(['hi']);
  });

  it('maps an END status to its failure, the detail being what Rust wrote after the code', async () => {
    const cases: Array<[string, { code: string; detail: string }]> = [
      ['E_HTTP 404: {"error": "model not found"}', { code: 'HTTP', detail: '404: {"error": "model not found"}' }],
      ['E_HTTP 500:', { code: 'HTTP', detail: '500:' }],
      ['E_TOO_LARGE 8388609 8388608', { code: 'TOO_LARGE', detail: '8388609 8388608' }],
      ['E_TIMEOUT nothing arrived within 300 s', { code: 'TIMEOUT', detail: 'nothing arrived within 300 s' }],
      ['E_UNREACHABLE 127.0.0.1:1234: connection refused', { code: 'UNREACHABLE', detail: '127.0.0.1:1234: connection refused' }],
      ['E_BUSY', { code: 'BUSY', detail: '' }],
      ['E_CANCELLED', { code: 'CANCELLED', detail: '' }],
      ['E_BAD_RESPONSE the connection closed inside a chunk', { code: 'BAD_RESPONSE', detail: 'the connection closed inside a chunk' }],
      // Not a status Rust answers with: shown as data, never trusted as a code.
      ['E_FORBIDDEN', { code: 'BAD_RESPONSE', detail: 'E_FORBIDDEN' }],
      ['E_NOT_DESKTOP', { code: 'BAD_RESPONSE', detail: 'E_NOT_DESKTOP' }],
      ['something else', { code: 'BAD_RESPONSE', detail: 'something else' }],
    ];
    for (const [status, want] of cases) {
      const bridge = new FakeBridge();
      const run = startPost(bridge);
      bridge.send(end(status));
      expect(await run.pending, status).toEqual({ ok: false, ...want });
    }
  });

  it('treats a rejected command as final (no frame was sent)', async () => {
    const bridge = new FakeBridge();
    const run = startPost(bridge);
    bridge.chatReply.reject('invalid args `requestId` for command `llm_local_chat`');
    expect(await run.pending).toEqual({
      ok: false,
      code: 'BAD_RESPONSE',
      detail: 'invalid args `requestId` for command `llm_local_chat`',
    });
    // A frame that somehow follows is ignored.
    bridge.send(data('late'));
    expect(run.chunks).toEqual([]);
  });

  it('cancels once, with the request’s own id, and resolves CANCELLED at once', async () => {
    const bridge = new FakeBridge();
    const controller = new AbortController();
    const run = startPost(bridge, controller.signal);
    bridge.send(data('first'));
    controller.abort();
    expect(await run.pending).toEqual({ ok: false, code: 'CANCELLED', detail: '' });
    expect(bridge.count('cancel')).toBe(1);
    expect(bridge.calls.find((c) => c.cmd === 'cancel')!.args).toEqual({
      requestId: bridge.calls[0].args.requestId,
    });
    // Rust's remaining frames — the rest of the batch, then END — change nothing.
    bridge.send(data('second'));
    bridge.send(end('E_CANCELLED'));
    bridge.chatReply.resolve(undefined);
    controller.abort();
    await tick();
    expect(run.chunks).toEqual(['first']);
    expect(bridge.count('cancel')).toBe(1);
  });

  it('sends nothing for a signal that is already aborted', async () => {
    const bridge = new FakeBridge();
    const controller = new AbortController();
    controller.abort();
    expect(await startPost(bridge, controller.signal).pending).toEqual({ ok: false, code: 'CANCELLED', detail: '' });
    expect(bridge.calls).toEqual([]);
  });

  it('sends no cancel once the request has ended', async () => {
    const bridge = new FakeBridge();
    const controller = new AbortController();
    const run = startPost(bridge, controller.signal);
    bridge.send(end());
    await run.pending;
    controller.abort();
    await tick();
    expect(bridge.count('cancel')).toBe(0);
  });

  it('abandons a stream it cannot read — and stops Rust too', async () => {
    for (const bad of [frame(0, 'x'), frame(9, 'x'), new ArrayBuffer(0), 'a string', { message: 1 }]) {
      const bridge = new FakeBridge();
      const run = startPost(bridge);
      bridge.send(bad);
      const result = await run.pending;
      expect(result.ok, String(bad)).toBe(false);
      expect(!result.ok && result.code).toBe('BAD_RESPONSE');
      expect(bridge.count('cancel')).toBe(1);
    }
  });

  it('abandons the request when the caller’s reader throws', async () => {
    const bridge = new FakeBridge();
    const pending = tauriTransport(bridge).post(
      BASE,
      '/api/chat',
      '{}',
      () => {
        throw new Error('parser bug');
      },
      new AbortController().signal,
    );
    bridge.send(data('x'));
    expect(await pending).toEqual({ ok: false, code: 'BAD_RESPONSE', detail: 'the stream reader failed: parser bug' });
    expect(bridge.count('cancel')).toBe(1);
  });

  it('skips an empty DATA frame', async () => {
    const bridge = new FakeBridge();
    const run = startPost(bridge);
    bridge.send(data(''));
    bridge.send(end());
    await run.pending;
    expect(run.chunks).toEqual([]);
  });

  it('refuses what Rust would refuse without invoking anything', async () => {
    const bridge = new FakeBridge();
    const t = tauriTransport(bridge);
    const signal = new AbortController().signal;
    const noop = () => {};
    expect(await t.post('http://127.1:1234', '/api/chat', '{}', noop, signal)).toMatchObject({ code: 'BAD_URL' });
    expect(await t.post(BASE, '/v1/models' as '/api/chat', '{}', noop, signal)).toMatchObject({ code: 'BAD_ROUTE' });
    expect(await t.post(BASE, '/api/chat', 'x'.repeat(LLM_MAX_REQUEST_BYTES + 1), noop, signal)).toEqual({
      ok: false,
      code: 'TOO_LARGE',
      detail: `${LLM_MAX_REQUEST_BYTES + 1} ${LLM_MAX_REQUEST_BYTES}`,
    });
    expect(bridge.calls).toEqual([]);
  });

  it('is NOT_DESKTOP outside the desktop app', async () => {
    const bridge = new FakeBridge();
    bridge.isAvailable = false;
    expect(await startPost(bridge).pending).toEqual({ ok: false, code: 'NOT_DESKTOP', detail: '' });
    const noChannel = new FakeBridge();
    noChannel.giveChannel = false;
    expect(await startPost(noChannel).pending).toEqual({ ok: false, code: 'NOT_DESKTOP', detail: '' });
    expect(noChannel.count('chat')).toBe(0);
  });
});

describe('tauriTransport.get', () => {
  it('decodes the raw body as UTF-8 text', async () => {
    const bridge = new FakeBridge();
    const pending = tauriTransport(bridge).get(BASE, '/api/v1/models', new AbortController().signal);
    expect(bridge.calls[0]).toMatchObject({ cmd: 'models', args: { base: BASE, path: '/api/v1/models' } });
    bridge.modelsReply.resolve(enc.encode('{"data":[{"id":"zīle"}]}').buffer);
    expect(await pending).toEqual({ ok: true, value: '{"data":[{"id":"zīle"}]}' });
  });

  it('maps a rejection', async () => {
    const bridge = new FakeBridge();
    const pending = tauriTransport(bridge).get(BASE, '/v1/models', new AbortController().signal);
    bridge.modelsReply.reject('E_HTTP 404: Not Found');
    expect(await pending).toEqual({ ok: false, code: 'HTTP', detail: '404: Not Found' });
  });

  it('cancels on abort and ignores the late answer', async () => {
    const bridge = new FakeBridge();
    const controller = new AbortController();
    const pending = tauriTransport(bridge).get(BASE, '/api/tags', controller.signal);
    controller.abort();
    expect(await pending).toEqual({ ok: false, code: 'CANCELLED', detail: '' });
    bridge.modelsReply.resolve(enc.encode('{}').buffer);
    await tick();
    expect(bridge.count('cancel')).toBe(1);
  });

  it('refuses a POST route and a non-loopback base', async () => {
    const bridge = new FakeBridge();
    const signal = new AbortController().signal;
    expect(await tauriTransport(bridge).get(BASE, '/api/chat' as '/api/tags', signal)).toMatchObject({ code: 'BAD_ROUTE' });
    expect(await tauriTransport(bridge).get('http://192.168.1.2:1234', '/api/tags', signal)).toMatchObject({
      code: 'BAD_URL',
    });
    expect(bridge.calls).toEqual([]);
  });
});

describe('the pieces', () => {
  it('request ids are unique, increasing and safe integers', () => {
    const a = nextRequestId();
    const b = nextRequestId();
    expect(b).toBeGreaterThan(a);
    expect(Number.isSafeInteger(b)).toBe(true);
    // Time-based: a reloaded page cannot start again from 1.
    expect(a).toBeGreaterThanOrEqual(Date.now() * 1000 - 60_000_000);
  });

  it('Rust can answer every code but NOT_DESKTOP', () => {
    expect([...RUST_TRANSPORT_CODES].sort()).toEqual(
      ['BAD_RESPONSE', 'BAD_ROUTE', 'BAD_URL', 'BUSY', 'CANCELLED', 'HTTP', 'TIMEOUT', 'TOO_LARGE', 'UNREACHABLE'],
    );
  });

  it('failureFromStatus never lets a long foreign text through whole', () => {
    expect(failureFromStatus('x'.repeat(1000)).detail.length).toBe(300);
  });

  it('the real bridge is unavailable under node (no window)', () => {
    expect(tauriLlmBridge.available()).toBe(false);
    expect(tauriLlmBridge.channel(() => {})).toBeNull();
  });
});

describe('the bundled engine’s transport', () => {
  it('is the same channel protocol, with a base that only has to pass the loopback check', async () => {
    const bridge = new FakeBridge();
    const got: string[] = [];
    const sent = engineTransport(bridge).post(
      ENGINE_BASE,
      '/v1/chat/completions',
      '{"model":"fastshaders"}',
      (chunk) => got.push(new TextDecoder().decode(chunk)),
      new AbortController().signal,
    );
    await tick();
    expect(bridge.calls.map((c) => c.cmd)).toEqual(['chat']);
    const ch = bridge.channels[0];
    ch.onmessage(data('hello'));
    ch.onmessage(end());
    expect(await sent).toEqual({ ok: true, value: undefined });
    expect(got).toEqual(['hello']);
  });

  it('the real bridge sends the chat no address and no path, and has no model list', async () => {
    const { tauriEngineChatBridge } = await import('./tauriTransport');
    const src = (await import('node:fs')).readFileSync('src/llm/transport/tauriTransport.ts', 'utf8');
    expect(src).toMatch(/chat: \(\{ body, requestId, onEvent \}\) => invokeDesktop\(LLM_ENGINE_CHAT, \{ body, requestId, onEvent \}\),/);
    await expect(tauriEngineChatBridge.models({ base: ENGINE_BASE, path: '/v1/models', requestId: 1 })).rejects.toThrow();
  });

  it('a start that failed in Rust arrives as a failure value, never a throw', async () => {
    const bridge = new FakeBridge();
    const sent = engineTransport(bridge).post(ENGINE_BASE, '/v1/chat/completions', '{}', () => {}, new AbortController().signal);
    await tick();
    bridge.channels[0].onmessage(end('E_UNREACHABLE the model is not downloaded'));
    expect(await sent).toEqual({ ok: false, code: 'UNREACHABLE', detail: 'the model is not downloaded' });
  });
});
