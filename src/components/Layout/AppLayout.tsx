import { SplitPane } from './SplitPane';
import { Toolbar } from './Toolbar';
import { NodeEditor } from '@/components/NodeEditor/NodeEditor';
import { CodeEditor } from '@/components/CodeEditor/CodeEditor';
import { ShaderPreview } from '@/components/Preview/ShaderPreview';
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
                    <CodeEditor />
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
