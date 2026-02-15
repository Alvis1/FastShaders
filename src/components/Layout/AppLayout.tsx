import { CostBar } from './CostBar';
import { SplitPane } from './SplitPane';
import { NodeEditor } from '@/components/NodeEditor/NodeEditor';
import { CodeEditor } from '@/components/CodeEditor/CodeEditor';
import { ShaderPreview } from '@/components/Preview/ShaderPreview';
import { useAppStore } from '@/store/useAppStore';
import './AppLayout.css';

export function AppLayout() {
  const splitRatio = useAppStore((s) => s.splitRatio);
  const setSplitRatio = useAppStore((s) => s.setSplitRatio);
  const rightSplitRatio = useAppStore((s) => s.rightSplitRatio);
  const setRightSplitRatio = useAppStore((s) => s.setRightSplitRatio);

  return (
    <div className="app-layout">
      <CostBar />
      <SplitPane
        ratio={splitRatio}
        onRatioChange={setSplitRatio}
        left={
          <div className="app-layout__left">
            <div className="app-layout__panel-label">Node View</div>
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
              left={
                <div className="app-layout__code-panel">
                  <div className="app-layout__panel-label app-layout__panel-label--right">TSL Code View</div>
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
    </div>
  );
}
