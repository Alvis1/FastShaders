/**
 * Which limits the desktop app LIFTS — the decision behind the web build's
 * desktop-app note (components/Modals/DesktopAppNote.tsx), which LimitModal
 * and the N1 export dialog show only when the desktop room would really have
 * let the user through. Pointing at the desktop app for a limit it shares
 * (the 64 MP decode guard, the 8M hard ceiling, a headset's texture cap) would
 * send someone to install an app that refuses the same file.
 *
 * PURE and node-tested (desktopAppNote.test.ts). The `LimitNotice` import is
 * type-only, so this module never loads the store.
 */
import type { LimitNotice } from '@/store/useAppStore';
import { DESKTOP_MAX_TOTAL_UNCOMPRESSED } from './zipReader';

/**
 * - `yes` / `no`: the desktop build does / does not raise this limit.
 * - `not-under-ignore`: lifted, unless the notice was raised with Ignore
 *   limits on — then the refusal came from the 8M hard ceiling, which the
 *   desktop build shares.
 * - `zip-size`: lifted only for a total-size refusal whose size fits the
 *   desktop reader's cap.
 */
type Lift = 'yes' | 'no' | 'not-under-ignore' | 'zip-size';

/**
 * Exhaustive over `LimitNotice['kind']`: a new notice kind fails `tsc` here
 * until it decides whether the desktop app lifts it. The desktop autosave's two
 * notices are 'no': they are the desktop app's own. `output-sections-trimmed`
 * is 'no' too: the section caps (`MAX_ADDED_MATERIALS`, the mesh-list caps) are
 * the same on both builds, so the desktop app would trim the same file.
 */
const LIFTS: { readonly [K in LimitNotice['kind']]: Lift } = {
  'image-too-large': 'not-under-ignore',
  'image-too-many-pixels': 'no',
  'image-total-cap': 'yes',
  'image-revert-cap': 'yes',
  'image-resolution-cap': 'yes',
  'image-pick-cap': 'yes',
  'image-library-cap': 'yes',
  'image-device-downscaled': 'no',
  'images-stripped': 'yes',
  'storage-quota': 'yes',
  'images-stripped-on-load': 'no',
  'images-missing': 'no',
  'zip-limit': 'zip-size',
  'output-sections-trimmed': 'no',
  'autosave-file-failed': 'no',
  'autosave-file-read-failed': 'no',
};

/**
 * Whether the desktop app would have accepted what this notice refused.
 * `ignoreImageLimits` is the persisted preference the notice was raised under.
 *
 * For `zip-limit` the size compared is the notice's `value`, which zipReader
 * documents as a LOWER bound on the unpacked size (or the archive's own size
 * for the pre-read gate). A streamed archive that trips the web cap early may
 * therefore turn out larger than 256 MiB on desktop too; the note promises
 * "much larger files", not this one, so a lower bound is the honest input.
 */
export function desktopLiftsLimit(n: LimitNotice, ignoreImageLimits: boolean): boolean {
  switch (LIFTS[n.kind]) {
    case 'yes':
      return true;
    case 'not-under-ignore':
      return !ignoreImageLimits;
    case 'zip-size':
      return (
        n.zipLimit?.kind === 'total-size' &&
        Number.isFinite(n.zipLimit.value) &&
        n.zipLimit.value <= DESKTOP_MAX_TOTAL_UNCOMPRESSED
      );
    default:
      // 'no' — and anything a hand-built notice could carry that is not a kind.
      return false;
  }
}

/**
 * Whether the export the N1 dialog is refusing would reopen in the desktop
 * app: it crosses the SIZE cap only (the entry cap is the same 512 on both
 * builds) and fits the desktop reader's.
 */
export function exportLiftedByDesktop(r: {
  overSize: boolean;
  overEntries: boolean;
  sizeBytes: number;
}): boolean {
  return r.overSize && !r.overEntries && Number.isFinite(r.sizeBytes) && r.sizeBytes <= DESKTOP_MAX_TOTAL_UNCOMPRESSED;
}
