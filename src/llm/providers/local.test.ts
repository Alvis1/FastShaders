import { describe, expect, it } from 'vitest';
import type { LocalGetRoute, LocalTransport, TransportResult } from '../transport/types';
import { checkLocalServer, localProvider } from './local';

const enc = (s: string) => new TextEncoder().encode(s);
const sse = (...events: object[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
const delta = (content: string, finish: string | null = null) => ({ choices: [{ delta: { content }, finish_reason: finish }] });

/** A transport that answers from a script; the stream is cut every `chunk` bytes. */
function fake(opts: {
  get?: Partial<Record<LocalGetRoute, TransportResult<string>>>;
  stream?: string;
  post?: TransportResult<void>;
  chunk?: number;
  onPost?: (body: string) => void;
}): LocalTransport {
  return {
    async get(_base, path) {
      return opts.get?.[path] ?? { ok: false, code: 'HTTP', detail: '404: not found' };
    },
    async post(_base, _path, body, onBytes, signal) {
      opts.onPost?.(body);
      if (opts.post && !opts.post.ok) return opts.post;
      const b = enc(opts.stream ?? '');
      const n = opts.chunk ?? 7;
      for (let i = 0; i < b.length; i += n) {
        if (signal.aborted) return { ok: false, code: 'CANCELLED', detail: '' };
        onBytes(b.slice(i, i + n));
      }
      return { ok: true, value: undefined };
    },
  };
}

const req = (signal = new AbortController().signal) => ({ system: 'S', user: 'U', maxOutputTokens: 3000, signal });

describe('localProvider', () => {
  it('streams a reply, reports progress, and returns the text with usage', async () => {
    const phases: string[] = [];
    const p = localProvider(fake({ stream: sse(delta('Plan.\n```js\n'), delta('return x;\n```', 'stop'), { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }) }), 'http://127.0.0.1:1234', 'm');
    const r = await p.generate({ ...req(), onProgress: (x) => phases.push(x.phase) });
    expect(r).toEqual({ ok: true, text: 'Plan.\n```js\nreturn x;\n```', usage: { inputTokens: 10, outputTokens: 5 }, fromReasoning: false });
    expect(phases.slice(0, 2)).toEqual(['connecting', 'loading']);
    expect(phases).toContain('writing');
  });

  it('sends the model and the prompt', async () => {
    let sent = '';
    await localProvider(fake({ stream: sse(delta('x', 'stop')), onPost: (b) => { sent = b; } }), 'http://127.0.0.1:1234', 'qwen/q').generate(req());
    expect(JSON.parse(sent)).toMatchObject({ model: 'qwen/q', messages: [{ content: 'S' }, { content: 'U' }] });
  });

  it('classifies a refused connection, an HTTP error, a stream error and a cancel', async () => {
    const base = 'http://127.0.0.1:1234';
    expect(await localProvider(fake({ post: { ok: false, code: 'UNREACHABLE', detail: 'refused' } }), base, 'm').generate(req()))
      .toMatchObject({ ok: false, failure: 'not-running' });
    expect(await localProvider(fake({ post: { ok: false, code: 'HTTP', detail: '400: {"error":"context length of 8192 exceeded"}' } }), base, 'm').generate(req()))
      .toMatchObject({ ok: false, failure: 'context-too-small' });
    expect(await localProvider(fake({ stream: 'data: {"error":{"message":"No models loaded"}}\n\n' }), base, 'm').generate(req()))
      .toMatchObject({ ok: false, failure: 'no-model' });
    const ac = new AbortController();
    ac.abort();
    expect(await localProvider(fake({ stream: sse(delta('x')) }), base, 'm').generate(req(ac.signal)))
      .toMatchObject({ ok: false, failure: 'cancelled' });
  });

  it('a reply cut off before its program closes is truncated; an empty one is bad', async () => {
    const base = 'http://127.0.0.1:1234';
    expect(await localProvider(fake({ stream: sse(delta('```js\nconst a = 1;', 'length')) }), base, 'm').generate(req()))
      .toMatchObject({ ok: false, failure: 'truncated' });
    expect(await localProvider(fake({ stream: sse(delta('```js\nreturn a;\n```\nmore', 'length')) }), base, 'm').generate(req()))
      .toMatchObject({ ok: true });
    expect(await localProvider(fake({ stream: sse(delta('', 'stop')) }), base, 'm').generate(req()))
      .toMatchObject({ ok: false, failure: 'bad-response' });
  });
});

describe('checkLocalServer', () => {
  const signal = new AbortController().signal;
  const base = 'http://127.0.0.1:1234';

  it('prefers LM Studio\'s native list, which knows what is loaded', async () => {
    const r = await checkLocalServer(fake({ get: { '/api/v1/models': { ok: true, value: '{"models":[{"type":"llm","key":"a","loaded_instances":[{"config":{"context_length":8192}}]}]}' } } }), base, signal);
    expect(r).toEqual({ ok: true, models: [{ id: 'a', loaded: true, contextLength: 8192 }], knowsLoaded: true });
  });

  it('falls back to the OpenAI list on another server', async () => {
    const r = await checkLocalServer(fake({ get: { '/v1/models': { ok: true, value: '{"data":[{"id":"b"}]}' } } }), base, signal);
    expect(r).toEqual({ ok: true, models: [{ id: 'b' }], knowsLoaded: false });
  });

  it('says plainly when nothing runs, nothing is loaded, or the port is wrong', async () => {
    expect(await checkLocalServer(fake({ get: { '/api/v1/models': { ok: false, code: 'UNREACHABLE', detail: '' } } }), base, signal))
      .toMatchObject({ ok: false, failure: 'not-running' });
    expect(await checkLocalServer(fake({ get: { '/v1/models': { ok: true, value: '{"data":[]}' } } }), base, signal))
      .toMatchObject({ ok: false, failure: 'no-model' });
    expect(await checkLocalServer(fake({}), base, signal)).toEqual({ ok: false, failure: 'wrong-server' });
  });
});
