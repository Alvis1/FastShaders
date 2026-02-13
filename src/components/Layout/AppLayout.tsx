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
        left={<NodeEditor />}
        right={
          <div className="app-layout__right">
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
