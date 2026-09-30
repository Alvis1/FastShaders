import { Suspense, useEffect, useState } from 'react';
import { SplitPane, clampPreviewSplit } from './SplitPane';
import { Toolbar } from './Toolbar';
import { NodeEditor } from '@/components/NodeEditor/NodeEditor';
import { ShaderPreview } from '@/components/Preview/ShaderPreview';
import { CsvImportModal } from '@/components/Modals/CsvImportModal';
import { LimitModal } from '@/components/Modals/LimitModal';
import { ShaderImportModal } from '@/components/Modals/ShaderImportModal';
import { TooltipLayer } from '@/components/Tooltip/TooltipLayer';
import { useAppStore } from '@/store/useAppStore';
import { t } from '@/i18n';
import { lazyOr } from '@/utils/lazyOr';
import './AppLayout.css';

// Monaco (a ~3.7MB chunk + its CSS) rides CodeEditor's import graph; loading
// it lazily moves all of it off the first-paint critical path — the canvas
// and preview render immediately and the editor pane fills in right after.
// Still a self-hosted hashed asset, so the offline/desktop constraint holds.
// lazy() is only half of it: see useIdleMount below for why the ELEMENT is
// withheld too — a lazy component that is rendered immediately still starts
// its fetch immediately, which is what raced the preview's own assets.
// A failed fetch degrades to a broken code pane (lazyOr) rather than
// unmounting the whole live app.
function CodeEditorLoadError() {
  const language = useAppStore((s) => s.language);
  return (
    <div style={{ padding: 'var(--space-3)', color: 'var(--text-secondary)' }}>
      {t('Code editor failed to load — reload the app to retry.', language)}
    </div>
  );
}
const CodeEditor = lazyOr(
  () => import('@/components/CodeEditor/CodeEditor').then((m) => m.CodeEditor),
  CodeEditorLoadError,
);

/**
 * How long the code pane may wait for an idle moment before it mounts anyway.
 * Long enough for the preview iframe to get its ~1.7MB of A-Frame + loader
 * through on a slow link, short enough that nobody reaching for the code panel
 * notices — and it is a CEILING, not a delay: on any machine that finishes
 * booting the preview sooner, the idle callback fires first.
 */
const CODE_PANE_MOUNT_TIMEOUT_MS = 2000;

/**
 * Hold the code pane's mount until the browser has a spare moment (or the
 * deadline above passes, whichever comes first).
 *
 * lazy() alone only moves Monaco off the first-PAINT path — the request still
 * starts in the very first commit, so its ~950KB gz competes for bandwidth and
 * main-thread time with exactly the assets the 3D preview needs to show
 * anything (ShaderPreview is a static import and mounts in the same commit).
 * Not mounting the element at all is what actually defers the fetch, because
 * React.lazy starts its import the first time it is rendered.
 *
 * `requestIdleCallback`'s own `timeout` option would express both halves in one
 * call, but the app's floor includes Safari 16.2, which does not have it — so
 * the plain setTimeout is a real fallback, not a belt-and-braces.
 *
 * One consequence worth knowing: CodeEditor owns the Cmd/Ctrl+S Apply
 * shortcut, so that key does nothing (i.e. falls through to the browser) for
 * the first moment of a session. The pane it applies is empty until then
 * anyway, since the Suspense fallback is null and always has been.
 */
function useIdleMount(timeoutMs: number): boolean {
  const [mount, setMount] = useState(false);
  useEffect(() => {
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(() => setMount(true), { timeout: timeoutMs });
      return () => window.cancelIdleCallback?.(handle);
    }
    const timer = window.setTimeout(() => setMount(true), timeoutMs);
    return () => window.clearTimeout(timer);
  }, [timeoutMs]);
  return mount;
}

function CodePane() {
  const mounted = useIdleMount(CODE_PANE_MOUNT_TIMEOUT_MS);
  return (
    <div className="app-layout__code-panel">
      <div className="app-layout__code">
        {/* Empty until the mount gate opens — the same empty the
            Suspense fallback shows while the chunk is in flight. */}
        <Suspense fallback={null}>{mounted && <CodeEditor />}</Suspense>
      </div>
    </div>
  );
}

// Module-scope elements: a seam drag re-renders AppLayout per pointermove, and
// an element of the same identity lets React skip the whole subtree under it.
const TOOLBAR = <Toolbar />;
const CANVAS_PANE = (
  <div className="app-layout__left">
    <div className="app-layout__node-editor">
      <NodeEditor />
    </div>
  </div>
);
const PREVIEW_PANE = (
  <div className="app-layout__preview">
    <ShaderPreview />
  </div>
);
const CODE_PANE = <CodePane />;
const OVERLAYS = (
  <>
    <CsvImportModal />
    <ShaderImportModal />
    <LimitModal />
    <TooltipLayer />
  </>
);

export function AppLayout() {
  const splitRatio = useAppStore((s) => s.splitRatio);
  const setSplitRatio = useAppStore((s) => s.setSplitRatio);
  const rightSplitRatio = useAppStore((s) => s.rightSplitRatio);
  const setRightSplitRatio = useAppStore((s) => s.setRightSplitRatio);

  return (
    <div className="app-layout">
      {TOOLBAR}
      <SplitPane
        ratio={splitRatio}
        onRatioChange={setSplitRatio}
        // The corner: where this seam meets the preview/code seam a press
        // drags BOTH splits (Shift locks to an axis) — SplitPane's corner zone.
        // Everywhere else on the line it moves this seam alone.
        crossRatio={rightSplitRatio}
        onCrossRatioChange={setRightSplitRatio}
        left={CANVAS_PANE}
        right={
          <div className="app-layout__right">
            <SplitPane
              direction="vertical"
              // `rightSplitRatio` is the TOP pane's share, i.e. the PREVIEW's —
              // the 3D view sits above the code editor (see the store field for
              // the one-time migration off the old code-on-top meaning).
              ratio={rightSplitRatio}
              onRatioChange={setRightSplitRatio}
              // The same bounds the corner zone applies to this ratio, so the
              // seam stops in the same place whichever hand moves it.
              clamp={clampPreviewSplit}
              left={PREVIEW_PANE}
              right={CODE_PANE}
            />
          </div>
        }
      />
      {OVERLAYS}
    </div>
  );
}
