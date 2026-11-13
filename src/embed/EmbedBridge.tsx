/**
 * The SuperWXR embed bridge (embed/embedMode.ts decides when it mounts).
 *
 * Messages, all with `type: 'superwxr:*'`, posted to and accepted from the
 * PARENT window at the page's own origin only:
 *
 *   in   { type: 'superwxr:open', module: string, name?: string, id?: string }
 *        — open a shader .js export (a FASTSHADERS_PROJECT_V1 block restores the
 *          graph; a bare module is parsed back), the "Load Script…" path: no
 *          Open/Add dialog. `id` is the host's own name for that document.
 *   out  { type: 'superwxr:ready', protocol: 2 }
 *        — posted once the bridge listens.
 *   out  { type: 'superwxr:module', module: string, name: string, id, replaced? }
 *        — the settled EXPORT module (images inlined, project block appended):
 *          what the EXPORT button would write, whenever the graph, the module
 *          settings or the name changed, trailing-debounced like the preview.
 *   out  { type: 'superwxr:export', kind, fileName, mime, bytes, id }
 *        — what downloadShader would have downloaded (exportShader.ts).
 *
 * Every outgoing message names the document it is about (embedDocument.ts):
 * `id` is the id of the open the graph came from; for a file opened INSIDE the
 * editor it is an id minted here, with `replaced` naming the document it took
 * the place of; for the graph the editor started with it is null. A host files
 * a module by that id, never by what is selected when the message arrives.
 *
 * The host's document is the ONLY copy: embedded, the editor neither reads nor
 * writes its own stored graph, name, viewport or model (store/useAppStore.ts,
 * utils/viewportMemory.ts), so it starts from the built-in graph every time
 * and a full FastShaders tab at the same origin keeps its own work.
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
import {
  EMBED_PROTOCOL,
  embedDocumentFields,
  embedDocumentOpened,
  embedDocumentReplaced,
  embedModuleKey,
  hostDocumentId,
} from './embedDocument';

/** The preview's own settle delay (PREVIEW_REBUILD_DEBOUNCE_MS) plus a margin. */
const SETTLE_MS = 300;

interface OpenMessage {
  type: 'superwxr:open';
  module?: unknown;
  name?: unknown;
  id?: unknown;
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
    // What the host holds: the document and text last posted OR last opened
    // (embedModuleKey). One slot, so an edit away from an opened module and
    // back to it is posted again.
    let lastPosted = '';
    let timer: ReturnType<typeof setTimeout> | null = null;
    // True only inside this bridge's own import: its `fs:graph-imported` is the
    // host's document arriving, not one replacing it.
    let opening = false;

    const broadcast = () => {
      timer = null;
      const module = buildExportModule({ inlineImages: true });
      if (module.startsWith(EXPORT_ERROR_PREFIX)) return;
      const text = embedProjectState(module, buildProjectState());
      const key = embedModuleKey(text);
      if (key === lastPosted) return;
      lastPosted = key;
      post({ type: 'superwxr:module', module: text, name: useAppStore.getState().shaderName, ...embedDocumentFields() });
    };
    const schedule = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(broadcast, SETTLE_MS);
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
      schedule();
    });

    // A file opened inside the editor (a dropped shader's Open, a shader stored
    // in a dropped model) or NEW: another document, no longer the one the host
    // opened. Both events are dispatched synchronously by the path that
    // replaces the graph. The boot seed's own `fs:graph-imported` (App.tsx)
    // never reaches this listener: it fires in the first commit's mount
    // effect, and this chunk is lazy, so it mounts in a later one.
    const onReplaced = () => {
      if (opening) return;
      embedDocumentReplaced();
      schedule();
    };
    window.addEventListener('fs:graph-imported', onReplaced);
    window.addEventListener('fs:graph-new', onReplaced);

    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent || e.origin !== embedTargetOrigin()) return;
      const data = e.data as OpenMessage | null;
      if (!data || typeof data !== 'object' || data.type !== 'superwxr:open') return;
      if (typeof data.module !== 'string' || data.module.length === 0) return;
      const text = data.module;
      const nameFallback = nameOf(data.name);
      const id = hostDocumentId(data.id);
      // An open supersedes the mount-time broadcast below: the import's own settle broadcasts.
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      void preloadShaderImport().then(() => {
        opening = true;
        try {
          importShaderText(text, { nameFallback, parsed: extractProjectState(text) });
          // Only now, and only on success: an open that threw leaves the graph
          // the document it was, and its edits must keep saying so.
          embedDocumentOpened(id);
          lastPosted = embedModuleKey(text);
        } catch (err) {
          console.error('[FastShaders embed] open failed', err);
        } finally {
          opening = false;
        }
      });
    };
    window.addEventListener('message', onMessage);
    post({ type: 'superwxr:ready', protocol: EMBED_PROTOCOL });
    // A lazy chunk comes up AFTER the first settle, so nothing would change the
    // store again on a host that just shows what the editor holds: tell it, at
    // the same trailing delay — unless an open arrives first (above).
    timer = setTimeout(broadcast, SETTLE_MS);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('fs:graph-imported', onReplaced);
      window.removeEventListener('fs:graph-new', onReplaced);
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
    };
  }, []);
  return null;
}
