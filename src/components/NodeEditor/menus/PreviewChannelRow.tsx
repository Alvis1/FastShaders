import { useAppStore } from '@/store/useAppStore';
import { t, portLabel } from '@/i18n';
import { previewableOutputs } from '@/utils/nodePreview';
import { labelStyle } from './menuShared';

/**
 * The Image node's preview control: one chip per output socket, writing the
 * same `setNodePreview` field as NodeActions' rows (`preview={false}` there).
 * Why: docs/dev/images-and-textures.md; pinned by previewChannelRow.test.ts.
 */

/** Sockets printed as their first letter: `alpha` alone, so the row reads
 *  "Color R G B A". By socket ID, never by length ("Krāsa" stays whole). */
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

/** The ACTIVE channel: a ring, like the texture grid's selected cell. Drawn
 *  with `box-shadow`, NOT `outline`: an inline outline would replace the UA's
 *  focus ring on exactly the lit button. */
const activeButtonStyle = {
  ...buttonStyle,
  borderColor: 'var(--border-focus)',
  boxShadow: '0 0 0 1px var(--border-focus)',
  color: 'var(--text-primary)',
} as const;

export function PreviewChannelRow({ nodeId }: { nodeId: string }) {
  const language = useAppStore((s) => s.language);
  // The per-id selector every menu here uses (see menuShared's NodeActions).
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
              // The full name is ALWAYS there; the action is appended to it.
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
