import { useMemo, useState } from 'react';
import type { Connection } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { t, portLabel, formatNodeLabel, type Language } from '@/i18n';
import { fillTemplate } from '@/utils/fillTemplate';
import { valueStr } from '@/utils/valueCoerce';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { isOutputNode, outputMaterials, outputNodes, readModelSignature, sectionLabel } from '@/utils/outputMaterials';
import { previewableOutputs } from '@/utils/nodePreview';
import { attachSinks, defaultAttachHandle, socketFeed } from '@/utils/nodeAttach';
import { outputOrdinals } from '../nodes/outputNodePlans';
import { formatSectionLabel } from '../nodes/sectionLabelText';
import { chipRowStyle, chipStyle, activeChipStyle, chipText } from './PreviewChannelRow';
import { labelStyle } from './menuShared';
import type { AppNode } from '@/types';

/**
 * The ATTACH list (utils/nodeAttach.ts): every socket of every Output on the
 * canvas, one block per Output, the rendering one first. Opened by Ctrl/⌘+click
 * on a node and by the Attach row of its right-click menu. Picking a socket
 * wires the node into it through `onAttach` — NodeEditor's one connect path —
 * and picking the socket this node already feeds UNWIRES it, so the list is
 * also the quickest way back out.
 */

const fromHeaderStyle = {
  ...labelStyle,
  display: 'block',
  padding: 'var(--space-2) var(--space-3) 2px',
} as const;

/** What a node's header says — the property name the user typed, else the
 *  generated var name, else its label: the name the canvas shows for it. */
function headerName(node: AppNode, varNames: Record<string, string>): string {
  const d = node.data as { registryType?: string; label?: string; values?: Record<string, unknown> };
  if ((d.registryType === 'property_float' || d.registryType === 'property_color') && d.values?.name) {
    return valueStr(d.values.name);
  }
  return varNames[node.id] ?? String(d.label ?? '');
}

/** A sink block's title, worded like the card: "Output_02 · Body" on a
 *  document with several Outputs, the plain label otherwise. */
function sinkTitle(node: AppNode, ordinals: ReadonlyMap<string, string>, language: Language): string {
  const type = String(node.data.registryType ?? '');
  const label = formatNodeLabel(NODE_REGISTRY.get(type)?.label ?? type, type, language, false);
  if (!isOutputNode(node) || !ordinals.has(node.id)) return label;
  const section = formatSectionLabel(
    sectionLabel(outputMaterials(node), 0, readModelSignature(node.data)),
    language,
  );
  return `${label}${ordinals.get(node.id)} · ${section}`;
}

export function AttachMenu({ nodeId, onAttach }: { nodeId: string; onAttach: (c: Connection) => void }) {
  const language = useAppStore((s) => s.language);
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const varNames = useAppStore((s) => s.nodeVarNames);
  const removeEdge = useAppStore((s) => s.removeEdge);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const node = nodes.find((n) => n.id === nodeId);
  // Read once, at open: the socket the list starts on. Later picks are local.
  const [handle, setHandle] = useState<string | null>(() =>
    node ? defaultAttachHandle(node, useAppStore.getState().nodePreview) : null,
  );
  const sinks = useMemo(() => attachSinks(nodes, edges), [nodes, edges]);
  const ordinals = useMemo(() => outputOrdinals(outputNodes(nodes)), [nodes]);

  if (!node || !handle) return null;
  const outs = previewableOutputs(node);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  /** "noise1", or "split1 · y" for a socket of a several-output node. */
  const feederName = (source: string, sourceHandle: string | null | undefined): string => {
    const src = byId.get(source);
    if (!src) return source;
    const name = headerName(src, varNames);
    const ports = previewableOutputs(src);
    if (ports.length < 2) return name;
    const port = ports.find((p) => p.id === sourceHandle);
    return port ? `${name} · ${portLabel(port.label, language)}` : name;
  };

  return (
    <div className="context-menu__list">
      {outs.length > 1 && (
        <>
          <span style={fromHeaderStyle}>{t('From socket', language)}</span>
          <div style={chipRowStyle}>
            {outs.map((port) => {
              const active = port.id === handle;
              const name = portLabel(port.label, language);
              return (
                <button
                  key={port.id}
                  type="button"
                  style={active ? activeChipStyle : chipStyle}
                  aria-pressed={active}
                  title={name}
                  onClick={() => setHandle(port.id)}
                >
                  {chipText(port.id, name)}
                </button>
              );
            })}
          </div>
        </>
      )}
      {sinks.length === 0 && (
        <>
          <div className="context-menu__category">{t('Attach', language)}</div>
          <button className="context-menu__item" disabled>
            {t('No Output on the canvas', language)}
          </button>
        </>
      )}
      {sinks.map(({ node: sink, sockets }) => (
        <div key={sink.id}>
          <div className="context-menu__category">
            {fillTemplate(t('Attach to {name}', language), { name: sinkTitle(sink, ordinals, language) })}
          </div>
          {sockets.map((socket) => {
            const feed = socketFeed(edges, sink.id, socket.id);
            const mine = !!feed && feed.source === nodeId && feed.sourceHandle === handle;
            const from = feed && !mine ? feederName(feed.source, feed.sourceHandle) : null;
            return (
              <button
                key={socket.id}
                className={`context-menu__item${mine ? ' context-menu__item--focused' : ''}`}
                aria-pressed={mine}
                title={
                  mine
                    ? t('Attached — click to detach', language)
                    : from
                      ? fillTemplate(t('Replaces the wire from {name}', language), { name: from })
                      : undefined
                }
                onClick={() => {
                  if (mine && feed) removeEdge(feed.id);
                  else onAttach({ source: nodeId, sourceHandle: handle, target: sink.id, targetHandle: socket.id });
                  closeContextMenu();
                }}
              >
                <span>{portLabel(socket.label, language)}</span>
                <span className="context-menu__item-category">{mine ? '✓' : from ?? ''}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
