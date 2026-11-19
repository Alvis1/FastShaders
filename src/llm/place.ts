/**
 * Placement: the ONE commit path for a generated group — the dialog's Add
 * click, nothing else. It is the dropped-shader ADD (engine/projectImport.ts
 * `addDroppedShader`) handed the gate's canonical text as a file, so a
 * generated group gets exactly what a dropped one does: the ingest sanitizers,
 * the Output left out (there is nothing to drive yet), fresh ids, one group
 * frame parked beside the graph, ONE undo entry, `fs:graph-merged`. A change
 * to that path changes this one; that coupling is the point
 * (docs/dev/node-generator.md).
 *
 * The canonical text is comment-free (no project block for the ADD to find),
 * Fn-shaped (scriptToTSL passes it through), carries no image payload and
 * parses with zero warnings — so the ADD parses exactly the graph the gate
 * verified.
 */
import { addDroppedShader } from '@/engine/projectImport';
import { useAppStore } from '@/store/useAppStore';

export type PlaceOutcome =
  | { ok: true; added: number; groupLabel: string }
  | { ok: false; reason: 'study' | 'no-shader' | 'nothing-to-add' | 'parse-failed' | 'over-budget' };

/** Longest group label taken from a prompt. */
export const MAX_GENERATED_LABEL = 40;

/**
 * The group's label: the request's first line, shortened. The ADD names a
 * group after the FILE's stem, which keeps only what follows the last `/` or
 * `\` — so those become spaces here, as do control characters.
 */
export function generatedStem(request: string): string {
  const firstLine = request.split(/\r\n|\r|\n/).find((l) => l.trim()) ?? '';
  const flat = firstLine
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F/\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return 'Generated';
  if (flat.length <= MAX_GENERATED_LABEL) return flat;
  const cut = flat.slice(0, MAX_GENERATED_LABEL);
  const space = cut.lastIndexOf(' ');
  return `${(space > 20 ? cut.slice(0, space) : cut).trim()}…`;
}

/** Park the gated program beside the graph and say so. Refuses in a study
 *  session — the feature is absent there. */
export async function addGeneratedGroup(tsl: string, request: string, inStudy: () => boolean): Promise<PlaceOutcome> {
  if (inStudy()) return { ok: false, reason: 'study' };
  const file = new File([tsl], `${generatedStem(request)}.js`, { type: 'text/javascript' });
  const r = await addDroppedShader(file);
  if (!r.ok) return { ok: false, reason: r.reason };
  useAppStore.getState().showImportNote([{ kind: 'generated-added', name: r.groupLabel, nodes: r.added }]);
  return { ok: true, added: r.added, groupLabel: r.groupLabel };
}
