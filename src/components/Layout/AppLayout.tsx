import { CostBar } from './CostBar';
import { SplitPane } from './SplitPane';
import { NodeEditor } from '@/components/NodeEditor/NodeEditor';
import { CodeEditor } from '@/components/CodeEditor/CodeEditor';
import { ShaderPreview } from '@/components/Preview/ShaderPreview';
import './AppLayout.css';

export function AppLayout() {
  return (
    <div className="app-layout">
      <CostBar />
      <SplitPane
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
            <div className="app-layout__panel-label app-layout__panel-label--right">TSL Code View</div>
            <div className="app-layout__code">
              <CodeEditor />
            </div>
            <div className="app-layout__preview">
              <ShaderPreview />
            </div>
          </div>
        }
      />
    </div>
  );
}
