import { useEffect, useRef, useCallback, useState } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { graphToCode } from '@/engine/graphToCode';
import { onUnknownExpressionValidated, loadUnknownExpressionValidator } from '@/engine/unknownExpression';
// NB codeToGraph is deliberately NOT imported here — see doCodeSync, which
// pulls it in on demand so the Babel front end stays off the boot wave.
import { autoLayout } from '@/engine/layoutEngine';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { computeReachableCost } from '@/utils/nodeCost';
import { activeSink, isSinkNode, hasActiveFlag, normalizeActiveOutput } from '@/utils/sdfPartition';
import { carryModelMeshes, isOutputNode } from '@/utils/outputMaterials';
import { carryMaterialSettings, pairResyncNodes, placeParsedOutputs } from '@/utils/resyncPairing';
import { sinkCosts } from '@/utils/nodeCost';
import { carryInactiveSinks } from '@/utils/sinkCarry';
import { isDirectAssignmentCode } from '@/engine/evaluateTSLScript';
import { autoExposeConnectedParamPorts } from '@/utils/exposedPorts';
import { sameGraphSemantics } from '@/utils/graphSemantics';
import type { AppNode } from '@/types';
import { generateEdgeId } from '@/utils/idGenerator';
import { unwrapCollapsedGroupEdges } from '@/utils/edgeUtils';
import { previewGraph, resolveNodePreview } from '@/utils/nodePreview';


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

  // Codegen validates an `unknown` node's stored `rawExpression` with Babel
  // before emitting it verbatim, and that parser is loaded ON DEMAND so the
  // ~200 KB gzip of @babel/* stays off the boot wave (engine/unknownExpression).
  // A pass that runs before it lands FAILS CLOSED — the expression emits as the
  // inert fallback — so the pass has to run again once the real verdict exists.
  // Nothing else can trigger it: neither `nodes` nor `edges` changed, so both
  // the identity guard and sameGraphSemantics below would (correctly) call the
  // re-run inert. Hence the epoch, which is threaded through both of them.
  //
  // It fires at most once per session (the notifier fires once, when the chunk
  // lands) and only when a graph actually held an unknown node.
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
      const result = graphToCode(nodes, edges, NODE_REGISTRY);
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
        previewText = graphToCode(derived.nodes, derived.edges, NODE_REGISTRY).code;
      }
      setCode(result.code, 'graph', previewText);
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

      setSyncInProgress(true);
      try {
        /**
         * `codeToGraph` is the Babel front end (@babel/parser + /traverse +
         * /types — one ~800 KB raw / ~200 KB gz `vendor-babel` chunk), and
         * NOTHING calls it before first paint: a code→graph pass happens only
         * on a code-panel Apply / Cmd+S or a project import, both of which are
         * user-initiated moments where a chunk fetch is invisible. Importing it
         * here rather than at module scope is what keeps it off the boot wave.
         *
         * `setSyncInProgress(true)` deliberately stays ABOVE the await. It is
         * the flag that suppresses the graph→code effect, so arming it first
         * means a graph edit landing inside the fetch window cannot regenerate
         * the very code text this pass is about to parse — the same ordering
         * the synchronous version had, just with a real gap in the middle. The
         * `finally` below clears it on every exit, including a failed fetch.
         *
         * The import is caught SEPARATELY from the parse: a rejected chunk
         * fetch (connection drop, or a redeploy swapping the hashed assets
         * mid-session) is a new failure mode this function did not have while
         * the import was static, and it would otherwise escape as an unhandled
         * rejection with the Apply silently doing nothing. Reported as a code
         * error instead, so the panel says why — and the graph is left exactly
         * as it was, which is the safe direction.
         */
        let codeToGraph: typeof import('@/engine/codeToGraph').codeToGraph;
        try {
          ({ codeToGraph } = await import('@/engine/codeToGraph'));
          // Warm the `unknown`-expression validator off the SAME chunk, since
          // this pass can mint unknown nodes and the very next graph→code pass
          // would otherwise emit their expressions as the fail-closed fallback
          // and have to redo itself. Not awaited: it resolves from the module
          // registry Babel now sits in, and a failure here is already handled
          // (fail closed, retried on the next call).
          void loadUnknownExpressionValidator();
        } catch {
          setCodeErrors([
            {
              message: 'The TSL parser could not be loaded — reload the app and apply again.',
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

          // Merge a matched old node with a new node: preserve position + UI-only data
          const mergeMatch = (newNode: AppNode, match: AppNode): AppNode => {
            const merged = {
              ...newNode,
              id: match.id,
              position: { ...match.position },
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
          const pairing = pairResyncNodes(oldNodes, result.nodes, oldActive?.id ?? null);
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

          let finalNodes: AppNode[];
          if (unpositioned.length > 0) {
            // New or changed nodes — auto-layout ALL to maintain left-to-right flow
            finalNodes = autoLayout([...positioned, ...unpositioned], remappedEdges, 'LR');
          } else {
            finalNodes = positioned;
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
            // Unwrapped, so the test matches graphToCode's own decision exactly:
            // a collapsed group rewrites its boundary edges to synthetic group
            // sockets, so a raw read would see a property feeding OUT of a
            // collapsed group as having no consumer, call it an orphan, and carry
            // a duplicate of a node the parse legitimately produced.
            const realOldEdges = unwrapCollapsedGroupEdges(oldNodes, oldEdges);
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
          }

          // Preserve group nodes from the old graph — codeToGraph doesn't know about
          // them, so they'd otherwise be lost on every Save. Carry over both the
          // group containers themselves AND any parentId/extent on members whose
          // ID survived the merge. Skip when autoLayout ran: positions are now
          // absolute and reattaching them as group-relative would put children in
          // the wrong place.
          const oldGroups =
            unpositioned.length > 0 ? [] : oldNodes.filter((n) => n.type === 'group');
          if (oldGroups.length > 0) {
            const survivingIds = new Set(finalNodes.map((n) => n.id));
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
            // Survival check above already accounts for `survivingIds`.
            void survivingIds;
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

    // Collapse the `setTotalCost` write and the output-node cost writes into a
    // single setState so we don't re-enter this effect twice for one change.
    //
    // Every sink carries its OWN price (`sinkCosts`): an Output's badge is
    // what the shader would cost with it active — so two candidate outputs can
    // be compared before one is clicked.
    const perSink = sinkCosts(nodes, unwrapped);
    const needsOutputUpdate = nodes.some((n) => perSink.has(n.id) && n.data.cost !== perSink.get(n.id));
    useAppStore.setState((state) => ({
      totalCost: total,
      ...(needsOutputUpdate
        ? {
            nodes: state.nodes.map((n) =>
              perSink.has(n.id) && n.data.cost !== perSink.get(n.id)
                ? { ...n, data: { ...n.data, cost: perSink.get(n.id)! } }
                : n
            ) as AppNode[],
          }
        : {}),
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
