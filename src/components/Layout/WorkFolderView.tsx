import type { ReactNode } from 'react';
import { formatKbMb } from '@/utils/formatSize';

/**
 * The Work folder's drawn parts — its list caret and one file row — apart from
 * the control itself, which is desktop-only (WorkFolder.tsx talks to the Tauri
 * bridge and is tree-shaken out of the web build). The intro window's stage
 * draws the folder from these same pieces (intro/FolderScene.tsx), so the web
 * build can show what the desktop app does without carrying its file code.
 */

/** The ▾ of the Save | ▾ split button. Inline SVG, not a glyph — the
 *  self-hosted woff2 subset may lack ▾. */
export function WorkFolderCaretIcon() {
  return (
    <svg viewBox="0 0 10 6" aria-hidden="true" focusable="false">
      <path d="M0 0h10L5 6z" />
    </svg>
  );
}

/** One shader in the folder. The FILE NAME is the label — this is a folder
 *  listing, and the name on disk is the one the user can find again outside
 *  the app; the size keeps the second slot. */
export function WorkFolderRow({
  fileName,
  sizeBytes,
  current,
  onClick,
  disabled,
  title,
  tabIndex,
}: {
  fileName: ReactNode;
  sizeBytes: number;
  /** The row the document on screen came from. */
  current: boolean;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  tabIndex?: number;
}) {
  return (
    <button
      type="button"
      className={`toolbar__local-row toolbar__wf-row${current ? ' toolbar__wf-row--current' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-current={current ? 'true' : undefined}
      title={title}
      tabIndex={tabIndex}
    >
      <span className="toolbar__local-os toolbar__wf-row-name">{fileName}</span>
      <span className="toolbar__local-detail">{formatKbMb(sizeBytes)}</span>
    </button>
  );
}
