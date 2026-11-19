/**
 * The Claude provider through the SDK's injectable `fetch` (ClientOptions.fetch
 * — no global stub): the request it sends, the stop reasons it checks before
 * reading text, and the error classes it tells apart.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { clearCloudKey, setCloudKey } from '../cloudKey';
import { CLAUDE_MAX_TOKENS, claudeProvider } from './claude';

const KEY = 'sk-ant-api03-test-0123456789abcdef';

interface Seen { url: string; headers: Record<string, string>; body: Record<string, unknown> }

function sse(events: object[]): string {
  return events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

function reply(opts: { text: string; stop: string; stopDetails?: object; usage?: object }): string {
  return sse([
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 2900, ...opts.usage } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: opts.text } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: opts.stop, stop_sequence: null, ...(opts.stopDetails ? { stop_details: opts.stopDetails } : {}) }, usage: { output_tokens: 40 } },
    { type: 'message_stop' },
  ]);
}

function fakeFetch(respond: () => Response, seen: Seen[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    seen.push({ url: String(input), headers, body: JSON.parse(String(init?.body ?? '{}')) });
    return respond();
  }) as typeof fetch;
}

const ok = (body: string) => () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
const err = (status: number, type: string, message: string) => () =>
  new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json' } });

const req = (signal = new AbortController().signal) => ({ system: 'SYSTEM', user: 'Request: lava', maxOutputTokens: 4000, signal });

afterEach(() => clearCloudKey());

describe('claudeProvider', () => {
  it('sends the request the reference describes, and returns the text with usage', async () => {
    setCloudKey(KEY);
    const seen: Seen[] = [];
    const phases: string[] = [];
    const p = claudeProvider('claude-opus-5-5', { fetch: fakeFetch(ok(reply({ text: 'Plan.\n```js\nreturn x;\n```', stop: 'end_turn' })), seen) });
    const r = await p.generate({ ...req(), onProgress: (x) => phases.push(x.phase) });
    expect(r).toEqual({ ok: true, text: 'Plan.\n```js\nreturn x;\n```', usage: { inputTokens: 12, outputTokens: 40, cacheReadTokens: 2900 } });
    expect(phases).toEqual(expect.arrayContaining(['connecting', 'loading', 'thinking', 'writing']));

    expect(seen).toHaveLength(1);
    const { url, headers, body } = seen[0];
    expect(url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
    expect(headers['x-api-key']).toBe(KEY);
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: CLAUDE_MAX_TOKENS,
      stream: true,
      system: [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'Request: lava' }],
      output_config: { effort: 'medium' },
      fallbacks: 'default',
    });
    // Thinking stays adaptive by omission; no sampling knobs on these models.
    for (const k of ['thinking', 'temperature', 'top_p', 'top_k', 'tool_choice', 'betas']) expect(body).not.toHaveProperty(k);
  });

  it('sends Haiku 4.5 neither an effort nor the fallback', async () => {
    setCloudKey(KEY);
    const seen: Seen[] = [];
    await claudeProvider('claude-haiku-4-5', { fetch: fakeFetch(ok(reply({ text: '```js\nreturn x;\n```', stop: 'end_turn' })), seen) }).generate(req());
    expect(seen[0].body).toMatchObject({ model: 'claude-haiku-4-5' });
    expect(seen[0].body).not.toHaveProperty('output_config');
    expect(seen[0].body).not.toHaveProperty('fallbacks');
    expect(seen[0].headers['anthropic-beta'] ?? '').not.toContain('server-side-fallback');
  });

  it('reads the stop reason before any text: a refusal or a cut-off reply is not an answer', async () => {
    setCloudKey(KEY);
    const refused = claudeProvider('claude-opus-5-5', { fetch: fakeFetch(ok(reply({ text: '```js\nreturn x;\n```', stop: 'refusal', stopDetails: { type: 'refusal', category: 'cyber', explanation: null } }))) });
    expect(await refused.generate(req())).toMatchObject({ ok: false, failure: 'refused' });
    const cut = claudeProvider('claude-opus-5-5', { fetch: fakeFetch(ok(reply({ text: '```js\nconst a = 1;', stop: 'max_tokens' }))) });
    expect(await cut.generate(req())).toEqual({ ok: false, failure: 'truncated' });
  });

  it('tells errors apart by class', async () => {
    setCloudKey(KEY);
    expect(await claudeProvider('claude-opus-5-5', { fetch: fakeFetch(err(401, 'authentication_error', 'invalid x-api-key')) }).generate(req()))
      .toMatchObject({ ok: false, failure: 'auth' });
    expect(await claudeProvider('claude-opus-5-5', { fetch: fakeFetch(err(404, 'not_found_error', 'model: nope')) }).generate(req()))
      .toMatchObject({ ok: false, failure: 'no-model' });
    expect(await claudeProvider('claude-opus-5-5', { fetch: fakeFetch(err(400, 'invalid_request_error', 'prompt is too long: 300000 tokens')) }).generate(req()))
      .toMatchObject({ ok: false, failure: 'context-too-small' });
  });

  it('an abort is a cancel, and no key means no request at all', async () => {
    setCloudKey(KEY);
    const ac = new AbortController();
    ac.abort();
    expect(await claudeProvider('claude-opus-5-5', { fetch: fakeFetch(ok(reply({ text: 'x', stop: 'end_turn' }))) }).generate(req(ac.signal)))
      .toEqual({ ok: false, failure: 'cancelled' });
    clearCloudKey();
    const seen: Seen[] = [];
    expect(await claudeProvider('claude-opus-5-5', { fetch: fakeFetch(ok(''), seen) }).generate(req()))
      .toEqual({ ok: false, failure: 'auth' });
    expect(seen).toHaveLength(0);
  });
});
