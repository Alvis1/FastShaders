import { describe, expect, it } from 'vitest';
import { SseDecoder } from './sse';
import { ChatAccumulator, chatBody, parseModelList } from './openaiCompat';
import { classifyServerMessage, classifyTransportFailure, serverMessage } from './errors';

/** An OpenAI-compatible stream, as LM Studio sends it (Latvian text included,
 *  so multi-byte characters straddle chunk cuts). */
const STREAM = [
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
  '',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Plāns: zils "},"finish_reason":null}]}',
  '',
  ': keep-alive comment',
  '',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"→ oranžs.\\n```js\\nreturn x;\\n```"},"finish_reason":null}]}',
  '',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":2900,"completion_tokens":41,"total_tokens":2941}}',
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

const bytes = new TextEncoder().encode(STREAM);

function decodeIn(parts: Uint8Array[]): string[] {
  const d = new SseDecoder();
  return [...parts.flatMap((p) => d.push(p)), ...d.end()];
}

describe('SseDecoder', () => {
  it('yields the same events wherever the byte stream is cut', () => {
    const whole = decodeIn([bytes]);
    expect(whole).toHaveLength(6);
    for (let cut = 1; cut < bytes.length; cut++) {
      expect(decodeIn([bytes.slice(0, cut), bytes.slice(cut)])).toEqual(whole);
    }
    // And byte by byte.
    expect(decodeIn([...bytes].map((b) => Uint8Array.of(b)))).toEqual(whole);
  });

  it('reads CRLF and CR line endings, multi-line data, and a final event with no blank line', () => {
    const d = new SseDecoder();
    const out = [
      ...d.push(new TextEncoder().encode('data: a\r\ndata: b\r\n\r\ndata: c\r')),
      ...d.push(new TextEncoder().encode('\n\rdata:d')),
      ...d.end(),
    ];
    expect(out).toEqual(['a\nb', 'c', 'd']);
  });
});

describe('ChatAccumulator', () => {
  it('folds content, finish reason and usage', () => {
    const acc = new ChatAccumulator();
    for (const e of decodeIn([bytes])) acc.push(e);
    expect(acc.text).toBe('Plāns: zils → oranžs.\n```js\nreturn x;\n```');
    expect(acc.finish).toBe('stop');
    expect(acc.usage).toEqual({ inputTokens: 2900, outputTokens: 41 });
    expect(acc.done).toBe(true);
    expect(acc.fromReasoning).toBe(false);
  });

  it('falls back to the reasoning channel when content stays empty', () => {
    const acc = new ChatAccumulator();
    acc.push('{"choices":[{"delta":{"reasoning_content":"```js\\nreturn x;\\n```"}}]}');
    acc.push('{"choices":[{"delta":{"content":"  "}}]}');
    expect(acc.text).toBe('```js\nreturn x;\n```');
    expect(acc.fromReasoning).toBe(true);
  });

  it('records an error sent inside the stream, in either shape', () => {
    const a = new ChatAccumulator();
    a.push('{"error":{"message":"Context length exceeded"}}');
    expect(a.error).toBe('Context length exceeded');
    const b = new ChatAccumulator();
    b.push('{"error":"model crashed"}');
    expect(b.error).toBe('model crashed');
  });

  it('ignores junk and prototype keys without throwing', () => {
    const acc = new ChatAccumulator();
    for (const e of ['not json', '{"__proto__":{"content":"x"}}', '{"choices":"nope"}', '{"choices":[{"delta":{"content":5}}]}', '[]', 'null']) {
      expect(() => acc.push(e)).not.toThrow();
    }
    expect(acc.text).toBe('');
    expect(({} as Record<string, unknown>).content).toBeUndefined();
  });

  it('builds a streaming request with thinking switched off', () => {
    const body = JSON.parse(chatBody({ model: 'qwen/x', system: 'S', user: 'U', maxOutputTokens: 3000 }));
    expect(body).toMatchObject({
      model: 'qwen/x', stream: true, max_tokens: 3000, temperature: 0.2,
      messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }],
      chat_template_kwargs: { enable_thinking: false },
    });
  });
});

describe('parseModelList', () => {
  it('reads the OpenAI list', () => {
    expect(parseModelList('{"object":"list","data":[{"id":"google/gemma-4-e2b","object":"model"},{"id":"text-embedding-nomic","object":"model"}]}'))
      .toEqual([{ id: 'google/gemma-4-e2b' }]);
  });

  it('reads LM Studio\'s native list with what is loaded and at which context', () => {
    const body = JSON.stringify({
      models: [
        { type: 'llm', key: 'qwen/qwen3-coder-next', loaded_instances: [{ id: 'qwen/qwen3-coder-next', config: { context_length: 16384 } }] },
        { type: 'llm', key: 'google/gemma-4-31b', loaded_instances: [] },
        { type: 'embedding', key: 'nomic-embed', loaded_instances: [] },
      ],
    });
    expect(parseModelList(body)).toEqual([
      { id: 'qwen/qwen3-coder-next', loaded: true, contextLength: 16384 },
      { id: 'google/gemma-4-31b', loaded: false },
    ]);
  });

  it('drops unusable ids and survives junk', () => {
    expect(parseModelList('{"data":[{"id":"a b"},{"id":"<script>"},{"id":""},{"id":"' + 'x'.repeat(201) + '"},{"id":"ok-1"},{"id":"ok-1"}]}'))
      // Printable ASCII is kept as DATA — rendered as a text node, never markup.
      .toEqual([{ id: '<script>' }, { id: 'ok-1' }]);
    for (const junk of ['', 'null', '[]', '{"data":5}', '{"__proto__":{"data":[{"id":"x"}]}}']) {
      expect(parseModelList(junk)).toEqual([]);
    }
  });
});

describe('error classification', () => {
  it.each([
    [400, 'The number of tokens to keep from the initial prompt is greater than the context length', 'context-too-small'],
    [400, 'Trying to keep the first 9000 tokens when context the overflows. However, the model is loaded with context length of 8192', 'context-too-small'],
    [404, 'No models loaded. Please load a model in the developer page or use the `lms load` command.', 'no-model'],
    [400, 'Model "x" not found', 'no-model'],
    [401, 'unauthorized', 'auth'],
    [429, 'slow down', 'rate-limit'],
    [500, 'internal', 'bad-response'],
    [502, 'Nothing answers at 127.0.0.1:1234 (FS_LLM_DEV_TARGET)', 'not-running'],
  ])('%i %s → %s', (status, message, failure) => {
    expect(classifyServerMessage(status, message)).toBe(failure);
  });

  it('maps every transport code', () => {
    expect(classifyTransportFailure({ ok: false, code: 'UNREACHABLE', detail: '' }).failure).toBe('not-running');
    expect(classifyTransportFailure({ ok: false, code: 'CANCELLED', detail: '' }).failure).toBe('cancelled');
    expect(classifyTransportFailure({ ok: false, code: 'TIMEOUT', detail: '' }).failure).toBe('timeout');
    expect(classifyTransportFailure({ ok: false, code: 'BUSY', detail: '' })).toEqual({ failure: 'busy' });
    expect(classifyTransportFailure({ ok: false, code: 'BAD_URL', detail: '' })).toEqual({ failure: 'bad-address' });
    expect(classifyTransportFailure({ ok: false, code: 'NOT_DESKTOP', detail: '' }).failure).toBe('unavailable');
    expect(classifyTransportFailure({ ok: false, code: 'HTTP', detail: '404: {"error":"No models loaded."}' }))
      .toEqual({ failure: 'no-model', detail: 'No models loaded.' });
    expect(classifyTransportFailure({ ok: false, code: 'TOO_LARGE', detail: '9000000 8388608' }).failure).toBe('bad-response');
  });

  it('a server message is flattened, stripped of control characters and capped', () => {
    expect(serverMessage('{"error":{"message":"a\\u0000\\n b"}}')).toBe('a b');
    expect(serverMessage('x'.repeat(400))).toHaveLength(298);
  });
});
