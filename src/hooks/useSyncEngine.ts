import { useEffect, useRef, useCallback, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { panelCodegen } from '@/engine/panelCode';
import { isEvalMode } from '@/eval/evalMode';
import { onUnknownExpressionValidated, loadUnknownExpressionValidator } from '@/engine/unknownExpression';
// NB codeToGraph is deliberately NOT imported here — see doCodeSync, which
// pulls it in on demand so the Babel front end stays off the boot wave.
import { autoLayout } from '@/engine/layoutEngine';
import { computeReachableCost, sinkCosts, sinkBadgesStale, stampSinkCosts } from '@/utils/nodeCost';
import { activeSink, isSinkNode, hasActiveFlag, normalizeActiveOutput } from '@/utils/sdfPartition';
import { carryModelMeshes, isOutputNode } from '@/utils/outputMaterials';
import { carryMaterialSettings, pairResyncNodes, placeParsedOutputs } from '@/utils/resyncPairing';
import { carryInactiveSinks } from '@/utils/sinkCarry';
import { carryPanelHidden, inOldOrder, panelCarryIds, panelFeederResolver } from '@/utils/panelCarry';
import { carryDormantLightEdges, carrySplatLightValues } from '@/utils/splatLight';
import { carrySplatReplaceColor, splatStoredColor } from '@/utils/splatColor';
import { isDirectAssignmentCode } from '@/engine/evaluateTSLScript';
import { autoExposeConnectedParamPorts } from '@/utils/exposedPorts';
import { sameGraphSemantics } from '@/utils/graphSemantics';
import type { AppNode } from '@/types';
import { generateEdgeId } from '@/utils/idGenerator';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { previewGraph, resolveNodePreview } from '@/utils/nodePreview';
import { keepsNativeUndo } from '@/utils/isTypingTarget';


export function useSyncEngine() {
  const nodes = useAppStore((s) => s.nodes);
  const edges = useAppStore((s) => s.edges);
  const code = useAppStore((s) => s.code);
  const syncSource = useAppStore((s) => s.syncSource);
  const syncInProgress = useAppStore((s) => s.syncInProgress);
  const setCode = useAppStore((s) => s.setCode);
  const setNodes = useAppStore((s) => s.setNodes);
  const setEdges = useAppStore((s) => s.setEdges);
  const setCodeErrors = useAppStore((s) => s.setCodeErrors);
  const setSyncInProgress = useAppStore((s) => s.setSyncInProgress);
  const codeSyncRequested = useAppStore((s) => s.codeSyncRequested);
  // PREVIEW MODE (utils/nodePreview.ts) — see the graph→code pass below.
  const nodePreview = useAppStore((s) => s.nodePreview);
  const prevPreviewRef = useRef(nodePreview);

  // Track last synced code to prevent sync loops
  const lastSyncedCodeRef = useRef('');

  // Undo / Redo keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== 'z') return;
      // The graph is behind an open dialog: its keys are not the canvas's
      // (the guard useKeyboardNav and NodeEditor's accelerators use). Measured
      // 2026-10-11: Cmd+Z in the Feedback dialog's textarea undid the graph.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      // A text field keeps its own native undo; a number field and a select
      // keep graph undo (utils/isTypingTarget `keepsNativeUndo` says why).
      if (keepsNativeUndo(e.target)) return;

      const active = document.activeElement;
      if (active?.closest('.monaco-editor')) return;

      e.preventDefault();
      if (e.shiftKey) {
        useAppStore.getState().redo();
      } else {
        useAppStore.getState().undo();
      }
      // Clear cached code so graph→code sync regenerates after undo/redo
      lastSyncedCodeRef.current = '';
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const prevNodesRef = useRef(nodes);
  const prevEdgesRef = useRef(edges);

  // The `unknown`-expression validator loads ON DEMAND (engine/unknownExpression)
  // and codegen FAILS CLOSED until it lands, so the pass must run once more
  // when it does. Neither `nodes` nor `edges` changed then — hence the epoch,
  // threaded through both guards below. It fires at most once per session.
  const [exprEpoch, setExprEpoch] = useState(0);
  useEffect(() => onUnknownExpressionValidated(() => setExprEpoch((n) => n + 1)), []);
  const prevExprEpochRef = useRef(exprEpoch);

  // Graph → Code
  useEffect(() => {
    if (syncSource !== 'graph' || syncInProgress) return;
    const revalidated = exprEpoch !== prevExprEpochRef.current;
    prevExprEpochRef.current = exprEpoch;
    // Entering or leaving Preview mode (or switching node) changes what the
    // 3D view must render while `nodes`/`edges` stay exactly as they were —
    // the same shape as `revalidated`, threaded through both guards the same
    // way.
    const previewChanged = nodePreview !== prevPreviewRef.current;
    prevPreviewRef.current = nodePreview;
    if (!revalidated && !previewChanged && nodes === prevNodesRef.current && edges === prevEdgesRef.current) return;
    // Position/selection-only updates (every drag pointermove mints a new
    // array identity) can't change generated code — skip the whole pass, not
    // just the store writes. Never skip while isUndoRedo is set: this effect
    // doubles as the undo path's reconciliation point and must reach the
    // flag-clearing `finally` below (undo/redo structuredClones the arrays,
    // so its `data` refs are always fresh and the predicate is false anyway —
    // this guard covers the empty-graph corner where the scan is vacuous).
    const inert =
      !revalidated &&
      !previewChanged &&
      !useAppStore.getState().isUndoRedo &&
      sameGraphSemantics(prevNodesRef.current, nodes, prevEdgesRef.current, edges);
    prevNodesRef.current = nodes;
    prevEdgesRef.current = edges;
    if (inert) return;

    // NB this pass deliberately does NOT bracket itself with
    // `setSyncInProgress`. Its body is synchronous, so no other effect and no
    // render can interleave with it, and the two writes cost two whole store
    // notification rounds each pass — zustand re-runs EVERY subscribed
    // selector on every notify, and this pass runs on every frame of a value
    // scrub. Nothing observes the flag mid-body either: the ONLY readers are
    // this effect's own guard above and the codeSyncRequested effect below,
    // and `doCodeSync` (the path that really can overlap a render, since it
    // replaces the whole graph) still sets it. Re-entrancy here is already
    // covered by the `prevNodesRef`/`prevEdgesRef` identity check above —
    // `setCode('graph')` touches neither `nodes` nor `edges`, and re-writes
    // `syncSource` with the value the guard above already required it to have,
    // so none of this effect's deps changes value and it cannot re-trigger.
    try {
      // The panel shows only the nodes that FEED AN OUTPUT (engine/panelCode.ts)
      // — and so does the preview, which runs the same text: a dead chain is
      // dead code, so a Time node in one no longer keeps the preview drawing
      // and an unwired Image no longer crosses into it. Names are still the
      // whole graph's (`result.varNames`). A study session keeps the whole
      // panel, the editor its participants started with.
      const { result, emitted } = panelCodegen(nodes, edges, isEvalMode());
      // PREVIEW MODE: the 3D view renders the DERIVED graph — the previewed
      // socket routed to the Output's Color, every other sink input dropped
      // (utils/nodePreview.ts) — while `code` stays the real graph's, so the
      // panel, the export and the undo history never see the reroute. A
      // second codegen pass per edit for as long as the mode lasts, which is
      // milliseconds against a rebuild the preview debounces anyway. A target
      // whose node (or socket) is gone — deleted, undone, re-dropped — is
      // reconciled away HERE rather than at each of the paths that can
      // remove a node; the write re-runs this effect once with no preview.
      const live = resolveNodePreview(nodes, nodePreview);
      if (nodePreview && !live) useAppStore.getState().setNodePreview(null);
      let previewText: string | undefined;
      if (live) {
        const derived = previewGraph(nodes, edges, live);
        previewText = panelCodegen(derived.nodes, derived.edges, isEvalMode()).result.code;
      }
      // `nodeSpans` rides the same write: the panel's node → code highlight
      // (CodeEditor/useNodeCodeHighlight.ts) pairs it with THIS text only.
      // So do the whole graph's names: an Apply pairs and re-wires by them.
      setCode(result.code, 'graph', previewText, { emitted, names: result.varNames, nodeSpans: result.nodeSpans });
      lastSyncedCodeRef.current = result.code;
      // Update node variable names for display.
      //
      // NULL-PROTOTYPE map: node ids arrive verbatim from `.fastshader` files
      // and the `fs:graph` autosave, and seven node components read
      // `s.nodeVarNames[id]` and feed the answer into `varName ?? data.label`.
      // On a plain `{}` an id spelling `constructor`/`toString`/`valueOf`
      // resolves through the prototype chain to a FUNCTION, which is not
      // nullish, so it wins that `??` and reaches NodeTitle's
      // `String.prototype.replace` — a render-time TypeError with no error
      // boundary anywhere, i.e. a blank page that the 300 ms autosave then
      // makes permanent. Same rule the mesh-name maps follow.
      const names: Record<string, string> = Object.create(null);
      result.varNames.forEach((v, k) => { names[k] = v; });
      // A value scrub renames nothing, so this map is equal-but-new on every
      // frame of a drag while `setNodeVarNames` has no equality guard of its
      // own — writing it would spend a full notification round on an identity
      // no consumer reads (every one of them indexes it by node id and gets
      // back a string). The prototype test forces the FIRST write through even
      // on an empty map: the store seeds this field with a plain `{}`, which is
      // the hazard described above, so it must be replaced once regardless.
      const prevNames = useAppStore.getState().nodeVarNames;
      let namesChanged =
        Object.getPrototypeOf(prevNames) !== null ||
        Object.keys(prevNames).length !== result.varNames.size;
      if (!namesChanged) {
        for (const [k, v] of result.varNames) {
          if (prevNames[k] !== v) { namesChanged = true; break; }
        }
      }
      if (namesChanged) useAppStore.getState().setNodeVarNames(names);
    } finally {
      if (useAppStore.getState().isUndoRedo) {
        useAppStore.setState({ isUndoRedo: false });
      }
    }
  }, [nodes, edges, syncSource, syncInProgress, setCode, exprEpoch, nodePreview]);

  // Code → Graph (with stable node matching)
  const doCodeSync = useCallback(
    async (codeStr: string, skipHistory = false) => {
      // A code→graph pass ends Preview mode: `requestCodeSync` has already
      // put the panel's text on the preview, and with `syncSource` at 'code'
      // the graph→code effect above — the only thing that emits the
      // rerouted module — stays silent until the next graph edit. Left set,
      // the mode would read as on while the view showed the applied code,
      // then snap back to the reroute on the first scrub. Cleared before the
      // direct-assignment early return, since that path leaves the panel's
      // text on the preview too.
      useAppStore.getState().setNodePreview(null);
      if (isDirectAssignmentCode(codeStr)) {
        setCodeErrors([]);
        return;
      }

      // Armed ABOVE the await below: a graph edit landing inside the chunk
      // fetch must not regenerate the text this pass is about to parse.
      setSyncInProgress(true);
      try {
        // Dynamic on purpose: keeps the ~800 KB Babel chunk off the boot wave
        // (engine/unknownExpression.ts). Caught apart from the parse, so a
        // failed chunk fetch is reported in the panel and the graph is kept.
        let codeToGraph: typeof import('@/engine/codeToGraph').codeToGraph;
        try {
          ({ codeToGraph } = await import('@/engine/codeToGraph'));
          // Warm the `unknown`-expression validator off the SAME chunk: this
          // pass can mint unknown nodes, which the next graph→code pass would
          // otherwise emit as the fail-closed fallback. Not awaited.
          void loadUnknownExpressionValidator();
        } catch {
          setCodeErrors([
            {
              message: t('The TSL parser could not be loaded — reload the app and apply again.', useAppStore.getState().language),
              severity: 'error',
            },
          ]);
          return;
        }
        const result = codeToGraph(codeStr);
        const hasBlockingErrors = result.errors.some(e => e.severity !== 'warning');
        if (!hasBlockingErrors) {
          if (!skipHistory) {
            useAppStore.getState().pushHistory();
          }
          const oldNodes = useAppStore.getState().nodes;
          // Routing waypoints live on edge.data and aren't reconstructable from
          // the code text — carry them across the resync by matching edges on
          // their (source,sourceHandle,target,targetHandle) tuple, mirroring how
          // group nodes are preserved below. Keyed on the OLD node ids (the
          // remapped edges resolve back to those via idMap).
          const oldEdges = useAppStore.getState().edges;
          const waypointKey = (s: string, sh: string | null | undefined, t: string, th: string | null | undefined) =>
            `${s}\0${sh ?? 'out'}\0${t}\0${th ?? 'in'}`;
          const oldWaypoints = new Map<string, Array<{ x: number; y: number }>>();
          for (const oe of oldEdges) {
            const wps = (oe.data as { waypoints?: Array<{ x: number; y: number }> } | undefined)?.waypoints;
            if (wps && wps.length) {
              oldWaypoints.set(waypointKey(oe.source, oe.sourceHandle, oe.target, oe.targetHandle), wps);
            }
          }

          // Build ID mapping: newId → oldId (preserves React Flow identity)
          const idMap = new Map<string, string>();
          const positioned: AppNode[] = [];

          // The ACTIVE sink, which is the one PARKED sinks are told apart from
          // (utils/sdfPartition.ts `activeSink`; several output nodes may
          // coexist with exactly one active). Everything else about pairing —
          // the BINDING key an Output pairs on, and which old sinks may be
          // paired at all — is `utils/resyncPairing.ts`, pure so the swap it
          // prevents is an executable attack rather than a source pin.
          //
          // The `contributingOutputs(oldNodes)[0]` fallback that used to sit
          // here is GONE: it was there so an all-targeted document's parsed
          // Output had SOME partner and did not trip the
          // `unpositioned.length === 0` gate below, and both halves of that are
          // now done properly — every targeted Output is a pairing candidate on
          // its own, and `placeParsedOutputs` places an unpaired one instead of
          // relayouting the graph. The term could only ever name an arbitrary
          // targeted node "the active sink", which is the array-order election
          // the split retired.
          const oldActive = activeSink(oldNodes, unwrapCollapsedGroupEdges(oldNodes, oldEdges)) ?? null;

          // The CONNECTED-ONLY panel (engine/panelCode.ts): the text held only
          // the nodes in `codeEmitted`, so every other old node is carried
          // back whole (utils/panelCarry.ts) and may not be paired. Null — a
          // study session, no sink, a bare-script import — carries nothing.
          const scope = useAppStore.getState().codeEmitted;
          const carriedIds = panelCarryIds(oldNodes, scope);
          // The text's names (`codeNames`): pass 0 of the pairing and the
          // carried wires follow them. Null with the scope.
          const textNames = scope !== null ? useAppStore.getState().codeNames : null;

          // Merge a matched old node with a new node: preserve position + UI-only data
          const mergeMatch = (newNode: AppNode, match: AppNode): AppNode => {
            const merged = {
              ...newNode,
              id: match.id,
              position: { ...match.position },
              // The id is kept, so the selection is too: a selected node is
              // still selected (and its code still marked) after an Apply. Not
              // in a study, whose Apply is the one its sessions always met.
              ...(match.selected === true && !isEvalMode() ? { selected: true } : {}),
            };
            // The active flag is not in the code, so it can only come from
            // the old node — and only if it was really there: an implicit
            // (unflagged) active sink must stay unflagged, or an Apply would
            // stamp a key onto a document that never had a choice made.
            if (isSinkNode(match) && hasActiveFlag(match)) {
              (merged.data as Record<string, unknown>).activeOutput = true;
            }
            // Preserve exposedPorts from the old node — mostly not
            // reconstructed by codeToGraph. For the OUTPUT node, union in the
            // channels that carry STORED VALUES in the new parse (an inline
            // `metalness: float(0.9)` typed in the code panel must stay
            // visible — its emission is exposure-gated, so hiding it would
            // silently drop the very line the user just typed on the next
            // graph→code pass). ONLY the valued channels, never the parse's
            // whole seeded list: that list includes the implicit defaults,
            // and unioning those resurrected a default channel the user had
            // explicitly hidden in the Output node’s settings menu.
            // Carry the old OUTPUT node's stored channel values for channels
            // that are WIRED in the new parse. A wired channel's stored value
            // cannot appear in the code text (the edge ref wins at emission),
            // so the parse can never legitimately clear it — without this,
            // any code-panel Apply wiped the value the widget deliberately
            // retains under a wire, and a later disconnect landed on UNSET
            // instead of the user's number/color. Unwired channels stay
            // code-authoritative: literal present → value, absent → cleared.
            if (merged.data.registryType === 'output') {
              const oldValues = (match.data as { values?: Record<string, string | number> })
                .values;
              if (oldValues) {
                const carried = {
                  ...((merged.data as { values?: Record<string, string | number> }).values ?? {}),
                };
                let changed = false;
                for (const [ch, v] of Object.entries(oldValues)) {
                  const wired = result.edges.some(
                    (e) => e.target === newNode.id && e.targetHandle === ch,
                  );
                  if (carried[ch] === undefined && wired) {
                    carried[ch] = v;
                    changed = true;
                  }
                }
                if (changed) {
                  (merged.data as Record<string, unknown>).values = carried;
                }
              }
            }
            // A Splat Output's values the module cannot carry — the light's,
            // all of them while the parsed node is unlit (a dormant light) and
            // a wired socket's value while lit (utils/splatLight.ts), and
            // `replaceColor` while Color is neither wired nor stored, the one
            // case its return reads the same in both modes (utils/splatColor.ts).
            if (merged.data.registryType === 'splatOutput') {
              const oldValues = (match.data as { values?: unknown }).values;
              if (oldValues && typeof oldValues === 'object') {
                const old = oldValues as Record<string, unknown>;
                const wiredIn = (port: string) => result.edges.some((e) => e.target === newNode.id && e.targetHandle === port);
                const parsedValues = (merged.data as { values?: Record<string, unknown> }).values ?? {};
                const lit = carrySplatLightValues(parsedValues, old, wiredIn) ?? parsedValues;
                const colorFed = wiredIn('color') || splatStoredColor(lit.color) !== null;
                const carried = carrySplatReplaceColor(lit, old, colorFed) ?? lit;
                if (carried !== parsedValues) (merged.data as Record<string, unknown>).values = carried;
              }
            }
            const oldExposed = (match.data as { exposedPorts?: string[] }).exposedPorts;
            if (oldExposed) {
              let next: string[] = oldExposed;
              if (merged.data.registryType === 'output') {
                const valued = Object.keys(
                  (merged.data as { values?: Record<string, unknown> }).values ?? {},
                );
                if (valued.length > 0) {
                  next = Array.from(new Set([...oldExposed, ...valued]));
                }
              }
              (merged.data as Record<string, unknown>).exposedPorts = next;
            }
            // Preserve materialSettings on output nodes, PER KEY
            // (utils/resyncPairing.ts `carryMaterialSettings`): the four the
            // loader applies per part are code-authoritative on a TARGETED node
            // — they ARE its `parts` body — and carried on the untargeted
            // default, whose settings never appear in editor code at all;
            // `displacementMode` / `mergeVertices` are never in the code for
            // either and are always carried. A whole-object overwrite was right
            // only while ONE node held every material: split, it put back the
            // Transparent the user had just deleted from a part's body.
            //
            // One deliberate overlap survives: a TARGETED material 0 emits its
            // settings inside its part, and the Apply normalizes it into "empty
            // default + that material" — so the material parses them AND the
            // default inherits them, exactly as it inherits its exposedPorts,
            // so the BUILT module is byte-identical across the Apply. That copy
            // is inert ONLY while the default contributes no channel:
            // buildShaderModule always writes it as the module's top-level
            // keys, and loader 0.6/0.8 builds a default material only for a
            // module with a top-level channel. The moment the default gets one
            // (a wire, or a stored value that emits), every mesh no part claims
            // adopts these settings — though the user set them for the one mesh
            // material 0 used to name. It is visible, and editable, in that
            // node's settings menu.
            carryMaterialSettings(merged, match);
            // The index sections' loader-0.6 mirror source (`modelMeshes`) is
            // MODULE-ONLY (materialPartsContract R7) and never in the code, so
            // the parse cannot re-create it. It is carried while the PARSED
            // signature equals the old one; a signature edited in the code
            // panel describes a different model, so its mirrors are dropped.
            if (merged.data.registryType === 'output') carryModelMeshes(merged, match);
            return merged;
          };

          // Pass 1 (exact key, the BINDING for an Output) then pass 2
          // (registryType alone) — `pairResyncNodes`, which returns them in
          // that order so the merged list is built exactly as it always was.
          const pairing = pairResyncNodes(oldNodes, result.nodes, oldActive?.id ?? null, carriedIds, textNames);
          for (const { node, match } of pairing.paired) {
            idMap.set(node.id, match.id);
            positioned.push(mergeMatch(node, match));
          }

          // An unpaired plain OUTPUT is PLACED rather than laid out: one of
          // them relayouts the whole graph AND takes every group frame with it
          // (see the gate below), and after the Output split a single retyped
          // mesh name can mint one. Everything else keeps today's path.
          // `oldNodes` because `mergeMatch` above copies `id` and `position` and
          // nothing else: a positioned Output's FRAME lives only in the old
          // graph, and without it the placement compares — and writes —
          // parent-relative numbers as if they were absolute.
          const { placed, rest } = placeParsedOutputs(positioned, pairing.unpaired, oldNodes);
          positioned.push(...placed);
          const unpositioned: AppNode[] = rest;

          // Remap edges to use preserved node IDs, then drop any edge whose
          // endpoint doesn't resolve to an actual parsed node — defensive
          // against parser changes; today the parser only emits self-consistent
          // edges, but the cost of one Set membership check is worth it.
          const parsedNodeIds = new Set(result.nodes.map((n) => n.id));
          const remappedEdges = result.edges
            .filter((e) => parsedNodeIds.has(e.source) && parsedNodeIds.has(e.target))
            .map((e) => {
              const src = idMap.get(e.source) ?? e.source;
              const tgt = idMap.get(e.target) ?? e.target;
              const wps = oldWaypoints.get(waypointKey(src, e.sourceHandle, tgt, e.targetHandle));
              return {
                ...e,
                source: src,
                target: tgt,
                id: generateEdgeId(src, e.sourceHandle ?? 'out', tgt, e.targetHandle ?? 'out'),
                ...(wps ? { data: { ...e.data, dataType: e.data?.dataType ?? 'any', waypoints: wps } } : {}),
              };
            });

          // Unwrapped, so every carry below matches graphToCode's own reading
          // of the old graph (see the orphan carry for why a raw read is wrong).
          const realOldEdges = unwrapCollapsedGroupEdges(oldNodes, oldEdges);
          // What the parse produced, under the ids it now carries — what a
          // carried node may still be wired from, and the next Apply's scope.
          const parseIds = new Set([...positioned, ...unpositioned].map((n) => n.id));
          // The panel's hidden nodes, BEFORE the layout decision: a relayout
          // (a node typed in the panel) lays them out with the rest rather
          // than deleting them. Their wires from the text's nodes follow the
          // feeder's NAME (panelFeederResolver), so a paste keeps them bound as
          // if their lines were still in the text; only an import, which nulls
          // `codeEmitted`, carries nothing.
          const feederOf = panelFeederResolver(oldNodes, [...positioned, ...unpositioned], textNames);
          const hidden = carryPanelHidden(oldNodes, realOldEdges, carriedIds, feederOf, unpositioned.length > 0);
          remappedEdges.push(...hidden.edges);

          let finalNodes: AppNode[];
          if (unpositioned.length > 0) {
            // New or changed nodes — auto-layout ALL to maintain left-to-right flow
            finalNodes = autoLayout([...positioned, ...unpositioned, ...hidden.nodes], remappedEdges);
          } else {
            finalNodes = [...positioned, ...hidden.nodes];
          }

          // Preserve ORPHANED PROPERTY NODES — the same problem as groups, from
          // the other direction. graphToCode deliberately emits nothing for a
          // property whose output feeds nothing (so it cannot advertise a
          // schema key and an `<a-entity>` attribute that change no pixel), and
          // codeToGraph can only build what is in the text — so without this an
          // Apply DELETES the property node you dropped a moment ago and had
          // not wired up yet. Measured before this existed: a graph with an
          // unwired `cutoff` came back holding only the wired property.
          //
          // The carry is safe because it is precise about WHY the node is
          // missing. A property the user deleted by hand had a `uniform(...)`
          // line to delete; one that was never emitted cannot have been removed
          // from the code, because it was never in it. So the test is exactly:
          // it existed, it has no outgoing edge (which is why it was skipped),
          // and the parse did not produce it.
          //
          // Skipped when autoLayout ran, mirroring the group rule below and for
          // the same reason: that path means a bare script was imported, so the
          // "old" graph is a different shader and its leftovers do not belong in
          // it. This runs BEFORE the group block so carried nodes inherit its
          // dangling-parentId cleanup, and so a group whose only surviving
          // member is a carried property is itself kept.
          if (unpositioned.length === 0) {
            const survivingIds = new Set(finalNodes.map((n) => n.id));
            // `realOldEdges` (above) is unwrapped, so the test matches
            // graphToCode's own decision exactly: a collapsed group rewrites
            // its boundary edges to synthetic group sockets, so a raw read
            // would see a property feeding OUT of a collapsed group as having
            // no consumer, call it an orphan, and carry a duplicate of a node
            // the parse legitimately produced. The panel carry above already
            // brought every orphan back (none is emitted), so this one now
            // matters where `codeEmitted` is null.
            const hasConsumer = new Set(realOldEdges.map((e) => e.source));
            const orphanProps = oldNodes.filter(
              (n) =>
                (n.data.registryType === 'property_float' ||
                  n.data.registryType === 'property_color') &&
                !hasConsumer.has(n.id) &&
                !survivingIds.has(n.id),
            );
            if (orphanProps.length > 0) finalNodes = [...finalNodes, ...orphanProps];

            // Preserve INACTIVE OUTPUT NODES the same way — and their incoming
            // edges with them (utils/sinkCarry.ts, pure and tested). Uses the
            // UNWRAPPED old edges for the reason `realOldEdges` exists.
            //
            // A TARGETED Output normally comes back from its own `parts` entry
            // instead, so the carry must skip it — EXCEPT when the module holds
            // no plain Output at all, which is exactly what a driving Raymarch
            // Output emits (`outputs = marchNode ? [] : contributingOutputs`).
            // The question is asked of the PARSE, not of the old graph: a
            // module with no Output has nothing a carried node could duplicate,
            // while "did a march drive" would also resurrect a material the
            // user had just deleted from the code panel by hand.
            const parseHasPlainOutput = result.nodes.some(isOutputNode);
            const inactiveSinks = carryInactiveSinks(oldNodes, realOldEdges, oldActive?.id ?? null, survivingIds, parseHasPlainOutput);
            if (inactiveSinks.nodes.length > 0) {
              finalNodes = [...finalNodes, ...inactiveSinks.nodes];
              remappedEdges.push(...inactiveSinks.edges);
            }

            // Wires into an UNLIT Splat Output's Light sockets are in no line
            // of the module, so the parse cannot rebuild them (utils/splatLight.ts
            // `carryDormantLightEdges`, the edge half of the light-value carry
            // in `mergeMatch`). Inside this gate like every carry above: with
            // `unpositioned` nodes the old graph may be a different shader (a
            // bare-script import), where type-only pairing hands unrelated nodes
            // the old ids and would wire the new document's Light socket from
            // the previous one's feeder (review 2026-09-27). Before the
            // auto-expose below, so the carried socket stays on the node.
            const dormantLight = carryDormantLightEdges(
              oldNodes,
              finalNodes,
              realOldEdges,
              remappedEdges,
              new Set(finalNodes.map((n) => n.id)),
            );
            if (dormantLight.length > 0) remappedEdges.push(...dormantLight);
          }

          // The array order is the namer's (topologicalSort queues roots in
          // it): every surviving node goes back to its old place, or the
          // carried ones — appended above — rename the parsed ones on the next
          // pass and the panel's text changes under an unchanged Apply.
          if (scope !== null) finalNodes = inOldOrder(finalNodes, oldNodes);

          // Preserve group nodes from the old graph — codeToGraph doesn't know about
          // them, so they'd otherwise be lost on every Save. Carry over both the
          // group containers themselves AND any parentId/extent on members whose
          // ID survived the merge. Skip when autoLayout ran: positions are now
          // absolute and reattaching them as group-relative would put children in
          // the wrong place.
          const oldGroups =
            unpositioned.length > 0 ? [] : oldNodes.filter((n) => n.type === 'group');
          if (oldGroups.length > 0) {
            const oldById = new Map(oldNodes.map((n) => [n.id, n]));

            // Restore parentId/extent on surviving children whose old node had them.
            finalNodes = finalNodes.map((n) => {
              const old = oldById.get(n.id);
              if (!old || !old.parentId) return n;
              // Only re-attach if the parent group is also surviving (it always
              // should be since we re-add groups below, but guard regardless).
              const restored = { ...n, parentId: old.parentId } as AppNode;
              if ((old as { extent?: 'parent' }).extent) {
                (restored as { extent?: 'parent' }).extent = 'parent';
              }
              return restored;
            });

            // Append surviving group nodes — but keep them BEFORE their children
            // in the array, since React Flow requires parent-before-child ordering.
            const groupsToKeep = oldGroups.filter((g) =>
              // A group is worth keeping if it still has at least one child
              // among the surviving (or freshly created) nodes.
              finalNodes.some((n) => (n as { parentId?: string }).parentId === g.id),
            );
            // Drop dangling parentIds for any child whose group is not kept.
            const keptGroupIds = new Set(groupsToKeep.map((g) => g.id));
            finalNodes = finalNodes.map((n) => {
              const pid = (n as { parentId?: string }).parentId;
              if (pid && !keptGroupIds.has(pid)) {
                const { parentId: _p, extent: _e, ...rest } = n as AppNode & { parentId?: string; extent?: unknown };
                void _p; void _e;
                return rest as AppNode;
              }
              return n;
            });
            // Groups must come first; suppress duplicates and prepend.
            const groupIdSet = new Set(groupsToKeep.map((g) => g.id));
            const withoutGroups = finalNodes.filter((n) => !groupIdSet.has(n.id));
            // Note: surviving group nodes from oldNodes carry their original
            // position/width/height/data — that's exactly what we want.
            finalNodes = [...groupsToKeep, ...withoutGroups];
          }

          // Auto-expose ports that have incoming edges (so handles render).
          // Shared with the load/import paths — one predicate, one union rule
          // (incl. the Output node's implicit default channels).
          autoExposeConnectedParamPorts(finalNodes, remappedEdges);
          // Exactly one active sink, whatever the carry produced.
          finalNodes = normalizeActiveOutput(finalNodes);

          setNodes(finalNodes, 'code');
          setEdges(remappedEdges, 'code');
          // The text now on the panel is the one just parsed, and nothing
          // regenerates it on purpose (syncSource is 'code'), so the scope
          // must follow it: left at the pre-Apply set, a node typed in this
          // Apply and deleted before the next would be carried back.
          // The names with it: each parsed node's label is its declared name.
          // The ring of older passes' scopes is done with — the text on the
          // panel is this one now.
          if (scope !== null) {
            useAppStore.setState({
              codeEmitted: parseIds,
              codeNames: new Map([...positioned, ...unpositioned].map((n) => [n.id, String(n.data.label)] as const)),
              codeScopes: [],
            });
          }
        }
        if (!skipHistory) {
          setCodeErrors(result.errors);
        }
      } finally {
        setSyncInProgress(false);
      }
    },
    [setNodes, setEdges, setCodeErrors, setSyncInProgress]
  );

  // Code → Graph (manual Save trigger)
  useEffect(() => {
    if (!codeSyncRequested || syncInProgress) return;
    useAppStore.setState({ codeSyncRequested: false });

    // Skip code→graph sync if the code hasn't been manually edited
    // (i.e. it was generated from the graph — nothing to parse back)
    if (code === lastSyncedCodeRef.current) return;

    lastSyncedCodeRef.current = code;
    // Fire-and-forget: doCodeSync is async only because it fetches the parser
    // chunk, it owns its own error reporting, and there is nothing here to do
    // once it lands — `syncInProgress` is what the rest of the hook waits on.
    void doCodeSync(code);
  }, [codeSyncRequested, syncInProgress, doCodeSync, code]);

  // Recalculate complexity (use ref to avoid double-run when updating output node cost)
  const lastCostRef = useRef(-1);
  const prevCostGraphRef = useRef<{ nodes: AppNode[]; edges: typeof edges } | null>(null);
  useEffect(() => {
    // Same inert-frame skip as the graph→code effect above: cost reads node
    // data + reachability only, so a position/selection-only identity change
    // would re-run the BFS for an answer that cannot differ.
    const prev = prevCostGraphRef.current;
    prevCostGraphRef.current = { nodes, edges };
    if (prev && sameGraphSemantics(prev.nodes, nodes, prev.edges, edges)) return;

    // Reachable-cost BFS lives in nodeCost.ts (shared with the store's device
    // selection, so activating a measured cost profile reprices the total even
    // though it doesn't change nodes/edges). Reads the override-aware ACTIVE table.
    // Same entry-point unwrap graphToCode and cpuEvaluator do: collapse state
    // must not change the compiled output, and it must not change the budget.
    const unwrapped = unwrapCollapsedGroupEdges(nodes, edges);
    // Seed omitted, i.e. `costSeeds` — the ONE answer to "which sinks does the
    // total price", shared with the store's device selection so the two can
    // never walk different sets. This used to resolve `activeSink` here and
    // hand it to `sinkCosts` below as an already-priced entry, saving one
    // reverse-BFS; that shortcut assumed the total IS one sink's subtree, and
    // it stops being true as soon as several Outputs contribute — the union
    // price would land on one node's badge.
    const total = computeReachableCost(nodes, unwrapped);

    if (total === lastCostRef.current) return;
    lastCostRef.current = total;

    // Collapse the `totalCost` write and the output-node cost writes into a
    // single setState so we don't re-enter this effect twice for one change.
    //
    // Every sink carries its OWN price (`sinkCosts`): an Output's badge is
    // what the shader would cost with it active — so two candidate outputs can
    // be compared before one is clicked.
    const perSink = sinkCosts(nodes, unwrapped);
    const needsOutputUpdate = sinkBadgesStale(nodes, perSink);
    useAppStore.setState((state) => ({
      totalCost: total,
      ...(needsOutputUpdate ? { nodes: stampSinkCosts(state.nodes, perSink) } : {}),
    }));

    // The badge write mints a fresh `nodes` array AND a fresh `data` ref on
    // every sink it touches, and `sameGraphSemantics` treats a changed `data`
    // ref as a real change — so without this the graph→code effect above would
    // re-run graphToCode (1-2 ms at a few hundred nodes) plus a setCode round
    // over a graph whose ONLY difference is a cost badge codegen never reads,
    // and this effect would re-run its own BFS to reach the `total ===
    // lastCostRef.current` bail. Stamping both refs with the array we just
    // wrote makes each of them recognise its own write and bail on the cheap
    // identity check instead.
    //
    // Gated on `prevNodesRef.current === nodes`, which is true exactly when the
    // graph→code effect has already consumed THIS array (it stamps the ref
    // before its own inert bail). When it bailed earlier — `syncSource` is
    // 'code', or a sync is in progress — the ref still points at an older
    // array, and stamping then would suppress a codegen pass that has yet to
    // happen.
    if (needsOutputUpdate && prevNodesRef.current === nodes) {
      const stamped = useAppStore.getState().nodes;
      prevNodesRef.current = stamped;
      prevCostGraphRef.current = { nodes: stamped, edges };
    }
  }, [nodes, edges]);
}
