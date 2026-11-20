/**
 * One interface for every route to a model: the desktop app's local server
 * (providers/local.ts over the Rust bridge) and the user's own cloud key
 * (providers/claude.ts). `generate` NEVER throws or rejects — every outcome is
 * a value (the `eval/evalUpload.ts` contract), so a dialog closing mid-request
 * leaves nothing unhandled behind.
 */
import type { ContextClass } from './prompt';

export type GenerateFailure =
  | 'cancelled'
  /** Nothing answers at the configured address. */
  | 'not-running'
  /** Something answers at the address, but not an OpenAI-compatible model server. */
  | 'wrong-server'
  /** The server address is not a loopback server address. */
  | 'bad-address'
  /** Another request to the local model is still in flight (one at a time). */
  | 'busy'
  /** The server runs but has no (such) model to answer with. */
  | 'no-model'
  /** The loaded model's window cannot hold the prompt. */
  | 'context-too-small'
  | 'auth'
  | 'rate-limit'
  /** The model declined the request. */
  | 'refused'
  /** The reply was cut off at the output limit. */
  | 'truncated'
  | 'timeout'
  | 'network'
  | 'bad-response'
  /** This route cannot run here (no desktop bridge, its code failed to load). */
  | 'unavailable'
  /** The request carried a picture and the model cannot take one. The
   *  orchestrator answers it by sending the measurements instead. */
  | 'no-vision';

export type GenerateProgress =
  | { phase: 'connecting' }
  /** Request sent, nothing back yet — a model loading or reading the prompt. */
  | { phase: 'loading' }
  | { phase: 'thinking'; chars: number }
  | { phase: 'writing'; chars: number };

export interface GenerateRequest {
  system: string;
  user: string;
  /** The user's picture, for a model that sees: a JPEG `data:` URL of the
   *  app's own drawing (picture.ts `seeUrl`). ONLY the local provider reads
   *  it, and only the dialog's own-server route sets it — a loopback address,
   *  so the picture stays on this computer. */
  image?: string;
  maxOutputTokens: number;
  signal: AbortSignal;
  onProgress?: (p: GenerateProgress) => void;
}

export interface GenerateUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

export type GenerateResult =
  | {
    ok: true;
    text: string;
    usage?: GenerateUsage;
    /** The answer came from the reasoning channel because `content` was empty. */
    fromReasoning?: boolean;
  }
  | {
    ok: false;
    failure: GenerateFailure;
    /** DATA for display (a server's message), never markup. */
    detail?: string;
  };

export interface GeneratorProvider {
  id: 'local' | 'claude';
  /** The model id, as the route names it. */
  model: string;
  contextClass: ContextClass;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}
