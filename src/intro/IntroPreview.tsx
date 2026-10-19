/**
 * The REAL 3D preview, small, for the intro's slides that are about what the
 * preview shows: the same sandboxed document `tslToPreviewHTML` builds for the
 * editor's pane, driven through the same messages ShaderPreview sends — the
 * model feed (`fs:obj-model`), the hot shader swap (`fs:shader`) and uniform
 * values (`fs:uniform`). Nothing is a picture of the preview; what changes on
 * it is the renderer's own answer.
 *
 * Deliberately NOT ShaderPreview: that component reads and writes the store
 * (the graph, the mesh, persisted camera and uniform values), and the intro
 * writes nothing. This is the document and its message contract alone. The
 * document is cold-built only when the MODEL changes (as the pane's is); a
 * new module goes in hot. The pane's look follows the user's own background
 * and lighting choices.
 */
import { useEffect, useMemo, useRef } from 'react';
import { readPersisted } from '@/hooks/usePersistedState';
import { SHADER_SWAP_MESSAGE, tslToPreviewHTML, type LightingMode } from '@/engine/tslToPreviewHTML';
import { storedHex6 } from '@/utils/colorUtils';

export interface IntroModel {
  /** The model's identity: a new id is a new document (the pane's cold key). */
  id: number;
  bytes: Uint8Array;
}

const LIGHTINGS: readonly LightingMode[] = ['studio', 'moon', 'laboratory', 'none'];

export function IntroPreview({
  tslCode,
  module,
  model = null,
  uniforms,
  spin = true,
  zoom = 1,
}: {
  /** The generated TSL — what the document's own module would be built from. */
  tslCode: string;
  /** The module to run (`buildPreviewShaderModule` of `tslCode`). */
  module: string;
  model?: IntroModel | null;
  /** Uniform values to push, by name (the uniform panel's overrides). */
  uniforms?: Readonly<Record<string, number>>;
  spin?: boolean;
  /** How much larger than the pane's framing the object reads: the camera
   *  starts this much closer than the pane's own 0 0 8 (a cold option, as it
   *  is in the pane — it rides the model's rebuild). */
  zoom?: number;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const loaded = useRef(false);
  const running = useRef('');
  const gen = useRef(0);
  const modelRef = useRef(model);
  const moduleRef = useRef(module);
  const uniformsRef = useRef(uniforms);
  modelRef.current = model;
  moduleRef.current = module;
  uniformsRef.current = uniforms;

  // Cold: once per model, with whatever module is current then (it is the
  // document's baked one, so the hot channel starts in agreement with it).
  const srcDoc = useMemo(() => {
    running.current = moduleRef.current;
    loaded.current = false;
    const bg = storedHex6(readPersisted('fs:previewBgColor', (v) => v)) ?? '#808080';
    const lit = readPersisted('fs:previewLighting', (v) => v) as LightingMode;
    return tslToPreviewHTML(tslCode, {
      shaderModule: moduleRef.current,
      geometry: model ? 'custom' : 'sphere',
      customModel: model ? { kind: 'glb', id: model.id } : null,
      bgColor: bg,
      lighting: LIGHTINGS.includes(lit) ? lit : 'studio',
      animate: spin,
      initialCameraPosition: zoom !== 1 ? { x: 0, y: 0, z: 8 / zoom } : null,
    });
    // Rebuilt on the model alone — a module change goes in hot below.
  }, [model?.id]);

  const win = () => ref.current?.contentWindow ?? null;
  const pushUniforms = () => {
    const w = win();
    if (!w || !uniformsRef.current) return;
    for (const [name, value] of Object.entries(uniformsRef.current)) w.postMessage({ type: 'fs:uniform', name, value }, '*');
  };
  const swap = () => {
    const w = win();
    if (!w || moduleRef.current === running.current) return;
    running.current = moduleRef.current;
    gen.current += 1;
    w.postMessage({ type: SHADER_SWAP_MESSAGE, code: moduleRef.current, gen: gen.current }, '*');
  };

  const onLoad = () => {
    loaded.current = true;
    const w = win();
    const m = modelRef.current;
    if (w && m) w.postMessage({ type: 'fs:obj-model', geometry: `custom:${m.id}`, kind: 'glb', bytes: m.bytes }, '*');
    swap();
    pushUniforms();
  };

  // The document answers a boot or a swap with `fs:preview-ready`; a fresh
  // module schema has reset its uniforms to the code's own values, so the
  // panel's overrides are pushed again — ShaderPreview's replay.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== win()) return;
      if ((e.data as { type?: unknown } | null)?.type === 'fs:preview-ready') pushUniforms();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (loaded.current) swap();
  }, [module]);

  useEffect(() => {
    if (loaded.current) pushUniforms();
  }, [uniforms]);

  return (
    <iframe
      ref={ref}
      className="fs-intro__preview"
      title="FastShaders preview"
      srcDoc={srcDoc}
      onLoad={onLoad}
      // The pane's own sandbox: scripts only, an opaque origin (ShaderPreview).
      sandbox="allow-scripts"
      tabIndex={-1}
      aria-hidden="true"
    />
  );
}
