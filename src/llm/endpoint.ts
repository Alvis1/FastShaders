/**
 * The local model server's address: what the user types, and the one form the
 * transports accept.
 *
 * `normalizeLocalBase` is UX only — it forgives what people paste (spaces, an
 * upper-case scheme or host, a trailing `/`, the OpenAI-style `/v1` suffix)
 * and refuses everything that is not a loopback base with an explicit port.
 * The security boundary is Rust's `parse_base` (src-tauri/src/llm.rs), which
 * accepts only the canonical spellings; `isLoopbackBase` is its exact mirror,
 * so the fetch transport (the probe under node, the dev server), where no Rust
 * runs, enforces the same rule. `src-tauri/tests/llm-urls.json` holds the
 * cases all three share, and both test suites run over it.
 */
import { LLM_LOOPBACK_HOSTS, LLM_MAX_REQUEST_BYTES } from '@/utils/desktopIpc';
import type { TransportFailure } from './transport/types';

/** LM Studio's default. */
export const DEFAULT_LOCAL_BASE = 'http://127.0.0.1:1234';

const SCHEME = 'http://';
const PORT_RE = /^[1-9][0-9]{0,4}$/;
const PRINTABLE_ASCII_RE = /^[\x21-\x7e]+$/;

/**
 * Rust's `parse_base`, character for character: `http://`, a host from
 * `LLM_LOOPBACK_HOSTS` exactly as spelled there, `:` and a port 1–65535 with no
 * sign or leading zero, then at most one `/`. Nothing else — no userinfo, no
 * other spelling of an address, no path, query or fragment.
 */
export function isLoopbackBase(base: string): boolean {
  if (!base.startsWith(SCHEME)) return false;
  let rest = base.slice(SCHEME.length);
  if (rest.endsWith('/')) rest = rest.slice(0, -1);
  const colon = rest.lastIndexOf(':');
  if (colon < 0) return false;
  const host = rest.slice(0, colon);
  const port = rest.slice(colon + 1);
  return (
    (LLM_LOOPBACK_HOSTS as readonly string[]).includes(host) &&
    PORT_RE.test(port) &&
    Number(port) <= 65535
  );
}

/**
 * The canonical base for what the user typed (`http://<host>:<port>`, no
 * trailing slash), or null when it is not a loopback server address. Trims,
 * lower-cases the scheme and the host, strips ONE trailing `/` and then ONE
 * trailing `/v1`, and accepts the result only if `isLoopbackBase` does.
 * Idempotent: a returned base normalizes to itself.
 */
export function normalizeLocalBase(input: string): string | null {
  const text = input.trim();
  // Printable ASCII only: no inner whitespace, and no Unicode case mapping
  // that could fold an exotic letter into an ASCII host.
  if (!PRINTABLE_ASCII_RE.test(text)) return null;
  if (text.slice(0, SCHEME.length).toLowerCase() !== SCHEME) return null;
  const rest = text.slice(SCHEME.length);
  const cut = rest.search(/[/?#]/);
  const authority = cut < 0 ? rest : rest.slice(0, cut);
  let base = SCHEME + authority.toLowerCase() + (cut < 0 ? '' : rest.slice(cut));
  if (base.endsWith('/')) base = base.slice(0, -1);
  if (base.endsWith('/v1')) base = base.slice(0, -3);
  return !base.endsWith('/') && isLoopbackBase(base) ? base : null;
}

/**
 * The refusals Rust makes before it connects — the base, the route, the
 * request size, in that order and with the same codes and detail — so both
 * transports refuse the same requests the same way. Null when the request
 * may go.
 */
export function requestRefusal(
  base: string,
  path: string,
  routes: readonly string[],
  body?: string,
): TransportFailure | null {
  if (!isLoopbackBase(base)) return { ok: false, code: 'BAD_URL', detail: '' };
  if (!routes.includes(path)) return { ok: false, code: 'BAD_ROUTE', detail: '' };
  if (body !== undefined) {
    // The UTF-8 size, as Rust counts it.
    const bytes = new TextEncoder().encode(body).length;
    if (bytes > LLM_MAX_REQUEST_BYTES) {
      return { ok: false, code: 'TOO_LARGE', detail: `${bytes} ${LLM_MAX_REQUEST_BYTES}` };
    }
  }
  return null;
}
