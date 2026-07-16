/**
 * Embeds the standalone Node Designer (node-designer.html) in a modal, deep-linked
 * to one node type, so node-editor.html's overview table and the designer read as
 * one tool: click a designable node's preview → design its glyph right there.
 *
 * Only reachable for rows whose def has `getFlowNodeType(def) === 'shader'` —
 * those are the ones the designer's glyph path can actually edit. GraphsPage owns
 * that routing decision; see the `designable` flag there.
 *
 * DO NOT ADD `sandbox` TO THE IFRAME. The designer is first-party and REQUIRES
 * same-origin privileges: it persists UI state under localStorage `nd:*` keys and
 * saves glyphs through the dev-server `/__nd/glyphs` endpoint. A `sandbox`
 * attribute without `allow-same-origin` would silently break its save path (writes
 * would appear to succeed and land nowhere); a sandbox WITH `allow-same-origin`
 * plus `allow-scripts` is not a boundary at all. There is nothing to harden here —
 * the frame runs the same code the top-level page does.
 */
import { useEffect } from 'react';
import './DesignerModal.css';

export interface DesignerModalProps {
  /** Registry node type — the designer's `?node=` deep-link target. */
  type: string;
  /** Human label for the header (def.label). */
  label: string;
  onClose: () => void;
}

/**
 * Resolve node-designer.html against the app's base path. Base is '/FastShaders/'
 * on the web but '/' in the desktop profile, and the page can be served from a
 * non-http scheme (tauri://) — so mirror resolveAssetUrl() in
 * src/engine/tslToPreviewHTML.ts rather than hardcoding either base.
 */
function designerUrl(type: string): string {
  const base = import.meta.env.BASE_URL;
  const path = `node-designer.html?node=${encodeURIComponent(type)}`;
  if (typeof window === 'undefined') return `${base}${path}`;
  return new URL(`${base}${path}`, window.location.href).href;
}

export function DesignerModal({ type, label, onClose }: DesignerModalProps) {
  // Mirrors GraphModal's Escape handling so both modals close identically.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="dm__backdrop" onClick={onClose}>
      <div className="dm__panel" onClick={(e) => e.stopPropagation()}>
        <header className="dm__head">
          <div className="dm__titles">
            <h2 className="dm__title">{label}</h2>
            <span className="dm__sub">{type}</span>
          </div>
          {/* Saving a glyph rewrites src/.../glyphs/customGlyphs.ts, which is in
              THIS page's module graph (NodePreviewCard → NodeGlyph → customGlyphs),
              so Vite HMR repaints the row previews behind the modal on save. */}
          <span className="dm__note">Node Designer · saved glyphs hot-reload the table behind this modal</span>
          <button className="dm__close" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </header>

        <iframe
          className="dm__frame"
          src={designerUrl(type)}
          title={`Node Designer — ${label}`}
        />
      </div>
    </div>
  );
}
