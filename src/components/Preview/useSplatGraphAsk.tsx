/**
 * The dropped-splat question's FLOW (`SplatGraphModal`): what `loadMeshFile`
 * hands a Gaussian splat that already passed `createPreviewMesh` when the
 * graph has no Splat Output (`asksToClearForSplat`). The splat waits — as the
 * caller's `load` closure, never in the store — until an answer: Keep loads
 * it, Clear runs `startSplatGraph` and then loads it in the same tick, Cancel
 * drops it.
 *
 * A second drop while the question is open is refused by the caller with the
 * model-import busy notice (`busy()`), the GLB dialog's rule: the sandboxed
 * preview can forge a drop and so open this dialog, but it can never answer it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fullscreenElement, pickPortalHost } from '@/components/inputs/colorPickerModel';
import { startSplatGraph } from '@/engine/projectImport';
import { SplatGraphModal, type SplatGraphChoice } from '@/components/Modals/SplatGraphModal';

export interface SplatGraphAsk {
  /** Ask about a splat; `load` puts it on screen. False when a question is
   *  already open (nothing was taken). */
  offer(fileName: string, load: () => void): boolean;
  busy(): boolean;
  modal: ReactNode;
}

interface Pending {
  fileName: string;
  load: () => void;
}

export function useSplatGraphAsk(anchorRef: React.RefObject<HTMLElement | null>): SplatGraphAsk {
  const [pending, setPending] = useState<Pending | null>(null);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const pendingRef = useRef<Pending | null>(null);

  // The portal host follows fullscreen: the preview fullscreens its own root,
  // and the top layer shows only that subtree (the colour picker's rule).
  useEffect(() => {
    if (!pending) return;
    const resolve = () => setPortalHost(pickPortalHost(fullscreenElement(), anchorRef.current, document.body));
    resolve();
    document.addEventListener('fullscreenchange', resolve);
    document.addEventListener('webkitfullscreenchange', resolve);
    return () => {
      document.removeEventListener('fullscreenchange', resolve);
      document.removeEventListener('webkitfullscreenchange', resolve);
    };
  }, [pending, anchorRef]);

  const offer = useCallback<SplatGraphAsk['offer']>((fileName, load) => {
    if (pendingRef.current) return false;
    const p = { fileName, load };
    pendingRef.current = p;
    setPending(p);
    return true;
  }, []);

  const choose = useCallback((c: SplatGraphChoice) => {
    const p = pendingRef.current;
    if (!p) return;
    pendingRef.current = null;
    setPending(null);
    if (c === 'cancel') return;
    if (c === 'clear') startSplatGraph();
    p.load();
  }, []);

  const busy = useCallback(() => pendingRef.current !== null, []);

  const modal = useMemo(
    () => <SplatGraphModal fileName={pending?.fileName ?? null} portalHost={portalHost} onChoose={choose} />,
    [pending, portalHost, choose],
  );

  return useMemo(() => ({ offer, busy, modal }), [offer, busy, modal]);
}
