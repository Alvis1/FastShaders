/**
 * Claude through the user's OWN API key, straight from this browser to
 * api.anthropic.com with the official SDK. Reached only through `import()`
 * (llm/registry.ts), so the SDK never lands on the boot wave. A web build offers
 * this route only where its CSP names the API origin (FS_LLM_CLOUD_ORIGINS,
 * vite.config.ts); the desktop app and the dev server have no page CSP.
 *
 * What is sent: the fixed rules, the node list, worked examples and the
 * user's request — nothing from their graph or files (prompt.ts).
 *
 * Per the Claude API reference at the time of writing (2026-10-08):
 *  - a client is built PER REQUEST inside the key's closure and never cached
 *    (the SDK keeps the key as a public field);
 *  - `dangerouslyAllowBrowser` is what makes the SDK send the direct-browser
 *    access header the API's CORS answer requires;
 *  - streamed, so a long think never meets an HTTP timeout, and abortable;
 *  - thinking is left adaptive (Opus 5.5 and Sonnet 5.5 accept no other
 *    setting worth sending here) with an explicit effort — Opus 5.5's default
 *    is `medium`, made explicit; Haiku 4.5 takes neither;
 *  - the fixed system prompt carries the cache breakpoint, so repair rounds
 *    re-read it at cache price (Haiku 4.5 needs 4,096 tokens to cache, more
 *    than this prompt, and silently does not);
 *  - `stop_reason` is checked BEFORE any text is read: a refusal or a cut-off
 *    reply never reaches the gate as if it were an answer;
 *  - server-side fallbacks (`fallbacks: "default"`) re-run a classifier
 *    decline on the model Anthropic recommends for its category, on the two
 *    models that run those classifiers;
 *  - errors are told apart by the SDK's classes; only a 400's message is
 *    read, to tell a too-long prompt from other bad requests.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages';
import { withCloudKey } from '../cloudKey';
import type { ClaudeModel } from '../claudeModels';
import { classifyServerMessage } from '../protocol/errors';
import type { GenerateRequest, GenerateResult, GeneratorProvider } from '../providerTypes';

/** Room for the model's thinking AND the program (thinking counts toward it). */
export const CLAUDE_MAX_TOKENS = 32_000;
/** Per request; the SDK retries 408/409/429/5xx and connection errors twice. */
const REQUEST_TIMEOUT_MS = 300_000;

/** Models whose safety classifiers can decline, and which accept the
 *  server-side fallback in its `"default"` form. */
const FALLBACK_MODELS: ReadonlySet<ClaudeModel> = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);
/** Models that take `output_config.effort` (Haiku 4.5 rejects it). */
const EFFORT_MODELS: ReadonlySet<ClaudeModel> = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

const hasClosedFence = (text: string): boolean => (text.match(/```/g)?.length ?? 0) >= 2;

export interface ClaudeDeps {
  /** Injected in tests (ClientOptions.fetch); the browser's own otherwise. */
  fetch?: typeof fetch;
}

/** The request body — exported for the request-shape test. */
export function claudeParams(model: ClaudeModel, req: Pick<GenerateRequest, 'system' | 'user'>): BetaMessageStreamParams {
  return {
    model,
    max_tokens: CLAUDE_MAX_TOKENS,
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: req.user }],
    ...(EFFORT_MODELS.has(model) ? { output_config: { effort: 'medium' as const } } : {}),
    ...(FALLBACK_MODELS.has(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  };
}

export function claudeProvider(model: ClaudeModel, deps: ClaudeDeps = {}): GeneratorProvider {
  return {
    id: 'claude',
    model,
    contextClass: 'large',
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      req.onProgress?.({ phase: 'connecting' });
      const client = withCloudKey((apiKey) => new Anthropic({
        apiKey,
        dangerouslyAllowBrowser: true,
        timeout: REQUEST_TIMEOUT_MS,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      }));
      if (!client) return { ok: false, failure: 'auth' };
      try {
        req.onProgress?.({ phase: 'loading' });
        const stream = client.beta.messages.stream(claudeParams(model, req), { signal: req.signal });
        let writing = 0;
        let thinking = 0;
        for await (const event of stream) {
          if (event.type !== 'content_block_delta') continue;
          if (event.delta.type === 'text_delta') {
            writing += event.delta.text.length;
            req.onProgress?.({ phase: 'writing', chars: writing });
          } else if (event.delta.type === 'thinking_delta') {
            thinking += event.delta.thinking.length;
            req.onProgress?.({ phase: 'thinking', chars: thinking });
          }
        }
        const message = await stream.finalMessage();
        // The stop reason first: a refusal's or a cut-off reply's text is not an answer.
        if (message.stop_reason === 'refusal') {
          const category = message.stop_details?.category;
          return { ok: false, failure: 'refused', ...(category ? { detail: category } : {}) };
        }
        let text = '';
        for (const block of message.content) if (block.type === 'text') text += block.text;
        if (message.stop_reason === 'max_tokens' && !hasClosedFence(text)) return { ok: false, failure: 'truncated' };
        if (!text.trim()) return { ok: false, failure: 'bad-response', detail: 'the model sent an empty reply' };
        return {
          ok: true,
          text,
          usage: {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            cacheReadTokens: message.usage.cache_read_input_tokens ?? undefined,
          },
        };
      } catch (e) {
        if (e instanceof Anthropic.APIUserAbortError || req.signal.aborted) return { ok: false, failure: 'cancelled' };
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
          return { ok: false, failure: 'auth', detail: e.message };
        }
        if (e instanceof Anthropic.RateLimitError) return { ok: false, failure: 'rate-limit', detail: e.message };
        if (e instanceof Anthropic.NotFoundError) return { ok: false, failure: 'no-model', detail: e.message };
        if (e instanceof Anthropic.BadRequestError) return { ok: false, failure: classifyServerMessage(400, e.message), detail: e.message };
        if (e instanceof Anthropic.APIConnectionTimeoutError) return { ok: false, failure: 'timeout' };
        if (e instanceof Anthropic.APIConnectionError) return { ok: false, failure: 'network', detail: e.message };
        if (e instanceof Anthropic.InternalServerError) return { ok: false, failure: 'unavailable', detail: e.message };
        if (e instanceof Anthropic.APIError) return { ok: false, failure: 'bad-response', detail: e.message };
        return { ok: false, failure: 'bad-response', detail: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
