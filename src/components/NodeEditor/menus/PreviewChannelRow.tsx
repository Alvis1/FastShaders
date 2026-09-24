import { useAppStore } from '@/store/useAppStore';
import { t, portLabel } from '@/i18n';
import { previewableOutputs } from '@/utils/nodePreview';
import { labelStyle } from './menuShared';

/**
 * PREVIEW CHANNEL — the Image (Texture) node's preview control, at the TOP of
 * its settings menu: one label, then one short button per output socket
 * (Color · R · G · B · A).
 *
 * WHY it is not the shared footer rows (menuShared.tsx's `NodeActions`): that
 * block renders one full-width `Preview <socket>` row per previewable output,
 * which is right for a node with one or two of them and wrong for five. On an
 * Image node it pushed Reset / Duplicate / Delete five rows down a menu that
 * already scrolls, and it put the ONE control you reach for while looking at a
 * texture — "show me just the green channel" — at the far end of it. The
 * channels are four letters; they fit on one line, and a row of them reads as
 * a channel SWITCH rather than five unrelated commands. NodeActions keeps its
 * rows for every other node: `preview={false}` is an explicit opt-out passed
 * from one place, never a predicate NodeActions works out for itself (it is
 * rendered by six menus and a broad rule would silently strip Preview from
 * toHsl, Split and the Data node's columns).
 *
 * The BUTTONS are the same act as those rows — `setNodePreview`, the shared
 * store field, cleared by pressing the active one — so nothing about preview
 * mode is duplicated here: no second route, no second way to stop it, and
 * ⌘/Ctrl+click on the node still previews `outputs[0]`.
 *
 * Its labels come from `portLabel`, so they follow the node's sockets: the
 * button text IS the socket's name, and a socket renamed in the Node Designer
 * renames its button. One socket is abbreviated — see {@link ABBREVIATED}.
 */

/**
 * Sockets whose button prints only the first letter of their name.
 *
 * `alpha` alone, so the row reads "Color R G B A" — the spelling of RGBA, the
 * thing the four letters are FROM. R/G/B are already one glyph and Color is
 * the odd socket out (a vec3 beside four floats), so spelling it out is what
 * keeps the row from reading as five equal channels.
 *
 * By socket ID, never by length: a length rule would abbreviate "Krāsa" too
 * and leave the Latvian row as "K R G B A". The full name stays on the
 * button's `title` and on the socket's own tooltip, so nothing is lost.
 */
const ABBREVIATED: ReadonlySet<string> = new Set(['alpha']);

const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-1)',
  padding: '0 var(--space-3) var(--space-1)',
  flexWrap: 'wrap',
} as const;

const headerStyle = {
  ...labelStyle,
  display: 'block',
  padding: 'var(--space-2) var(--space-3) 2px',
} as const;

const buttonStyle = {
  padding: '2px 7px',
  background: 'var(--bg-input)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--border-radius-sm)',
  fontSize: 'var(--font-size-xs)',
  fontFamily: 'var(--font-mono)',
  color: 'var(--text-primary)',
  cursor: 'pointer',
  lineHeight: 1.4,
} as const;

/**
 * The ACTIVE channel. A ring rather than a fill: the swatch grid's own
 * selected affordance (`.context-menu__texture-cell[aria-selected]`), so the
 * two selectable things in this menu are marked the same way.
 *
 * Drawn with `box-shadow`, NOT `outline`, and that is the whole reason this is
 * a separate note: an inline `outline` beats the UA's focus ring, and these
 * buttons have no `:focus-visible` rule of their own — so the lit channel
 * would have been the one button you cannot see the keyboard focus on.
 * `box-shadow` leaves `outline` free for the browser.
 */
const activeButtonStyle = {
  ...buttonStyle,
  borderColor: 'var(--border-focus)',
  boxShadow: '0 0 0 1px var(--border-focus)',
  color: 'var(--text-primary)',
} as const;

export function PreviewChannelRow({ nodeId }: { nodeId: string }) {
  const language = useAppStore((s) => s.language);
  // The per-id selector every menu in this directory uses — `s.nodes` is a new
  // array on every graph notify, so subscribing to it re-renders the whole
  // open menu on each frame of an unrelated drag.
  const node = useAppStore((s) => s.nodes.find((n) => n.id === nodeId));
  const nodePreview = useAppStore((s) => s.nodePreview);
  const setNodePreview = useAppStore((s) => s.setNodePreview);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);

  const ports = node ? previewableOutputs(node) : [];
  if (ports.length === 0) return null;

  return (
    <>
      <span
        style={headerStyle}
        title={t(
          'Show one of this texture’s channels on the 3D preview in place of the Output’s wiring — click the lit one to stop. ⌘/Ctrl+click the node previews its Color.',
          language,
        )}
      >
        {t('Preview Channel', language)}
      </span>
      <div style={rowStyle}>
        {ports.map((port) => {
          const active = nodePreview?.nodeId === nodeId && nodePreview.handleId === port.id;
          const name = portLabel(port.label, language);
          return (
            <button
              key={port.id}
              type="button"
              // No `context-menu__item`: that class is a full-width row, and
              // these are chips in a flex line.
              style={active ? activeButtonStyle : buttonStyle}
              aria-pressed={active}
              // The full name is ALWAYS there — the tooltip is where an
              // abbreviated label says what it stands for, and "A" needs that
              // most while it is the lit one. The action is appended, never
              // substituted.
              title={active ? `${name} — ${t('Stop preview', language)}` : name}
              onClick={() => {
                setNodePreview(active ? null : { nodeId, handleId: port.id });
                closeContextMenu();
              }}
            >
              {ABBREVIATED.has(port.id) ? [...name][0] ?? name : name}
            </button>
          );
        })}
      </div>
    </>
  );
}
