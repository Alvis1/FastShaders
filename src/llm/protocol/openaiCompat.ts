/**
 * The OpenAI-compatible chat protocol as LM Studio and llama.cpp speak it:
 * the request body, the streamed reply, and the model list. Pure — the bytes
 * travel through a transport (transport/types.ts), and everything a server
 * sends is DATA: parsed with the prototype-safe reviver, read by type, and
 * never rendered as markup.
 */
import { safeJsonReviver } from '@/utils/safeJson';
import type { GenerateUsage } from '../providerTypes';

export interface ChatRequestOptions {
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  /** The user's picture for a model that SEES (`isSeenPictureUrl`): attached
   *  to the user turn. Anything else is left out — never a URL a server
   *  would fetch (llama.cpp's server downloads an http `image_url`). */
  image?: string;
}

/** The longest picture a request carries, as `data:` URL characters: well
 *  inside `LLM_MAX_REQUEST_BYTES` with the prompt beside it. */
export const MAX_SEEN_PICTURE_CHARS = 700_000;
const SEEN_PICTURE_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;

/** The ONE form a picture travels in: a base64 JPEG `data:` URL the app
 *  encoded from its own canvas (picture.ts), within the size cap. */
export const isSeenPictureUrl = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= MAX_SEEN_PICTURE_CHARS && SEEN_PICTURE_RE.test(v);

/**
 * The request body. Thinking is switched off through the chat template
 * (`enable_thinking: false` — honoured by the Qwen 3.x and Gemma 4 templates
 * the 2026-10-02 spike ran, ignored by templates that have no such switch);
 * a model that thinks anyway still answers, through the reasoning fallback.
 * Temperature 0.2: the spike's setting. With a picture the user turn is the
 * OpenAI content-part form (text, then `image_url`), which LM Studio, Ollama
 * and llama.cpp's server all read.
 */
export function chatBody(o: ChatRequestOptions): string {
  return JSON.stringify({
    model: o.model,
    messages: [
      { role: 'system', content: o.system },
      {
        role: 'user',
        content: isSeenPictureUrl(o.image)
          ? [{ type: 'text', text: o.user }, { type: 'image_url', image_url: { url: o.image } }]
          : o.user,
      },
    ],
    temperature: 0.2,
    max_tokens: o.maxOutputTokens,
    stream: true,
    stream_options: { include_usage: true },
    chat_template_kwargs: { enable_thinking: false },
  });
}

const parse = (text: string): unknown => {
  try { return JSON.parse(text, safeJsonReviver); } catch { return undefined; }
};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** Folds the stream's `data` events into the reply. */
export class ChatAccumulator {
  content = '';
  reasoning = '';
  finish: string | null = null;
  usage: GenerateUsage | undefined;
  /** A server error sent INSIDE the stream. */
  error: string | null = null;
  done = false;

  /** One SSE `data` payload. Returns true when it carried new text. */
  push(data: string): boolean {
    if (data.trim() === '[DONE]') { this.done = true; return false; }
    const event = obj(parse(data));
    if ('error' in event) {
      const e = event.error;
      this.error = typeof e === 'string' ? e : str(obj(e).message) || 'the server reported an error';
      return false;
    }
    const u = obj(event.usage);
    if ('usage' in event && Object.keys(u).length > 0) {
      this.usage = { inputTokens: num(u.prompt_tokens), outputTokens: num(u.completion_tokens) };
    }
    const choices = Array.isArray(event.choices) ? event.choices : [];
    const choice = obj(choices[0]);
    const delta = obj(choice.delta);
    const before = this.content.length + this.reasoning.length;
    this.content += str(delta.content);
    this.reasoning += str(delta.reasoning_content) || str(delta.reasoning);
    const finish = str(choice.finish_reason);
    if (finish) this.finish = finish;
    return this.content.length + this.reasoning.length > before;
  }

  /** The answer: the content, or — when a model wrote everything into its
   *  reasoning channel — the reasoning. */
  get text(): string {
    return this.content.trim() ? this.content : this.reasoning;
  }

  get fromReasoning(): boolean {
    return !this.content.trim() && !!this.reasoning.trim();
  }
}

export interface LocalModel {
  id: string;
  /** Known only from LM Studio's native list. */
  loaded?: boolean;
  /** The context the loaded instance runs with, when the server says. */
  contextLength?: number;
  /** Can it take a picture? Known only from LM Studio's native list
   *  (`capabilities.vision`); absent = the server did not say. */
  vision?: boolean;
}

/** Longest model id kept (printable ASCII only). */
const MAX_MODEL_ID = 200;
export const isUsableModelId = (id: string): boolean =>
  id.length > 0 && id.length <= MAX_MODEL_ID && /^[\x21-\x7e]+$/.test(id);

/**
 * Models from either list: OpenAI's `/v1/models` (`{data: [{id}]}`) or LM
 * Studio's native `/api/v1/models` (`{models: [{key, loaded_instances: [{config:
 * {context_length}}], capabilities: {vision}}]}`, the only one that reports a
 * loaded context and whether a model sees pictures). Embedding
 * models are left out — they cannot chat.
 */
export function parseModelList(body: string): LocalModel[] {
  const root = obj(parse(body));
  const list = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : [];
  const out: LocalModel[] = [];
  const seen = new Set<string>();
  for (const item of list.slice(0, 500)) {
    const m = obj(item);
    const id = str(m.id) || str(m.key);
    if (!isUsableModelId(id) || seen.has(id)) continue;
    const type = str(m.type);
    if (type === 'embedding' || /embed/i.test(id)) continue;
    seen.add(id);
    const instances = Array.isArray(m.loaded_instances) ? m.loaded_instances : null;
    const model: LocalModel = { id };
    if (instances) {
      model.loaded = instances.length > 0;
      const ctx = num(obj(obj(instances[0]).config).context_length);
      if (ctx !== undefined) model.contextLength = ctx;
    }
    const vision = obj(m.capabilities).vision;
    if (typeof vision === 'boolean') model.vision = vision;
    out.push(model);
  }
  return out;
}
