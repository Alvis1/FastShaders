import { parseCostFile, profileFromParsed, type ParsedCostFile } from '@/utils/costOverride';

/**
 * Same-browser handoff from a ShaderCarousel benchmark run to the cost bar.
 *
 * The bench pages share the editor's origin on every web deployment (they
 * already read `fs:savedGroups`), so when a run completes the bench writes its
 * derived device profile (the ~1 KB patch shape) under this key, and the cost
 * bar offers it as a one-click chip — no file download, no drag. The editor
 * listens for the cross-tab `storage` event, so the chip appears LIVE while
 * the bench tab is still showing its done popup.
 *
 * localStorage is UNTRUSTED input by this codebase's rules regardless of who
 * claims to have written it: the payload is length-capped here and then goes
 * through `parseCostFile` — the same adversarial gate a dropped file passes.
 * A payload that fails either check reads as "nothing pending" and the caller
 * clears the key so it cannot re-offer forever.
 */
export const BENCH_RESULT_KEY = 'fs:benchResult';

/** A profile is ~1–2 KB; anything near this cap is not a bench result. */
const MAX_BENCH_RESULT_CHARS = 32_768;

export interface PendingBenchResult {
  parsed: ParsedCostFile;
  /** Content-hashed profile id (budget-independent) — used for dedup. */
  profileId: string;
  /** Dropdown-style label for the chip (device, else bench, else generic). */
  label: string;
}

/**
 * Read the pending bench result, if one exists and is importable. Returns
 * null when the key is absent, oversized, unparseable, or when its
 * content-hashed profile id already exists in `existingProfileIds` (the run
 * was already imported — a re-offer would be noise). The id hash covers the
 * COSTS, so a genuinely new run on the same device still offers.
 *
 * Pure apart from the localStorage read; never writes. Callers decide when to
 * consume (`clearBenchResult`) — on import, on dismiss, and on the
 * duplicate/garbage cases so a dead value doesn't linger.
 */
export function readPendingBenchResult(
  existingProfileIds: readonly string[],
): PendingBenchResult | 'consumed' | null {
  let raw: string | null;
  try { raw = localStorage.getItem(BENCH_RESULT_KEY); } catch { return null; }
  if (!raw) return null;
  if (raw.length > MAX_BENCH_RESULT_CHARS) return 'consumed';
  const parsed = parseCostFile(raw);
  if (!parsed) return 'consumed';
  // Budget args don't participate in the id (it hashes provenance + costs),
  // so zeros are fine for a pure identity probe.
  const profileId = profileFromParsed(parsed, 0, 0).id;
  if (existingProfileIds.includes(profileId)) return 'consumed';
  const label = parsed.meta.device || parsed.meta.bench || 'measured device';
  return { parsed, profileId, label };
}

export function clearBenchResult(): void {
  try { localStorage.removeItem(BENCH_RESULT_KEY); } catch { /* private mode */ }
}
