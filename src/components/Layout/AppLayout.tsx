import { lazy, Suspense } from 'react';
import { SplitPane } from './SplitPane';
import { Toolbar } from './Toolbar';
import { NodeEditor } from '@/components/NodeEditor/NodeEditor';
import { ShaderPreview } from '@/components/Preview/ShaderPreview';

// Monaco (a ~3.7MB chunk + its CSS) rides CodeEditor's import graph; loading
// it lazily moves all of it off the first-paint critical path — the canvas
// and preview render immediately and the editor pane fills in right after.
// Still a self-hosted hashed asset, so the offline/desktop constraint holds.
// The catch matters: a failed lazy fetch (connection drop, or a redeploy
// swapping the hashed assets mid-session) would otherwise reject through
// React.lazy with no boundary and unmount the whole live app — degrade to a
// broken code pane instead.
function CodeEditorLoadError() {
  return (
    <div style={{ padding: 'var(--space-3)', color: 'var(--text-secondary)' }}>
      Code editor failed to load — reload the app to retry.
    </div>
  );
}
const CodeEditor = lazy(() =>
  import('@/components/CodeEditor/CodeEditor')
    .then((m) => ({ default: m.CodeEditor }))
    .catch(() => ({ default: CodeEditorLoadError })),
);
import { CsvImportModal } from '@/components/Modals/CsvImportModal';
import { LimitModal } from '@/components/Modals/LimitModal';
import { TooltipLayer } from '@/components/Tooltip/TooltipLayer';
import { useAppStore } from '@/store/useAppStore';
import './AppLayout.css';

export function AppLayout() {
  const splitRatio = useAppStore((s) => s.splitRatio);
  const setSplitRatio = useAppStore((s) => s.setSplitRatio);
  const rightSplitRatio = useAppStore((s) => s.rightSplitRatio);
  const setRightSplitRatio = useAppStore((s) => s.setRightSplitRatio);

  return (
    <div className="app-layout">
      <Toolbar />
      <SplitPane
        ratio={splitRatio}
        onRatioChange={setSplitRatio}
        // One corner control for the whole layout: this seam's grip anchors at
        // the code/preview seam's height and drags BOTH splits (Shift locks to
        // an axis) — which is why the inner splitter below renders no grip.
        crossRatio={rightSplitRatio}
        onCrossRatioChange={setRightSplitRatio}
        left={
          <div className="app-layout__left">
            <div className="app-layout__node-editor">
              <NodeEditor />
            </div>
          </div>
        }
        right={
          <div className="app-layout__right">
            <SplitPane
              direction="vertical"
              ratio={rightSplitRatio}
              onRatioChange={setRightSplitRatio}
              // No grip of its own: this seam is dragged (vertically) by the
              // corner grip on the column seam to the left.
              grip={false}
              left={
                <div className="app-layout__code-panel">
                  <div className="app-layout__code">
                    <Suspense fallback={null}>
                      <CodeEditor />
                    </Suspense>
                  </div>
                </div>
              }
              right={
                <div className="app-layout__preview">
                  <ShaderPreview />
                </div>
              }
            />
          </div>
        }
      />
      <CsvImportModal />
      <LimitModal />
      <TooltipLayer />
    </div>
  );
}
