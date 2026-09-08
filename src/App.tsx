import { Suspense, lazy, useEffect, useRef, type ComponentType } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { useAppStore, loadGraph, loadSavedGroups } from './store/useAppStore';
import { AppLayout } from './components/Layout/AppLayout';
import { useSyncEngine } from './hooks/useSyncEngine';
import { isEvalMode } from './eval/evalMode';
import complexityData from './registry/complexity.json';
import type { AppNode, AppEdge, OutputNodeData, ShaderNodeData } from './types';
import { generateId } from './utils/idGenerator';
import { makeTypedEdge } from './utils/edgeUtils';
import { readStoredViewport } from './utils/viewportMemory';
/**
 * The study STYLESHEET stays eager even though every module that draws with it
 * is now lazy, and that is not an oversight.
 *
 * It carries the `/evalp` arm's price suppression — the ONE
 * `:root[data-fs-points='off']` sweep that removes every cost badge and the
 * cost bar — and `main.tsx` stamps that attribute synchronously at boot
 * (`applyEvalTaskFlags`) precisely so no participant in the no-cost-feedback
 * condition ever sees a point figure. Let this ride the lazy chunk and the
 * sweep arrives one fetch AFTER the first paint: the app renders the previous
 * session's canvas with its badges and cost bar intact for as long as the
 * chunk is in flight, which contaminates the condition it exists to create.
 *
 * The cost of keeping it is ~4.9 KB raw / ~1.3 KB gz of class-scoped rules
 * (`.eval-*`, plus that one attribute-gated sweep) folded into the entry
 * stylesheet — inert outside a study session, and nothing next to the ~12 KB
 * chunk of JS the lazy split below actually removes.
 */
import './eval/eval.css';

/**
 * Shown only if the consent chunk itself fails to arrive — a connection drop,
 * or a redeploy swapping the hashed assets mid-session.
 *
 * It has to be LOUD rather than silent, and that is the whole reason this is
 * not a `() => null` fallback: with no consent screen, `startEvalSession`
 * never runs, so `evalLog` no-ops and `cleanSlateForStudy` never fires — the
 * participant would work a full session on the previous user's canvas while
 * nothing at all was recorded, and would find out only when the package came
 * back empty. Inline styles because the study stylesheet (`eval/eval.css`)
 * rides the very chunk that did not load.
 */
function EvalGateUnavailable() {
  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        inset: 'var(--space-4) 0 auto 0',
        margin: '0 auto',
        maxWidth: '32rem',
        padding: 'var(--space-3)',
        background: 'var(--bg-panel)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border-strong)',
        boxShadow: 'var(--shadow-lg)',
        zIndex: 'var(--z-overlay)',
      }}
    >
      The study consent screen could not be loaded, so nothing is being recorded. Reload the page to
      start the session.
    </div>
  );
}

/**
 * Study-only UI, kept off every ordinary visitor's boot — the counterpart of
 * the split Toolbar.tsx already makes for the SUS and finish modals, and the
 * last eager JS edge into `src/eval/` (what remains is `evalMode`, three lines
 * of sessionStorage the guard below needs synchronously, and the stylesheet
 * above). EvalGate reaches ConsentModal → DataDisclosureModal, none of which a
 * normal session ever paints.
 *
 * `isEvalMode()` samples sessionStorage ONCE at module init (eval/evalMode.ts),
 * so the guard at the render site stays a plain synchronous boolean: outside a
 * study session the element is never created, React.lazy therefore never starts
 * its import, and the chunk is not even requested.
 *
 * The factory is annotated with the component TYPE rather than inferred, the
 * same trap Toolbar.tsx documents: without it TS pins the lazy type to
 * EvalGate's own return (`ReactPortal | null` — ConsentModal is a portal) and
 * the plain-`div` fallback stops being assignable.
 */
const EvalGate = lazy(
  async (): Promise<{ default: ComponentType }> => {
    try {
      return { default: (await import('./eval/EvalGate')).EvalGate };
    } catch {
      return { default: EvalGateUnavailable };
    }
  },
);

function SyncController() {
  useSyncEngine();
  return null;
}

function createInitialNodes(): { nodes: AppNode[]; edges: AppEdge[] } {
  const costs = complexityData.costs as Record<string, number>;

  const perlinId = generateId();
  const color1Id = generateId();
  const color2Id = generateId();
  const subId = generateId();
  const mixId = generateId();
  const outputId = generateId();

  const nodes: AppNode[] = [
    {
      id: perlinId,
      type: 'preview',
      position: { x: 0, y: 130 },
      data: {
        registryType: 'perlin',
        label: 'Perlin Noise',
        cost: costs.perlin ?? 35,
        values: {
          pos: 'positionGeometry',
          scale: 1.1,
        },
      } as ShaderNodeData,
    },
    {
      id: color1Id,
      type: 'color',
      position: { x: 270, y: 0 },
      data: {
        registryType: 'color',
        label: 'Color',
        cost: costs.color ?? 0,
        values: { hex: '#fec700' },
      } as ShaderNodeData,
    },
    {
      id: color2Id,
      type: 'color',
      position: { x: 270, y: 130 },
      data: {
        registryType: 'color',
        label: 'Color',
        cost: costs.color ?? 0,
        values: { hex: '#e32400' },
      } as ShaderNodeData,
    },
    {
      id: subId,
      type: 'shader',
      position: { x: 450, y: 260 },
      data: {
        registryType: 'sub',
        label: 'Subtract',
        cost: costs.sub ?? 0,
        values: { b: 0.5 },
      } as ShaderNodeData,
    },
    {
      id: mixId,
      type: 'shader',
      position: { x: 450, y: 40 },
      data: {
        registryType: 'mix',
        label: 'Mix',
        cost: costs.mix ?? 0,
        values: {},
      } as ShaderNodeData,
    },
    {
      id: outputId,
      type: 'output',
      position: { x: 650, y: 120 },
      data: {
        registryType: 'output',
        label: 'Output',
        cost: 0,
        exposedPorts: ['color', 'position'],
      } as OutputNodeData,
    },
  ];

  const edges: AppEdge[] = [
    makeTypedEdge(perlinId, 'out', mixId, 't', 'color'),
    makeTypedEdge(perlinId, 'out', subId, 'a', 'color'),
    makeTypedEdge(color1Id, 'out', mixId, 'a', 'color'),
    makeTypedEdge(color2Id, 'out', mixId, 'b', 'color'),
    makeTypedEdge(mixId, 'out', outputId, 'color', 'any'),
    makeTypedEdge(subId, 'out', outputId, 'position', 'any'),
  ];

  return { nodes, edges };
}

export default function App() {
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    // The saved-group library is hydrated HERE, not in the store's `create()`
    // body: `loadSavedGroups` reaches `autoExposeConnectedParamPorts` /
    // `sanitizeOutputMaterials`, which sit in the import cycle that runs back
    // through the store, so calling it at module scope could read a `const`
    // still in its TDZ and silently return an EMPTY library (the store's own
    // `savedGroups` comment carries the measurement). A mount effect runs after
    // every module body, where no cycle can catch anything half-initialised.
    // Same reason `drawings` and `shaderPalettes` are seeded from here.
    useAppStore.setState({ savedGroups: loadSavedGroups() });

    const saved = loadGraph();
    const { nodes, edges } = saved ?? createInitialNodes();
    useAppStore.getState().setNodes(nodes, 'graph');
    useAppStore.getState().setEdges(edges, 'graph');
    if (saved?.drawings?.length) useAppStore.getState().setDrawings(saved.drawings);
    // Palettes ride the same fs:graph payload and are already sanitized by
    // loadGraph — the same contract setDrawings has.
    if (saved?.palettes?.length) useAppStore.getState().setShaderPalettes(saved.palettes);

    // Frame the boot graph. React Flow's `fitView` init prop already ran by
    // now — child effects run before this parent effect, so it fitted an
    // EMPTY canvas and the seeded graph landed at the raw default viewport,
    // with half the demo chain (Output node included) outside the pane on a
    // first visit. The import-fit arm in NodeEditor solves exactly this
    // "nodes replaced, viewport not" case, and its listener is attached by
    // the same effect-ordering guarantee.
    //
    // …but NOT when the canvas has a remembered viewport for this very graph.
    // Framing is the right default for a graph the user has not seen yet; it is
    // exactly wrong when they left the canvas somewhere deliberate, and this is
    // the line that decides it — NodeEditor's `defaultViewport` has already put
    // the viewport back by now, and the arm fits straight over it (measured:
    // the restore looked like it had simply not been implemented). Gated on
    // `saved` rather than on the stored viewport alone, so a corrupt or missing
    // autosave — which lands the DEMO graph on screen instead — is still framed.
    if (saved && readStoredViewport()) return;
    window.dispatchEvent(new CustomEvent('fs:graph-imported'));
  }, []);

  return (
    <ReactFlowProvider>
      <SyncController />
      {/* User-study mode (…/eval): consent gate + telemetry boot. The guard
          keeps every eval-mode module inert for normal sessions — and, since
          EvalGate is lazy, unfetched. Suspense fallback is null on purpose: the
          gate paints a full-screen consent modal, and standing a placeholder in
          front of the app for the few ms the chunk is in flight would only
          flash. Nothing is logged until the participant agrees, so an app
          briefly visible behind no modal records nothing. */}
      {isEvalMode() && (
        <Suspense fallback={null}>
          <EvalGate />
        </Suspense>
      )}
      <AppLayout />
    </ReactFlowProvider>
  );
}
