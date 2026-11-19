/**
 * The fetch transport answers like the Rust bridge: the same codes, details,
 * caps and timers (src-tauri/src/llm.rs has the twin of each case below as a
 * cargo test). Real `node:http` servers on their own 127.0.0.1:0 listeners
 * drive the real `fetch`; the error mapping that needs a failure node cannot
 * stage is driven through an injected `fetch`. No global is stubbed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LLM_MAX_MODEL_LIST_BYTES, LLM_MAX_REQUEST_BYTES, LLM_MAX_STREAM_BYTES } from '@/utils/desktopIpc';
import { excerptText, fetchTransport, type TransportTimeouts } from './fetchTransport';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
  closed: Promise<void>;
}

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

/** A local server whose handler runs once the request body has arrived. */
async function serve(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ base: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => {
      const closed = new Promise<void>((r) => res.on('close', () => r()));
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, closed });
      handler(req, res);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, seen };
}

const quick: TransportTimeouts = { firstByteMs: 2_000, betweenChunksMs: 2_000, totalMs: 10_000 };
const signal = () => new AbortController().signal;
const decode = (chunks: Uint8Array[]) => new TextDecoder().decode(Buffer.concat(chunks));

describe('fetchTransport.post', () => {
  it('streams the body chunk by chunk and resolves after the last', async () => {
    const { base, seen } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"n":1}\n\n');
      setTimeout(() => res.write('data: {"n":2}\n\n'), 30);
      setTimeout(() => res.end('data: [DONE]\n\n'), 60);
    });
    const chunks: Uint8Array[] = [];
    const result = await fetchTransport({ chatTimeouts: quick }).post(
      base,
      '/v1/chat/completions',
      '{"stream":true}',
      (b) => chunks.push(b),
      signal(),
    );
    expect(result).toEqual({ ok: true, value: undefined });
    expect(decode(chunks)).toBe('data: {"n":1}\n\ndata: {"n":2}\n\ndata: [DONE]\n\n');
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/chat/completions', body: '{"stream":true}' });
  });

  it('sends no origin, asks for an identity body and closes', async () => {
    const { base, seen } = await serve((_req, res) => res.end('{}'));
    await fetchTransport().post(base, '/api/chat', '{"x":1}', () => {}, signal());
    const h = seen[0].headers;
    expect(h.origin).toBeUndefined();
    expect(h.host).toBe(base.slice('http://'.length));
    expect(h['content-type']).toBe('application/json');
    expect(h['content-length']).toBe('7');
    expect(h['accept-encoding']).toBe('identity');
    expect(h.connection).toBe('close');
    expect(h.expect).toBeUndefined();
  });

  it('turns a 404 into HTTP with the excerpt Rust would show', async () => {
    const { base } = await serve((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":\n\t"model\u0007 not\r\nfound‮"}');
    });
    const chunks: Uint8Array[] = [];
    const result = await fetchTransport().post(base, '/v1/chat/completions', '{}', (b) => chunks.push(b), signal());
    expect(result).toEqual({ ok: false, code: 'HTTP', detail: '404: {"error": "model not found"}' });
    expect(chunks).toEqual([]);
  });

  it('lets an error status outrank a timer', async () => {
    const { base } = await serve((_req, res) => {
      res.writeHead(500);
      res.write('boom');
      setTimeout(() => res.end(), 400);
    });
    const t = { ...quick, firstByteMs: 150 };
    expect(await fetchTransport({ chatTimeouts: t }).post(base, '/api/chat', '{}', () => {}, signal())).toEqual({
      ok: false,
      code: 'HTTP',
      detail: '500: boom',
    });
  });

  it('refuses a redirect instead of following it', async () => {
    const { base, seen } = await serve((req, res) => {
      if (req.url === '/v1/chat/completions') {
        res.writeHead(302, { location: '/api/chat' });
        res.end();
      } else res.end('followed');
    });
    expect(await fetchTransport().post(base, '/v1/chat/completions', '{}', () => {}, signal())).toEqual({
      ok: false,
      code: 'HTTP',
      detail: '302: redirect refused',
    });
    expect(seen.map((s) => s.url)).toEqual(['/v1/chat/completions']);
  });

  it('refuses a declared body over the stream cap before reading it', async () => {
    const { base } = await serve((_req, res) => {
      res.writeHead(200, { 'content-length': String(LLM_MAX_STREAM_BYTES + 1) });
      res.write('x');
    });
    expect(await fetchTransport().post(base, '/api/chat', '{}', () => {}, signal())).toEqual({
      ok: false,
      code: 'TOO_LARGE',
      detail: `${LLM_MAX_STREAM_BYTES + 1} ${LLM_MAX_STREAM_BYTES}`,
    });
  });

  it('refuses a compressed answer', async () => {
    const { base } = await serve((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
    });
    expect(await fetchTransport().post(base, '/api/chat', '{}', () => {}, signal())).toEqual({
      ok: false,
      code: 'BAD_RESPONSE',
      detail: 'compressed response (content-encoding gzip)',
    });
  });

  it('times out on the first BODY byte, even after a 200 head', async () => {
    for (const sendHead of [false, true]) {
      const { base } = await serve((_req, res) => {
        if (sendHead) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.flushHeaders();
        }
      });
      const t = { ...quick, firstByteMs: 200, betweenChunksMs: 50 };
      expect(await fetchTransport({ chatTimeouts: t }).post(base, '/api/chat', '{}', () => {}, signal())).toEqual({
        ok: false,
        code: 'TIMEOUT',
        detail: 'nothing arrived within 200 ms',
      });
    }
  });

  it('times out when the stream stalls, after delivering what came', async () => {
    const { base, seen } = await serve((_req, res) => {
      res.writeHead(200);
      res.write('data: 1\n\n');
    });
    const chunks: Uint8Array[] = [];
    const t = { ...quick, betweenChunksMs: 200 };
    expect(await fetchTransport({ chatTimeouts: t }).post(base, '/api/chat', '{}', (b) => chunks.push(b), signal())).toEqual({
      ok: false,
      code: 'TIMEOUT',
      detail: 'the stream stalled for 200 ms',
    });
    expect(decode(chunks)).toBe('data: 1\n\n');
    await seen[0].closed;
  });

  it('cancels mid-stream: CANCELLED at once, and the server sees the disconnect', async () => {
    const { base, seen } = await serve((_req, res) => {
      res.writeHead(200);
      res.write('data: first\n\n');
    });
    const controller = new AbortController();
    const chunks: Uint8Array[] = [];
    const result = await fetchTransport().post(
      base,
      '/v1/chat/completions',
      '{}',
      (b) => {
        chunks.push(b);
        controller.abort();
      },
      controller.signal,
    );
    expect(result).toEqual({ ok: false, code: 'CANCELLED', detail: '' });
    expect(decode(chunks)).toBe('data: first\n\n');
    await seen[0].closed; // resolves only once the client has gone
  });

  it('runs one request at a time', async () => {
    const { base } = await serve((req, res) => {
      res.writeHead(200);
      if (req.url === '/v1/models') res.end('{"data":[]}');
      else res.write('data: 1\n\n');
    });
    const transport = fetchTransport();
    const controller = new AbortController();
    let first!: () => void;
    const started = new Promise<void>((r) => (first = r));
    const long = transport.post(base, '/api/chat', '{}', () => first(), controller.signal);
    await started;
    expect(await transport.get(base, '/v1/models', signal())).toEqual({ ok: false, code: 'BUSY', detail: '' });
    controller.abort();
    expect(await long).toMatchObject({ code: 'CANCELLED' });
    expect(await transport.get(base, '/v1/models', signal())).toEqual({ ok: true, value: '{"data":[]}' });
  });

  it('refuses what Rust would refuse without fetching', async () => {
    const calls: string[] = [];
    const transport = fetchTransport({
      fetch: async (url) => {
        calls.push(url);
        return new Response('{}');
      },
    });
    const noop = () => {};
    expect(await transport.post('http://localhost.:1234', '/api/chat', '{}', noop, signal())).toMatchObject({ code: 'BAD_URL' });
    expect(await transport.post('http://127.0.0.1:1234', '/api/tags' as '/api/chat', '{}', noop, signal())).toMatchObject({
      code: 'BAD_ROUTE',
    });
    expect(
      await transport.post('http://127.0.0.1:1234', '/api/chat', 'x'.repeat(LLM_MAX_REQUEST_BYTES + 1), noop, signal()),
    ).toEqual({ ok: false, code: 'TOO_LARGE', detail: `${LLM_MAX_REQUEST_BYTES + 1} ${LLM_MAX_REQUEST_BYTES}` });
    const aborted = new AbortController();
    aborted.abort();
    expect(await transport.post('http://127.0.0.1:1234', '/api/chat', '{}', noop, aborted.signal)).toMatchObject({
      code: 'CANCELLED',
    });
    expect(calls).toEqual([]);
  });

  it('settles a cancel even when the fetch never notices the abort', async () => {
    const transport = fetchTransport({ fetch: () => new Promise<Response>(() => {}) });
    const controller = new AbortController();
    const pending = transport.post('http://127.0.0.1:1234', '/api/chat', '{}', () => {}, controller.signal);
    controller.abort();
    expect(await pending).toEqual({ ok: false, code: 'CANCELLED', detail: '' });
  });
});

describe('fetchTransport.get', () => {
  it('returns the body text', async () => {
    const { base, seen } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"data":[{"id":"zīle"}]}');
    });
    expect(await fetchTransport().get(base, '/api/v1/models', signal())).toEqual({
      ok: true,
      value: '{"data":[{"id":"zīle"}]}',
    });
    expect(seen[0].method).toBe('GET');
    expect(seen[0].headers['content-type']).toBeUndefined();
  });

  it('refuses a model list over its cap as it streams', async () => {
    const { base } = await serve((_req, res) => {
      res.writeHead(200);
      const piece = Buffer.alloc(64 * 1024, 0x78);
      for (let i = 0; i < 17; i++) res.write(piece);
      res.end();
    });
    const result = await fetchTransport().get(base, '/v1/models', signal());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TOO_LARGE');
    const [n, limit] = result.detail.split(' ').map(Number);
    expect(limit).toBe(LLM_MAX_MODEL_LIST_BYTES);
    expect(n).toBeGreaterThan(limit);
  });

  it('is UNREACHABLE when nothing listens', async () => {
    const { base } = await serve(() => {});
    const server = servers.pop()!;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    const result = await fetchTransport().get(base, '/v1/models', signal());
    expect(result).toMatchObject({ ok: false, code: 'UNREACHABLE' });
  });
});

describe('fetch failures map like Rust’s socket errors', () => {
  const failing = (cause: unknown) =>
    fetchTransport({
      fetch: async () => {
        throw Object.assign(new TypeError('fetch failed'), { cause });
      },
    });

  it('connect errors are UNREACHABLE, anything later is BAD_RESPONSE', async () => {
    const base = 'http://127.0.0.1:1234';
    expect(await failing({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:1234' }).get(base, '/v1/models', signal())).toEqual({
      ok: false,
      code: 'UNREACHABLE',
      detail: 'connect ECONNREFUSED 127.0.0.1:1234',
    });
    expect(await failing({ code: 'UND_ERR_SOCKET', message: 'other side closed' }).get(base, '/v1/models', signal())).toEqual({
      ok: false,
      code: 'BAD_RESPONSE',
      detail: 'other side closed',
    });
    // A browser's bare "Failed to fetch" has no cause.
    expect(await failing(undefined).get(base, '/v1/models', signal())).toEqual({
      ok: false,
      code: 'UNREACHABLE',
      detail: 'fetch failed',
    });
  });
});

describe('excerptText (llm.rs excerpt_text)', () => {
  it('cleans like Rust', () => {
    expect(excerptText('{"error":\n\t"model\u0007 not\r\nfound"}\n')).toBe('{"error": "model not found"}');
    expect(excerptText('a‮b​c d\u0085e')).toBe('abc d e');
    expect(excerptText('  \u001b[31mred\u001b[0m ')).toBe('[31mred [0m');
    expect(Array.from(excerptText('ā'.repeat(400))).length).toBe(300);
    expect(excerptText('��ok')).toBe('��ok');
  });
});
