/**
 * ONE classifier from what went wrong on the wire to what the user is told.
 * The app (Rust bridge) and the probe (fetch) report the same transport codes
 * (transport/types.ts), so this serves both.
 */
import { safeJsonReviver } from '@/utils/safeJson';
import type { TransportFailure } from '../transport/types';
import type { GenerateFailure } from '../providerTypes';

const CONTEXT_RE = /context (?:length|window|size|overflow)|n_ctx|exceeds? (?:the )?(?:context|maximum)|too many tokens|prompt is too long|tokens? limit/i;
const NO_MODEL_RE = /no models? (?:is |are )?loaded|model .*not (?:found|loaded)|failed to load model|unknown model|model_not_found|no such model/i;

/** An HTTP error body or a stream error message → its failure kind. */
export function classifyServerMessage(status: number | null, message: string): GenerateFailure {
  if (CONTEXT_RE.test(message)) return 'context-too-small';
  if (NO_MODEL_RE.test(message)) return 'no-model';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limit';
  if (status === 404) return 'no-model';
  if (status === 408 || status === 504) return 'timeout';
  // A proxy answering for a server that is down (the dev server's LLM proxy).
  if (status === 502) return 'not-running';
  return 'bad-response';
}

/** A transport failure → failure kind + the detail worth showing. */
export function classifyTransportFailure(f: TransportFailure): { failure: GenerateFailure; detail?: string } {
  switch (f.code) {
    case 'CANCELLED': return { failure: 'cancelled' };
    case 'UNREACHABLE': return { failure: 'not-running', detail: f.detail || undefined };
    case 'TIMEOUT': return { failure: 'timeout' };
    case 'HTTP': {
      const m = /^(\d{3}):?\s*([\s\S]*)$/.exec(f.detail);
      const status = m ? Number(m[1]) : null;
      const body = m ? m[2] : f.detail;
      return { failure: classifyServerMessage(status, body), detail: serverMessage(body) };
    }
    // App-written explanations are failure KINDS, worded (and translated) by
    // the dialog — never English `detail`, which is shown as server DATA.
    case 'BUSY': return { failure: 'busy' };
    case 'BAD_URL': return { failure: 'bad-address' };
    case 'NOT_DESKTOP': return { failure: 'unavailable' };
    case 'BAD_ROUTE':
    case 'TOO_LARGE':
    case 'BAD_RESPONSE':
      return { failure: 'bad-response', detail: f.detail || undefined };
  }
}

/** The human part of an error body: `{"error": "…"}`, `{"error": {"message": "…"}}`, or the text. */
export function serverMessage(body: string): string {
  let text = body.trim();
  try {
    const v = JSON.parse(text, safeJsonReviver) as { error?: unknown; message?: unknown };
    const e = v?.error;
    if (typeof e === 'string') text = e;
    else if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') text = (e as { message: string }).message;
    else if (typeof v?.message === 'string') text = v.message;
  } catch {
    // Not JSON: keep the text.
  }
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 297)}…` : text;
}
