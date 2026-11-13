/**
 * WHICH document the graph of an embedded FastShaders is (embed/EmbedBridge.tsx).
 *
 * The host (SuperWXR's shader panel) holds many shaders and one editor. Every
 * message the editor sends therefore names the document it is about, so the
 * host files it by that name and never by "whatever is selected now": a module
 * settled just before the host opened another shader used to land on that
 * other shader, and a failed open left the host believing the editor held a
 * document it did not.
 *
 *   - `superwxr:open { id }` — the graph IS that document until it is replaced.
 *   - A file opened INSIDE the editor (a dropped shader's Open, NEW) is another
 *     document, and none of the host's: it gets an id MINTED here plus
 *     `replaced`, the id of the document it took the place of, so the host can
 *     keep the old one and file the new one beside it. Minted, not null,
 *     because every later edit of that document has to name the same thing —
 *     a null would make each one look like a fresh arrival.
 *   - The graph the editor started with came from no open and replaced
 *     nothing: `id: null`, which a host ignores.
 *
 * A LEAF (imports nothing): `engine/exportShader.ts` stamps the id on EXPORT's
 * bytes without pulling the bridge chunk, and the rules are unit-tested here
 * rather than pinned on the bridge's source. The state is module-scoped —
 * one page, one editor, one document.
 */

/** Hosts read this off `superwxr:ready`: 2 = every message names its document. */
export const EMBED_PROTOCOL = 2;

/** A host id is echoed on every message, so it is bounded like the name is. */
export const EMBED_ID_MAX = 200;

/** Ids minted here start with this, so a host can never mistake one for its own. */
export const MINTED_ID_PREFIX = 'fastshaders-doc-';

export interface EmbedDocument {
  /** The `open` this graph came from, an id minted here, or null (the boot graph). */
  id: string | null;
  /** Only beside a minted id: the document this one replaced (null: the boot graph). */
  replaced?: string | null;
}

let current: EmbedDocument = { id: null };
let mintCount = 0;

/** A host's document id as it arrives: a non-empty bounded string, else none. */
export function hostDocumentId(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= EMBED_ID_MAX ? raw : null;
}

/** The document the graph is right now. */
export function embedDocument(): EmbedDocument {
  return current;
}

/** The host opened a document: the graph is that one (null: a host that sends no id). */
export function embedDocumentOpened(id: string | null): void {
  current = { id };
}

/**
 * Something other than the host replaced the graph. Unique per page load, which
 * is all a host can hold it for (its panel and this page reload together); the
 * clock is only there so two page loads do not hand a host the same string.
 */
export function embedDocumentReplaced(): void {
  mintCount += 1;
  current = { id: `${MINTED_ID_PREFIX}${Date.now().toString(36)}-${mintCount}`, replaced: current.id };
}

/** The fields every outgoing message carries: `id`, and `replaced` only when there is one. */
export function embedDocumentFields(): { id: string | null; replaced?: string | null } {
  return current.replaced === undefined ? { id: current.id } : { id: current.id, replaced: current.replaced };
}

/**
 * The dedupe key of a posted module: the document AND the text. The text alone
 * would swallow the first post of a document whose module happens to equal the
 * last one sent — a file dropped onto the editor that already shows it.
 */
export function embedModuleKey(text: string): string {
  return `${current.id ?? ''}\n${text}`;
}
