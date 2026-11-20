/**
 * The names a search box already answers to, for the prompt detector
 * (utils/promptDetect.ts): a query that runs along one of them is someone
 * typing that name, never a request for the AI.
 *
 * Node labels in both languages and their `Also:` aliases, the lesson titles
 * and the note's words — every registry node, switched off or not, since a
 * hidden node's name is still a name. The asset bar adds the preset, recipe
 * and texture names once their library has loaded, and the saved groups'.
 */
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { assetText, nodeLabelLV, t } from '@/i18n';
import { TUTORIALS } from '@/tutorials/tutorialDefs';
import { knownNameWords, type KnownNames } from '@/utils/promptDetect';

const NOTE_NAMES = ['note', 'add note', 'piezīme', 'pievienot piezīmi'];

function baseNames(): string[] {
  const out = [...NOTE_NAMES];
  for (const def of NODE_REGISTRY.values()) {
    out.push(def.label, nodeLabelLV(def.type));
    const aliases = def.description?.split(/\s*Also:/)[1];
    if (aliases) out.push(...aliases.split(','));
  }
  for (const d of TUTORIALS) out.push(d.title, t(d.title, 'lv'));
  return out;
}

let nodeNames: KnownNames | null = null;

/** Node, alias, lesson and note names — what the Space menu's search knows. */
export function knownNodeNames(): KnownNames {
  return (nodeNames ??= knownNameWords(baseNames()));
}

/** The same plus ready-made asset names (English; their Latvian is added
 *  here) — what the asset bar's search knows. */
export function knownNamesWith(assetNames: readonly string[]): KnownNames {
  const extra: string[] = [];
  for (const name of assetNames) {
    if (typeof name !== 'string') continue;
    extra.push(name, assetText(name, 'lv'));
  }
  return [...knownNodeNames(), ...knownNameWords(extra)];
}
