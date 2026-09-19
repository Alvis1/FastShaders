import { useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { getNodeValues } from '@/types';
import { rowStyle, labelStyle, checkLabelStyle, checkStyle, wideFieldStyle, NumberRow } from './menuShared';
import { readImageUvMapping, withUvMapping, type UvMappingPatch, type ImageUvSet } from '@/utils/imageUvMapping';

const summaryStyle = {
  fontSize: 'var(--font-size-xs)',
  color: 'var(--text-secondary)',
  marginLeft: 'var(--space-2)',
  whiteSpace: 'nowrap',
} as const;

/**
 * The Image node's "glTF mapping" block: orientation, UV set, the normal-map
 * green flip and the KHR_texture_transform — how a texture that came with a
 * model lands on that model's UVs (utils/imageUvMapping.ts).
 *
 * Collapsed by default, and a one-line summary says whether anything is set,
 * so today's dropped images (which carry none of it) gain one quiet row. The
 * open state is keyed by node id: a menu MOVED to another node by a second
 * right-click re-renders without remounting, and must not arrive expanded.
 *
 * It reads through `readImageUvMapping` and writes through `withUvMapping`
 * only — the one reader and the one writer — against the LIVE node, so a key
 * returned to its default is deleted rather than stored, and a node toggled
 * on and back off is JSON-identical to one never touched. Every select or
 * checkbox change is one `updateNodeData`, i.e. one undo entry; a typed
 * number is bracketed into one entry by NumberRow.
 *
 * Settings-menu only and hidden in study sessions (ImageNodeSettings gates
 * it); stored keys still emit there, because the gate is UI-only.
 */
export function ImageMappingSettings({ nodeId }: { nodeId: string }) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const language = useAppStore((s) => s.language);
  const node = useAppStore((s) => s.nodes.find((n) => n.id === nodeId));
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === nodeId;

  if (!node || node.data.registryType !== 'imageNode') return null;
  const m = readImageUvMapping(getNodeValues(node));

  const write = (patch: UvMappingPatch) => {
    const live = useAppStore.getState().nodes.find((n) => n.id === nodeId);
    if (!live || live.data.registryType !== 'imageNode') return;
    updateNodeData(nodeId, { values: withUvMapping(getNodeValues(live), patch) });
  };

  const parts: string[] = [];
  if (m.orientation === 'gltf') parts.push('glTF');
  if (m.uvSet > 0) parts.push(`UV ${m.uvSet}`);
  if (m.transform) parts.push(t('transform', language));
  if (m.normalGreenFlip) parts.push(t('green flipped', language));
  const summary = parts.length > 0 ? parts.join(', ') : t('default', language);

  const xf = m.transform;
  const rotationDeg = Math.round(((xf?.rotation ?? 0) * 180) / Math.PI * 1000) / 1000;

  return (
    <>
      <button
        type="button"
        className="context-menu__item"
        aria-expanded={open}
        onClick={() => setOpenFor(open ? null : nodeId)}
      >
        <span>{`${open ? '▾' : '▸'} ${t('glTF mapping', language)}`}</span>
        <span style={summaryStyle}>{summary}</span>
      </button>
      {open && (
        <>
          <div style={rowStyle}>
            <span
              style={labelStyle}
              title={t("How the image lies on the model's UVs. glTF: the way a texture that came with a .glb or .gltf model expects it (stored top-down, not mirrored). On the built-in shapes a glTF texture shows turned 180°.", language)}
            >
              {t('UV orientation', language)}
            </span>
            <select
              style={wideFieldStyle}
              value={m.orientation}
              onChange={(e) => write({ orientation: e.target.value === 'gltf' ? 'gltf' : 'app' })}
            >
              <option value="app">{t('FastShaders (default)', language)}</option>
              <option value="gltf">{t('glTF (as in the model)', language)}</option>
            </select>
          </div>
          <div style={rowStyle}>
            <span
              style={labelStyle}
              title={t("Which of the model's texture-coordinate sets to sample (glTF TEXCOORD_0–3). A model without that set shows one flat colour. A wired UV input replaces this.", language)}
            >
              {t('UV set', language)}
            </span>
            <select
              style={wideFieldStyle}
              value={String(m.uvSet)}
              onChange={(e) => {
                // A closed table, never Number(): only these four strings map.
                const next: ImageUvSet = e.target.value === '1' ? 1 : e.target.value === '2' ? 2 : e.target.value === '3' ? 3 : 0;
                write({ uvSet: next });
              }}
            >
              <option value="0">{t('UV 0 (default)', language)}</option>
              <option value="1">UV 1</option>
              <option value="2">UV 2</option>
              <option value="3">UV 3</option>
            </select>
          </div>
          <div style={rowStyle}>
            <label style={checkLabelStyle}>
              <input
                type="checkbox"
                checked={m.normalGreenFlip}
                onChange={() => write({ normalGreenFlip: !m.normalGreenFlip })}
                title={t("For a normal map on a model without tangent data (Blender's default glTF export): inverts the green channel the way three.js does for glTF. Only matters while this image is wired into the Output's Normal.", language)}
                style={checkStyle}
              />
              {t('Flip normal green (Y)', language)}
            </label>
          </div>
          <div
            className="context-menu__category"
            title={t("KHR_texture_transform: scales, then turns about the UV origin (0, 0), then offsets — applied before Flip, Tile and Offset. The UV node's rotation turns about the centre instead.", language)}
          >
            {t('Texture transform (glTF)', language)}
          </div>
          <NumberRow label={t('Offset U', language)} value={xf?.offsetX ?? 0} step={0.01} onCommit={(n) => write({ offsetX: n })} />
          <NumberRow label={t('Offset V', language)} value={xf?.offsetY ?? 0} step={0.01} onCommit={(n) => write({ offsetY: n })} />
          <NumberRow
            label={t('Rotation (°)', language)}
            value={rotationDeg}
            step={1}
            onCommit={(deg) => write({ rotation: (deg * Math.PI) / 180 })}
          />
          <NumberRow label={t('Scale U', language)} value={xf?.scaleX ?? 1} step={0.05} onCommit={(n) => write({ scaleX: n })} />
          <NumberRow label={t('Scale V', language)} value={xf?.scaleY ?? 1} step={0.05} onCommit={(n) => write({ scaleY: n })} />
        </>
      )}
    </>
  );
}
