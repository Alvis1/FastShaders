/**
 * A model server on this computer — LM Studio or llama.cpp's server, through
 * their OpenAI-compatible API — over any LocalTransport: the Rust bridge in
 * the desktop app (transport/tauriTransport.ts), fetch in the probe
 * (transport/fetchTransport.ts). Ships exactly the protocol code the probe
 * measured.
 */
import type { LocalTransport, TransportFailure } from '../transport/types';
import { classifyServerMessage, classifyTransportFailure, refusesPicture, serverMessage } from '../protocol/errors';
import { ChatAccumulator, chatBody, parseModelList, type LocalModel } from '../protocol/openaiCompat';
import { SseDecoder } from '../protocol/sse';
import type { ContextClass } from '../prompt';
import type { GenerateFailure, GenerateRequest, GenerateResult, GeneratorProvider } from '../providerTypes';

/**
 * The loaded context a generation needs, in tokens: the medium prompt budget
 * plus its output budget, plus room for a repair round's quoted program. LM
 * Studio loads a model at 8,192 by default here, which a repair round can
 * overflow; the probe loaded at 16,384.
 */
export const LOCAL_MIN_CONTEXT = 12_288;

export type LocalCheck =
  | {
    ok: true;
    models: LocalModel[];
    /** True when the server reported which models are loaded (LM Studio's native list). */
    knowsLoaded: boolean;
  }
  | { ok: false; failure: GenerateFailure; detail?: string };

const fromTransport = (f: TransportFailure): { ok: false; failure: GenerateFailure; detail?: string } => ({
  ok: false,
  ...classifyTransportFailure(f),
});

/** What answers at `base`, and with which models. Never throws. */
export async function checkLocalServer(transport: LocalTransport, base: string, signal: AbortSignal): Promise<LocalCheck> {
  // LM Studio's native list first: the only one that says what is LOADED and
  // at which context. Any other server answers 404 there.
  const native = await transport.get(base, '/api/v1/models', signal);
  if (native.ok) {
    const models = parseModelList(native.value);
    if (models.length > 0 && models.some((m) => m.loaded !== undefined)) return { ok: true, models, knowsLoaded: true };
  } else if (native.code === 'UNREACHABLE' || native.code === 'CANCELLED' || native.code === 'BAD_URL' || native.code === 'NOT_DESKTOP') {
    return fromTransport(native);
  }
  const plain = await transport.get(base, '/v1/models', signal);
  if (!plain.ok) {
    if (plain.code === 'HTTP' && plain.detail.startsWith('404')) return { ok: false, failure: 'wrong-server' };
    return fromTransport(plain);
  }
  const models = parseModelList(plain.value);
  if (models.length === 0) return { ok: false, failure: 'no-model' };
  return { ok: true, models, knowsLoaded: false };
}

/** Does `text` hold a whole fenced program (an opening AND a closing fence)? */
const hasClosedFence = (text: string): boolean => (text.match(/```/g)?.length ?? 0) >= 2;

export function localProvider(transport: LocalTransport, base: string, model: string, contextClass: ContextClass = 'medium'): GeneratorProvider {
  return {
    id: 'local',
    model,
    contextClass,
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      req.onProgress?.({ phase: 'connecting' });
      const decoder = new SseDecoder();
      const acc = new ChatAccumulator();
      const feed = (events: string[]) => {
        for (const data of events) {
          if (!acc.push(data)) continue;
          if (acc.content) req.onProgress?.({ phase: 'writing', chars: acc.content.length });
          else req.onProgress?.({ phase: 'thinking', chars: acc.reasoning.length });
        }
      };
      req.onProgress?.({ phase: 'loading' });
      const sent = await transport.post(
        base,
        '/v1/chat/completions',
        chatBody({ model, system: req.system, user: req.user, maxOutputTokens: req.maxOutputTokens, image: req.image }),
        (chunk) => feed(decoder.push(chunk)),
        req.signal,
      );
      // A model that cannot take the picture says so with a 4xx (measured on
      // LM Studio: 400 "…does not support image inputs"). That is its own
      // outcome: the run goes on with the measurements (orchestrate.ts).
      if (!sent.ok) {
        if (req.image && sent.code === 'HTTP' && /^4\d\d/.test(sent.detail) && refusesPicture(sent.detail)) {
          return { ok: false, failure: 'no-vision' };
        }
        return fromTransport(sent);
      }
      feed(decoder.end());
      if (acc.error) {
        if (req.image && refusesPicture(acc.error)) return { ok: false, failure: 'no-vision' };
        return { ok: false, failure: classifyServerMessage(null, acc.error), detail: serverMessage(acc.error) };
      }
      const text = acc.text;
      if (acc.finish === 'length' && !hasClosedFence(text)) return { ok: false, failure: 'truncated' };
      if (!text.trim()) return { ok: false, failure: 'bad-response', detail: 'the model sent an empty reply' };
      return { ok: true, text, usage: acc.usage, fromReasoning: acc.fromReasoning };
    },
  };
}
