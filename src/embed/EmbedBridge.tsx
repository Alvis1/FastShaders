/**
 * The SuperWXR embed bridge (embed/embedMode.ts decides when it mounts).
 *
 * Messages, all with `type: 'superwxr:*'`, posted to and accepted from the
 * PARENT window at the page's own origin only:
 *
 *   in   { type: 'superwxr:open', module: string, name?: string }
 *        — open a shader .js export (a FASTSHADERS_PROJECT_V1 block restores the
 *          graph; a bare module is parsed back), the "Load Script…" path: no
 *          Open/Add dialog.
 *   out  { type: 'superwxr:ready' }
 *        — posted once the bridge listens.
 *   out  { type: 'superwxr:module', module: string, name: string }
 *        — the settled EXPORT module (images inlined, project block appended):
 *          what the EXPORT button would write, whenever the graph, the module
 *          settings or the name changed, trailing-debounced like the preview.
 *   out  { type: 'superwxr:export', kind, fileName, mime, bytes }
 *        — what downloadShader would have downloaded (exportShader.ts).
 *
 * Never in a study session: the bridge is a second way to change the graph.
 */
import { useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { buildExportModule, buildProjectState, EXPORT_ERROR_PREFIX } from '@/engine/exportShader';
import { embedProjectState, extractProjectState } from '@/engine/fastShadersProject';
import { importShaderText, preloadShaderImport } from '@/engine/projectImport';
import { moduleSettingsOutput } from '@/utils/outputMaterials';
import type { AppNode, OutputNodeData } from '@/types';
import { embedTargetOrigin } from './embedMode';

/** The preview's own settle delay (PREVIEW_REBUILD_DEBOUNCE_MS) plus a margin. */
const SETTLE_MS = 300;

interface OpenMessage {
  type: 'superwxr:open';
  module?: unknown;
  name?: unknown;
}

function post(message: Record<string, unknown>): void {
  window.parent.postMessage(message, embedTargetOrigin());
}

/** A name a dropped file would get: the stem, trimmed, bounded. */
function nameOf(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\.(m?js|zip)$/i, '').trim().slice(0, 80);
}

export function EmbedBridge() {
  useEffect(() => {
    let lastPosted = '';
    let lastOpened = '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    const broadcast = () => {
      timer = null;
      const module = buildExportModule({ inlineImages: true });
      if (module.startsWith(EXPORT_ERROR_PREFIX)) return;
      const text = embedProjectState(module, buildProjectState());
      if (text === lastPosted || text === lastOpened) return;
      lastPosted = text;
      post({ type: 'superwxr:module', module: text, name: useAppStore.getState().shaderName });
    };

    // The store notifies once per drag frame, so the question "did anything the
    // module depends on change?" must cost nothing on the frames where nothing
    // did: three references, and the Output node's settings OBJECT by reference
    // when the nodes array moved (a drag replaces the array and the moved
    // cards, never a card's data). No string is built here; `broadcast` dedupes
    // the module text itself.
    const settingsOf = (nodes: AppNode[]) => (moduleSettingsOutput(nodes)?.data as OutputNodeData | undefined)?.materialSettings;
    const initial = useAppStore.getState();
    let last = { previewCode: initial.previewCode, shaderName: initial.shaderName, nodes: initial.nodes, settings: settingsOf(initial.nodes) };
    const unsubscribe = useAppStore.subscribe((state) => {
      if (state.previewCode === last.previewCode && state.shaderName === last.shaderName && state.nodes === last.nodes) return;
      const settings = state.nodes === last.nodes ? last.settings : settingsOf(state.nodes);
      const changed = state.previewCode !== last.previewCode || state.shaderName !== last.shaderName || settings !== last.settings;
      last = { previewCode: state.previewCode, shaderName: state.shaderName, nodes: state.nodes, settings };
      if (!changed) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(broadcast, SETTLE_MS);
    });

    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent || e.origin !== embedTargetOrigin()) return;
      const data = e.data as OpenMessage | null;
      if (!data || typeof data !== 'object' || data.type !== 'superwxr:open') return;
      if (typeof data.module !== 'string' || data.module.length === 0) return;
      const text = data.module;
      const nameFallback = nameOf(data.name);
      lastOpened = text;
      void preloadShaderImport().then(() => {
        try {
          importShaderText(text, { nameFallback, parsed: extractProjectState(text) });
        } catch (err) {
          console.error('[FastShaders embed] open failed', err);
        }
      });
    };
    window.addEventListener('message', onMessage);
    post({ type: 'superwxr:ready' });
    return () => {
      window.removeEventListener('message', onMessage);
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
  return null;
}
