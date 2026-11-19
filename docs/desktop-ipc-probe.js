/**
 * DESKTOP IPC PROBE — run by hand in a BUILT desktop app (the macOS .dmg and
 * the Windows installer), never needed on the web.
 *
 * Question: can shader code in the sandboxed preview frame reach the Tauri
 * IPC? Read from the Tauri 2.11 sources it cannot: macOS injects the init
 * scripts and the invoke key into the main frame only (a frame can still post
 * to `webkit.messageHandlers.ipc`, but without the key, from an `about:srcdoc`
 * origin no capability names); on Windows WebView2 the init scripts reach
 * sub-frames TOO, and only the IPC's handling of the frame's opaque origin
 * stops an invoke. This file checks it on the real build, because the desktop
 * app has no page CSP and the frame runs shader code from files other people
 * share. docs/dev/platform-and-release.md ("Desktop IPC from the preview
 * frame") has the reasoning.
 *
 * How: drop this file on the canvas and choose Open (or File → Load Script…),
 * then look at the preview:
 *
 *   GREEN    nothing Tauri is visible in the frame         — expected on macOS
 *   YELLOW   the Tauri bridge is visible in the frame, but the invoke was
 *            refused or got no answer in 3 s               — expected on Windows
 *   MAGENTA  an invoke SUCCEEDED from the frame — do not ship: every app
 *            command is reachable from a shared file
 *   RED      the preview's own fallback colour: the probe did NOT run (the
 *            module builder could not read it). Inconclusive — fix the probe.
 *
 * The preview's message line also shows `[desktop-ipc-probe] …` with what the
 * frame could see; it is said again once the shader applies, because a
 * successful apply clears that line.
 *
 * The only command tried is `work_folder_status`, which reads and changes
 * nothing. Record the colour, the message line and the app version in
 * docs/dev/platform-and-release.md.
 *
 * Shape: everything above `const shader = Fn(() => {` runs at MODULE scope,
 * once, when the preview imports the module — the module builder keeps that
 * preamble verbatim and takes the colour from the Fn's BLOCK body. An
 * expression-bodied `Fn(() => x)` is not read at all: the module falls back
 * to plain red, which is why the first version of this probe painted the
 * "do not ship" colour without running a line (desktopIpcContract.test.ts now
 * builds this file the way the preview does and runs every verdict).
 * Identifiers carry an `fsProbe` prefix so none of them is a three/tsl export
 * the module builder would import over a local.
 */
import { Fn, vec3 } from 'three/tsl';

const fsProbeSeen = [];
let fsProbeInvoked = false;
const fsProbeBridge = Boolean(globalThis.__TAURI_INTERNALS__ || globalThis.__TAURI__);

try {
  const fsProbeInternals = globalThis.__TAURI_INTERNALS__;
  if (fsProbeInternals) fsProbeSeen.push('__TAURI_INTERNALS__');
  if (globalThis.__TAURI__) fsProbeSeen.push('__TAURI__');
  if (globalThis.ipc) fsProbeSeen.push('window.ipc');
  if (globalThis.chrome && globalThis.chrome.webview) fsProbeSeen.push('chrome.webview');
  if (globalThis.webkit && globalThis.webkit.messageHandlers && globalThis.webkit.messageHandlers.ipc) fsProbeSeen.push('webkit.messageHandlers.ipc');
  if (fsProbeInternals && typeof fsProbeInternals.invoke === 'function') {
    // A refused invoke may never settle: on Windows the custom-protocol call
    // fails and Tauri falls back to a frame-level postMessage nothing listens
    // to. Capped, or the module never finishes loading and nothing is drawn.
    const fsProbeAnswer = await Promise.race([
      fsProbeInternals.invoke('work_folder_status').then(
        () => 'answered',
        (fsProbeErr) => 'refused: ' + String(fsProbeErr).slice(0, 80),
      ),
      new Promise((fsProbeDone) => setTimeout(() => fsProbeDone('no answer in 3 s'), 3000)),
    ]);
    if (fsProbeAnswer === 'answered') fsProbeInvoked = true;
    else fsProbeSeen.push('invoke ' + fsProbeAnswer);
  }
} catch (fsProbeErr) {
  fsProbeSeen.push('probe threw: ' + String(fsProbeErr).slice(0, 80));
}

const fsProbeLine =
  '[desktop-ipc-probe] ' +
  (fsProbeInvoked ? 'INVOKE SUCCEEDED' : 'no invoke') +
  ' | seen: ' +
  (fsProbeSeen.join(', ') || 'nothing');
console.error(fsProbeLine);
// A successful apply clears the preview's message line (its listener was added
// first, so it runs first): say it again right after.
if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('shader-applied', () => console.error(fsProbeLine), { once: true });
}

const fsProbeVerdict = fsProbeInvoked
  ? vec3(1, 0, 1)
  : fsProbeBridge
    ? vec3(1, 0.85, 0)
    : vec3(0, 0.8, 0.2);

const shader = Fn(() => {
  return fsProbeVerdict;
});

export default shader;
