import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { getNodeValues, getNodeExposedPorts } from '@/types';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { DragNumberInput } from '../inputs/DragNumberInput';
import { toggleExposedPort, usesExposedPorts } from '@/utils/exposedPorts';
import { asOneHistoryEntry } from '@/utils/historyGesture';
import { rowStyle, checkLabelStyle, checkStyle, nameFieldStyle } from './menuShared';
import { PaletteColorPicker } from '@/components/inputs/PaletteColorPicker';
import { useHistoryBracket } from '@/hooks/useHistoryBracket';

interface ParamRowProps {
  nodeId: string;
  /** A `def.defaultValues` key — on an opt-in-socket node also that socket's
   *  id — or the id of an input with no inline default, which draws its
   *  expose checkbox alone. */
  paramKey: string;
  /** What the row says. Absent: the raw key, which is what every generic row
   *  has always printed — and what a study session still sees on the Image
   *  node. */
  label?: string;
}

/** The decimal places DragNumberInput's edit field shows (`startEdit`:
 *  `String(roundTo(value, 4))`); Enter or a blur commits that text whether or
 *  not anything was typed. */
const EDIT_DECIMALS = 4;

/**
 * Whether committing `v` would only round away digits nobody typed: `v` is the
 * stored number as the edit field SHOWED it, and not the number itself. The
 * row then writes nothing — an imported Offset (the turn's pivot term makes it
 * 0.30358983848622445) would otherwise become 0.3036 on a click in and out,
 * with an undo entry, and no longer export back to the model's own KHR offset.
 * A commit of the exact stored number still writes, as the row always has.
 */
export function isRoundingOnlyCommit(v: number, stored: number): boolean {
  const f = 10 ** EDIT_DECIMALS;
  return v !== stored && v === Math.round(stored * f) / f;
}

/**
 * ONE parameter row of a node's settings menu: the expose-as-socket checkbox
 * (on an opt-in-socket node, `usesExposedPorts`), the label, and the control
 * the registry default's TYPE picks — a drag number, a colour picker for a
 * `#hex`, the text field of a Property node's `name`, and nothing for a
 * socket-only string default or an input with no default at all.
 *
 * NodeSettingsMenu draws every generic row through this, and the Image node's
 * Tile / Offset rows (ImageNodeSettings) are this same row with a label —
 * never a copy, so the write, the toggle and the history bracketing cannot
 * drift between the two menus that show them.
 *
 * Subscribes to its node by id (the idiom every settings menu here follows),
 * and writes it the way the generic menu always has: one `updateNodeData` per
 * change, which DragNumberInput and the colour picker coalesce per gesture.
 */
export function ParamRow({ nodeId, paramKey, label }: ParamRowProps) {
  const updateNodeData = useAppStore((s) => s.updateNodeData);
  const language = useAppStore((s) => s.language);
  // The property-name field fires one input event per keystroke — each would
  // otherwise pushHistory a full-graph structuredClone. Bracket the burst so a
  // rename lands as one undo entry (DragNumberInput brackets its own drags,
  // and the colour picker its own stream).
  const { bracket, closeBracket } = useHistoryBracket();
  const node = useAppStore((s) => s.nodes.find((n) => n.id === nodeId));
  if (!node) return null;

  const registryType = node.data.registryType;
  const def = NODE_REGISTRY.get(registryType);
  const defaults = def?.defaultValues;
  // An OWN entry only: the key is a registry id, but `in`/a bare index would
  // also answer for Object.prototype's names.
  const defaultVal =
    defaults && Object.prototype.hasOwnProperty.call(defaults, paramKey) ? defaults[paramKey] : undefined;
  // Only opt-in-socket nodes get expose/hide checkboxes. Everywhere else the
  // ports are always rendered, so a checkbox would be a dead switch whose
  // uncheck silently deletes edges.
  const showPortToggle = usesExposedPorts(def);
  const exposedPorts: string[] = getNodeExposedPorts(node);

  const handleValueChange = (key: string, value: string | number) => {
    // For the property name field, keep as string (don't parse as number)
    if (key === 'name' && (registryType === 'property_float' || registryType === 'property_color')) {
      updateNodeData(nodeId, {
        values: { ...getNodeValues(node), [key]: String(value) },
      });
      return;
    }
    const numVal = typeof value === 'number' ? value : parseFloat(value);
    updateNodeData(nodeId, {
      values: {
        ...getNodeValues(node),
        [key]: isNaN(numVal) ? value : numVal,
      },
    });
  };

  const handleTogglePort = (key: string) => {
    // `toggleExposedPort` deletes the hidden port's edges (its own pushHistory)
    // and is evaluated BEFORE `updateNodeData` (argument order), which pushes
    // again — two entries per click, the first of which lands on "socket still
    // exposed, wire already gone", a state the user never authored. One
    // bracket around the whole statement makes it one undoable act.
    asOneHistoryEntry(() => {
      updateNodeData(nodeId, { exposedPorts: toggleExposedPort(nodeId, exposedPorts, key) });
    });
  };

  const isColor = typeof defaultVal === 'string' && defaultVal.startsWith('#');
  const isPropertyName =
    paramKey === 'name' && (registryType === 'property_float' || registryType === 'property_color');
  const isPort = typeof defaultVal === 'string' && !defaultVal.startsWith('#') && !isPropertyName;
  /** An input with no inline default: a socket to expose, nothing to set. */
  const socketOnly = defaultVal === undefined;
  const currentValue = getNodeValues(node)[paramKey] ?? defaultVal;
  const isExposed = exposedPorts.includes(paramKey);

  return (
    <div style={rowStyle}>
      <label style={checkLabelStyle}>
        {showPortToggle && (
          <input
            type="checkbox"
            checked={isExposed}
            onChange={() => handleTogglePort(paramKey)}
            title={t('Expose as input socket', language)}
            style={checkStyle}
          />
        )}
        {label ?? paramKey}
      </label>
      {isPropertyName ? (
        <input
          type="text"
          value={String(currentValue)}
          onChange={(e) => { bracket(); handleValueChange(paramKey, e.target.value); }}
          onBlur={closeBracket}
          style={nameFieldStyle}
        />
      ) : isColor ? (
        // `history="bracket"`: handleValueChange -> updateNodeData ->
        // an unconditional pushHistory, so this is a real graph edit
        // and the picker owns the coalescing bracket the row used to
        // open by hand for the native input's per-frame stream.
        <PaletteColorPicker
          className="context-menu__color"
          history="bracket"
          value={String(currentValue)}
          onPick={(hex) => handleValueChange(paramKey, hex)}
        />
      ) : isPort || socketOnly ? null : (
        <DragNumberInput
          value={Number(currentValue)}
          onChange={(v) => {
            if (!isRoundingOnlyCommit(v, Number(currentValue))) handleValueChange(paramKey, v);
          }}
        />
      )}
    </div>
  );
}
