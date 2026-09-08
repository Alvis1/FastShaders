import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { getNodeValues } from '@/types';
import { isWireframeEdges, wireframeEdgesValue } from '@/utils/wireframeMode';
import { rowStyle, checkLabelStyle, checkStyle } from './menuShared';

/**
 * The Wireframe node's mode switch: draw the surface GRID, or the model's real
 * triangle EDGES.
 *
 * A `values.edges` flag on this node, not the registry `modes` mechanism —
 * that one is for module-helper variants, and `sdfModes.test.ts` requires every
 * moded def to round-trip byte-identically through codeToGraph, which a
 * hand-emitted node cannot do.
 *
 * It is deliberately NOT the material's own `wireframe` flag, which an earlier
 * cut of this checkbox wrote. That flag replaces the filled surface with line
 * primitives for the WHOLE material, so this node's lattice was then painted
 * onto those lines — reported as "the effect is not correct". The material mode
 * is a real thing and still lives in Shader Settings; this is the one that
 * belongs to the node, because it changes what the node COMPUTES.
 */
export function WireframeNodeSettings({ nodeId }: { nodeId: string }) {
  const language = useAppStore((s) => s.language);
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  // Subscribe to THIS node: React Flow reuses the objects it did not touch, so
  // Object.is bails on every notification that did not change it.
  const node = useAppStore((s) => s.nodes.find((n) => n.id === nodeId));
  if (!node) return null;

  const values = getNodeValues(node);
  const edges = isWireframeEdges(values);

  return (
    <>
      <div className="context-menu__divider" />
      <div style={rowStyle}>
        <label
          style={{ ...checkLabelStyle, cursor: 'pointer' }}
          title={t(
            'Draw the model’s real triangle edges instead of a grid on the surface. Same antialiasing and the same pixel width; Density does nothing in this mode. Needs the shader loader to add barycentric coordinates, which it does automatically.',
            language,
          )}
        >
          <input
            type="checkbox"
            checked={edges}
            onChange={(e) =>
              updateNodeData(nodeId, {
                values: { ...values, edges: wireframeEdgesValue(e.target.checked) },
              })
            }
            style={checkStyle}
          />
          {t('Follow the actual mesh', language)}
        </label>
      </div>
    </>
  );
}
