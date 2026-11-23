import { useMemo, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { isTunnelIn, tunnelLabelOf } from '@/utils/passThrough';
import { focusNode } from '../outputFocus';
import { entranceOf, portalRenameRefusal, relinkMakesLoop, unportalRefusal } from '../portalWire';
import { glideToPortalPartner, relinkExit, selectWholePortal, turnPortalBackIntoWires } from '../portalActions';
import { startPortalRename } from '../portalRename';
import { liveEntranceLabel, tunnelExitCount } from '../nodes/passThroughLook';

/**
 * A PORTAL END's right-click menu (docs/dev/canvas-interaction.md, "Portal";
 * owner, 2026-11-23: "keep it minimal"): Rename, Go to entrance / Go to
 * exits, Select whole portal, Turn back into wires, and — on a BROKEN exit
 * only — "Connect to a portal…", then the delete row every node menu ends on.
 *
 * A row that cannot act right now stays, INERT (aria-disabled plus a guard,
 * never `disabled`), and its tooltip says why. Every selector returns a
 * primitive, so an open menu re-renders nothing on an unrelated drag frame.
 */
export function PortalMenu({ nodeId }: { nodeId: string }) {
  const language = useAppStore((s) => s.language);
  const closeContextMenu = useAppStore((s) => s.closeContextMenu);
  const { fitView } = useReactFlow();
  const isEntrance = useAppStore((s) => isTunnelIn(s.nodes.find((n) => n.id === nodeId)));
  // The entrance this end belongs to — itself, or a live exit's; null = broken.
  const entranceId = useAppStore((s) => entranceOf(s.nodes, nodeId)?.id ?? null);
  const name = useAppStore((s) => {
    const own = s.nodes.find((n) => n.id === nodeId);
    return (entranceId === null ? null : liveEntranceLabel(s.nodes, entranceId)) ?? (own ? tunnelLabelOf(own) : '');
  });
  const exitCount = useAppStore((s) => (entranceId === null ? 0 : tunnelExitCount(s.nodes, entranceId)));
  const unportal = useAppStore((s) => unportalRefusal(s.nodes, nodeId));
  const [picking, setPicking] = useState(false);
  const broken = entranceId === null;

  // A broken exit has no name to edit; an entrance in a COLLAPSED group has
  // no card for the in-place field to open on (portalWire.ts).
  const renameRefusal = useAppStore((s) => portalRenameRefusal(s.nodes, nodeId));
  const renameInert = renameRefusal !== null;
  const entranceHidden = renameRefusal === 'collapsed';

  const goneTip = t('Its Portal In is gone', language);

  const run = (inert: boolean, act: () => void) => () => {
    if (inert) return;
    act();
  };

  const rename = run(renameInert, () => {
    closeContextMenu();
    if (!isEntrance) focusNode(fitView, useAppStore.getState().nodes, entranceId!);
    startPortalRename(entranceId!);
  });

  const goNoWhere = isEntrance ? exitCount === 0 : broken;
  const go = run(goNoWhere, () => {
    glideToPortalPartner(nodeId, fitView);
    closeContextMenu();
  });

  const selectAll = run(broken, () => {
    selectWholePortal(nodeId);
    closeContextMenu();
  });

  const unportalTip =
    unportal === 'broken' ? goneTip
    : unportal === 'collapsed' ? t('Open the group first', language)
    : t('Draw the hidden wire again, from what goes in to everything that comes out, and remove the portal', language);
  const unportalRun = run(unportal !== null, () => {
    turnPortalBackIntoWires(nodeId);
    closeContextMenu();
  });

  // "Connect to a portal…": every entrance, by name; one that would close a
  // loop (something this exit feeds reaches it) stays inert. Read when the
  // list opens — the menu is short-lived.
  const choices = useMemo(() => {
    if (!picking) return [];
    const { nodes, edges } = useAppStore.getState();
    return nodes
      .filter(isTunnelIn)
      .map((n) => ({ id: n.id, name: tunnelLabelOf(n), loop: relinkMakesLoop(nodes, edges, nodeId, n.id) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [picking, nodeId]);

  const remove = () => {
    const store = useAppStore.getState();
    store.removeNode(nodeId);
    store.closeContextMenu();
  };

  return (
    <div className="context-menu__list">
      <div className="context-menu__category">{t(isEntrance ? 'Portal In' : 'Portal Out', language)}</div>
      {name && (
        <div style={{ padding: 'var(--space-1) var(--space-3)', fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
          {name}
        </div>
      )}
      <button
        className="context-menu__item context-menu__item--inert"
        aria-disabled={renameInert || undefined}
        title={
          broken ? goneTip
          : entranceHidden ? t('Open the group first', language)
          : t('Give the portal a new name. Its Portal Outs show it too', language)
        }
        onClick={rename}
      >
        {t('Rename', language)}
      </button>
      <button
        className="context-menu__item context-menu__item--inert"
        aria-disabled={goNoWhere || undefined}
        title={
          isEntrance
            ? exitCount === 0 ? t('This portal has no Portal Out yet', language) : t('Show every Portal Out of this portal', language)
            : broken ? goneTip : t('Show this portal’s Portal In', language)
        }
        onClick={go}
      >
        {t(isEntrance ? 'Go to exits' : 'Go to entrance', language)}
      </button>
      <button
        className="context-menu__item context-menu__item--inert"
        aria-disabled={broken || undefined}
        title={broken ? goneTip : t('Select the Portal In and every Portal Out', language)}
        onClick={selectAll}
      >
        {t('Select whole portal', language)}
      </button>
      <button
        className="context-menu__item context-menu__item--inert"
        aria-disabled={unportal !== null || undefined}
        title={unportalTip}
        onClick={unportalRun}
      >
        {t('Turn back into wires', language)}
      </button>
      {broken && (
        <>
          <button
            className="context-menu__item"
            aria-expanded={picking}
            title={t('Pick a Portal In for this Portal Out', language)}
            onClick={() => setPicking((p) => !p)}
          >
            {t('Connect to a portal…', language)}
          </button>
          {picking && choices.length === 0 && (
            <div style={{ padding: 'var(--space-1) var(--space-3)', fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
              {t('There is no Portal In yet', language)}
            </div>
          )}
          {picking && choices.map((c) => (
            <button
              key={c.id}
              className="context-menu__item context-menu__item--inert"
              style={{ paddingLeft: 'var(--space-6)' }}
              aria-disabled={c.loop || undefined}
              title={c.loop ? t('This would make a loop', language) : c.name}
              onClick={run(c.loop, () => {
                relinkExit(nodeId, c.id);
                closeContextMenu();
              })}
            >
              <span>{c.name || t('Portal In', language)}</span>
            </button>
          ))}
        </>
      )}
      <div className="context-menu__divider" />
      <button className="context-menu__item context-menu__item--danger" onClick={remove}>
        {t('Delete Node', language)}
      </button>
    </div>
  );
}
