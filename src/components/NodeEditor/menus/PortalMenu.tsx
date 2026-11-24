import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { useAppStore } from '@/store/useAppStore';
import { t, type Language } from '@/i18n';
import { isTunnelIn, tunnelLabelOf } from '@/utils/passThrough';
import { PORTAL_NAME_MAX } from '@/utils/portalNames';
import { entranceOf, portalNameToCommit, portalRenameRefusal, relinkMakesLoop, unportalRefusal } from '../portalWire';
import { glideToPortalPartner, relinkExit, renamePortal, selectWholePortal, turnPortalBackIntoWires } from '../portalActions';
import { liveEntranceLabel, tunnelExitCount } from '../nodes/passThroughLook';

/**
 * The portal's NAME, as the editable field at the top of a portal end's menu
 * (owner, 2026-11-24: "right click, and there should be a box at the top to
 * write a name"). An exit's field names its ENTRANCE. Typing edits the field
 * only; Enter, a click away (blur) or the menu closing COMMITS — `renamePortal`:
 * cleaned, capped, unique among the entrances, every exit's cache in the SAME
 * undo entry — and ONLY what the user typed (`portalNameToCommit`): opening
 * and closing the menu writes nothing, even over a stored name that is not
 * clean (StrictMode's extra mount/unmount pair, a blur with nothing typed).
 * Escape reverts and closes the menu without a write.
 *
 * READ-ONLY on a broken exit or while the entrance is in a collapsed group
 * (`portalRenameRefusal`) — `readOnly`, never `disabled`: it still takes the
 * focus when the menu opens, so it is still the typing target that keeps every
 * canvas key out (a disabled or unfocused field let A then X select and delete
 * every node behind the open menu), and it says why in a visible line under it.
 * No tooltip on the field: it opened at once and covered the rows below.
 */
function PortalNameField({
  entranceId,
  name,
  readOnlyReason,
  language,
  onClose,
  autoFocus,
}: {
  entranceId: string | null;
  name: string;
  /** Why the name cannot be edited here, or null when it can. */
  readOnlyReason: string | null;
  language: Language;
  onClose: () => void;
  /** Take the focus on mount: only the menu's FIRST field does — one started
   *  over after a commit must not pull the focus back from a row. */
  autoFocus: boolean;
}) {
  const [value, setValue] = useState(name);
  // What the user TYPED, or null while they have typed nothing: the only
  // text a commit may write.
  const typedRef = useRef<string | null>(null);
  // Committed or cancelled since the field last took focus: nothing more to do.
  const settled = useRef(false);
  const commit = () => {
    if (settled.current) return;
    settled.current = true;
    const next = portalNameToCommit(name, typedRef.current);
    if (next !== null && readOnlyReason === null && entranceId !== null) renamePortal(entranceId, next);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  // The menu closing (a press anywhere else unmounts it, often before a blur
  // can fire) commits what was typed. Re-armed on every mount, so StrictMode's
  // extra mount/unmount pair settles nothing.
  useEffect(() => {
    settled.current = false;
    return () => commitRef.current();
  }, []);
  const readOnly = readOnlyReason !== null;
  const reasonId = useId();
  return (
    <>
      <input
        className={`context-menu__search portal-menu__name${readOnly ? ' portal-menu__name--readonly' : ''}`}
        value={value}
        maxLength={PORTAL_NAME_MAX}
        readOnly={readOnly}
        spellCheck={false}
        autoFocus={autoFocus}
        aria-label={t('Portal name', language)}
        aria-describedby={readOnly ? reasonId : undefined}
        placeholder={t('Portal name', language)}
        onFocus={(e) => {
          settled.current = false;
          e.currentTarget.select();
        }}
        onChange={(e) => {
          typedRef.current = e.target.value;
          setValue(e.target.value);
        }}
        onKeyDown={(e) => {
          // The field's keys are its own: no menu or canvas shortcut sees
          // them — read-only or not.
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
            onClose();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            settled.current = true;
            typedRef.current = null;
            setValue(name);
            onClose();
          }
        }}
        onBlur={commit}
      />
      {readOnly && (
        <div id={reasonId} className="portal-menu__name-reason">
          {readOnlyReason}
        </div>
      )}
    </>
  );
}

/**
 * A PORTAL END's right-click menu (docs/dev/canvas-interaction.md, "Portal";
 * owner, 2026-11-23: "keep it minimal"): the NAME FIELD at the top (owner,
 * 2026-11-24, in place of the title and a Rename row), Go to entrance / Go to
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

  // A broken exit has no name to edit; an entrance in a COLLAPSED group is a
  // name the canvas cannot show (portalWire.ts `portalRenameRefusal`).
  const renameRefusal = useAppStore((s) => portalRenameRefusal(s.nodes, nodeId));

  const goneTip = t('Its Portal In is gone', language);
  // The name field takes the focus when the menu opens, never again.
  const firstField = useRef(true);
  useEffect(() => {
    firstField.current = false;
  }, []);

  const run = (inert: boolean, act: () => void) => () => {
    if (inert) return;
    act();
  };

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
    <>
      {/* Keyed on the live name: a rename made elsewhere (an undo while the
          menu is open) starts the field over from the new name. */}
      <PortalNameField
        key={`${entranceId ?? ''}\n${name}`}
        entranceId={entranceId}
        name={name}
        readOnlyReason={
          renameRefusal === 'broken' ? goneTip
          : renameRefusal === 'collapsed' ? t('Open the group first', language)
          : null
        }
        language={language}
        onClose={closeContextMenu}
        autoFocus={firstField.current}
      />
    <div className="context-menu__list">
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
    </>
  );
}
