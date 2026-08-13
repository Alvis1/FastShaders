import { useAppStore } from '@/store/useAppStore';
import { t, portLabel } from '@/i18n';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import {
  RAMP_COLOR_PORTS,
  effectiveExposedPorts,
  toggleExposedPort,
} from '@/utils/exposedPorts';
import { rowStyle } from './menuShared';

/**
 * "Receive as input" checkboxes for the two ramp ends of Data Stripes / Data
 * Viz — the opt-in colour sockets.
 *
 * Both nodes have their own bespoke settings menu (the generic
 * `NodeSettingsMenu` never opens for them), so the generic exposure loop cannot
 * reach them; this is the shared row pair both menus mount. Deliberately NOT a
 * copy in each menu: the two nodes carry the same ports and must not drift.
 *
 * Only the RAMP ports are offered. `baseFrequency`/`density` are stored numbers
 * with no matching `def.inputs` entry, so ticking them would author a socket
 * that never renders — the documented micNode trap.
 */
export function RampColorPorts({ nodeId }: { nodeId: string }) {
  const node = useAppStore((s) => s.nodes.find((n) => n.id === nodeId));
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const language = useAppStore((s) => s.language);
  if (!node) return null;

  const def = NODE_REGISTRY.get(node.data.registryType);
  const ports = def?.inputs.filter((inp) => RAMP_COLOR_PORTS.has(inp.id)) ?? [];
  if (ports.length === 0) return null;

  const exposed = effectiveExposedPorts(node);

  return (
    <>
      <div className="context-menu__category">{t('Colors', language)}</div>
      {ports.map((inp) => (
        <label key={inp.id} style={{ ...rowStyle, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={exposed.includes(inp.id)}
            // toggleExposedPort removes the port's edges when hiding it, and
            // pushes its own history entry.
            onChange={() =>
              updateNodeData(nodeId, {
                exposedPorts: toggleExposedPort(nodeId, exposed, inp.id),
              })
            }
            title={t('Expose as input socket', language)}
          />
          <span style={{ marginLeft: 6 }}>{portLabel(inp.label, language)}</span>
        </label>
      ))}
    </>
  );
}
