import { useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { fillTemplate } from '@/utils/fillTemplate';
import { displayImageFileName } from '@/utils/imageNode';
import type { ImageConvertMode } from '@/utils/imageImport';
import {
  projectTextureSources,
  textureSourcesKey,
  MAX_LISTED_TEXTURE_SOURCES,
  type TextureSource,
} from '@/utils/textureSources';
import { rowStyle, labelStyle, wideFieldStyle, fieldStyle, hintStyle } from './menuShared';

/** The row button reads like the other wide fields but never wraps: a long
 *  file name is clipped, and its full spelling is the button's title. */
const pickerButtonStyle = {
  ...wideFieldStyle,
  cursor: 'pointer',
  textAlign: 'left',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

const answerStyle = { ...fieldStyle, width: 'auto', cursor: 'pointer' } as const;

/**
 * The `<img src>` a grid cell shows. Only a 'project' source exists today and
 * its `dataUrl` was whitelist-checked when `projectTextureSources` built it.
 * Phase 5's 'model' kind will need a display URL distinct from its payload (it
 * is not materialised until picked), so the `never` default makes that kind
 * fail to compile here until it says what to show.
 */
function thumbnailUrl(src: TextureSource): string {
  switch (src.kind) {
    case 'project':
      return src.dataUrl;
    default: {
      // `src.kind` narrows to never here; `src` itself would not while the
      // union has one member.
      const unhandled: never = src.kind;
      return unhandled;
    }
  }
}

interface Props {
  /** The node's stored payload ('' when it has none). */
  currentUrl: string;
  /** The node's stored file name (any type: it comes out of a .fastshader). */
  currentName: unknown;
  /** A resize or a file import is running on this node. */
  disabled: boolean;
  /** A "From file…" import is running (the button says so). */
  loading: boolean;
  onPick: (src: TextureSource) => void;
  onFile: (file: File, mode: ImageConvertMode) => void;
}

/**
 * The Image node's "Texture" row: a button that expands an inline thumbnail
 * grid of every image the project already holds, plus "From file…".
 *
 * Settings-menu only — never an on-node control (the thumbnail stays a
 * picture, and a press on it selects or drags the node like any card body) —
 * and hidden in study sessions by its caller. The grid lives INSIDE the menu
 * (no portal): the menu shell is `nowheel` and closes on an outside press, and
 * a portalled list would be outside both.
 *
 * The list is a cheap-key two-step selector, computed only while the grid is
 * open: the subscription is `textureSourcesKey` (a string, so a drag frame —
 * which replaces the nodes array — bails on `Object.is`), and the list itself
 * is rebuilt from `getState()` when that key moves. Closed, the key is '' and
 * the row costs nothing.
 *
 * "From file…" runs the canvas drop's pipeline into THIS node (the caller's
 * `onFile`). The drop asks its convert-or-keep question in a dialog; here the
 * same question is an inline row, because a portalled dialog is outside the
 * menu and the press answering it would close the menu under it. A remembered
 * answer (`fs:imageConvert`, the "Optimize on import" row below) skips it.
 */
export function TexturePicker({ currentUrl, currentName, disabled, loading, onPick, onFile }: Props) {
  const language = useAppStore((s) => s.language);
  const convertMode = useAppStore((s) => s.imageConvertMode);
  const [open, setOpen] = useState(false);
  /** A chosen file waiting for the convert-or-keep answer ('ask' mode). */
  const [askFile, setAskFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const key = useAppStore((s) => (open ? textureSourcesKey(s.nodes) : ''));
  const sources = useMemo(
    () => (open ? projectTextureSources(useAppStore.getState().nodes) : []),
    // `key` IS the subscription: the list is rebuilt when it moves.
    [open, key],
  );
  const shown = sources.slice(0, MAX_LISTED_TEXTURE_SOURCES);

  const chooseFile = (file: File) => {
    if (convertMode === 'always') onFile(file, 'convert');
    else if (convertMode === 'never') onFile(file, 'keep');
    else setAskFile(file);
  };
  const answer = (mode: ImageConvertMode) => {
    const file = askFile;
    setAskFile(null);
    if (file) onFile(file, mode);
  };

  const currentLabel = currentUrl ? displayImageFileName(currentName, currentUrl) : '';
  const buttonLabel = loading
    ? t('Loading image…', language)
    : currentLabel || t('No image', language);

  return (
    <>
      <div style={rowStyle}>
        <span
          style={labelStyle}
          title={t('Choose any image already in this project, or load one from a file. This node then uses that image; its own settings (colour space, filtering, flips) stay as they are.', language)}
        >
          {t('Texture', language)}
        </span>
        <button
          type="button"
          style={pickerButtonStyle}
          aria-expanded={open}
          disabled={disabled}
          title={currentLabel || undefined}
          onClick={() => setOpen(!open)}
        >
          {buttonLabel}
          {open ? ' ▴' : ' ▾'}
        </button>
      </div>
      {open && (
        <>
          {shown.length === 0 ? (
            <div style={rowStyle}>
              <span style={hintStyle}>{t('No images in this project yet.', language)}</span>
            </div>
          ) : (
            <div className="context-menu__texture-grid" role="listbox" aria-label={t('Texture', language)}>
              {shown.map((s, i) => (
                <button
                  key={`${s.kind}:${s.holderIds[0] ?? i}`}
                  type="button"
                  className="context-menu__texture-cell"
                  role="option"
                  aria-selected={s.dataUrl === currentUrl}
                  disabled={disabled}
                  title={`${displayImageFileName(s.fileName, s.dataUrl)} — ${s.width} × ${s.height}`}
                  onClick={() => onPick(s)}
                >
                  <img src={thumbnailUrl(s)} alt="" draggable={false} decoding="async" loading="lazy" />
                </button>
              ))}
            </div>
          )}
          {sources.length > MAX_LISTED_TEXTURE_SOURCES && (
            <div style={rowStyle}>
              <span style={labelStyle}>
                {fillTemplate(t('More images than fit here: {n}', language), {
                  n: sources.length - MAX_LISTED_TEXTURE_SOURCES,
                })}
              </span>
            </div>
          )}
          <button
            type="button"
            className="context-menu__item"
            disabled={disabled || askFile !== null}
            title={t('Load an image file into this node. It goes through the same conversion and size limits as dropping the file on the canvas, but fills this node instead of adding a new one.', language)}
            onClick={() => fileRef.current?.click()}
          >
            {t('From file…', language)}
          </button>
        </>
      )}
      {askFile && (
        <div style={rowStyle} title={askFile.name}>
          <span style={labelStyle}>{t('Convert image to optimized format?', language)}</span>
          <span style={{ display: 'flex', gap: 'var(--space-1)' }}>
            <button type="button" style={answerStyle} disabled={disabled} onClick={() => answer('convert')}>
              {t('Yes', language)}
            </button>
            <button type="button" style={answerStyle} disabled={disabled} onClick={() => answer('keep')}>
              {t('No', language)}
            </button>
          </span>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared so choosing the same file again still fires `change`.
          e.target.value = '';
          if (file) chooseFile(file);
        }}
      />
    </>
  );
}
