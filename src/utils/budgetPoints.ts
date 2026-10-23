import { formatFieldNumber } from './numberField';

/**
 * Points as the app SHOWS them: every device's budget is 100.
 *
 * The cost TABLE (complexity.json, a profile's `costs`, a device's
 * `maxPoints`) stays in its own currency — table points, measured on a Quest 3
 * whose frame is 200 of them — and every total is summed in it, so nothing
 * stored, exported or recorded by a study changes. Only the DISPLAY divides:
 * a surface prints `raw × 100 / budget`, the share of the selected device's
 * frame a node or a shader takes. Two devices therefore differ in their node
 * prices alone (owner, 2026-10-23: "all that changes are the node points"),
 * and the device dropdown no longer prints a budget beside each name.
 *
 * The sum is taken BEFORE the division and rounded only for print, so three
 * nodes of 1/3 point read 1, never 0.99.
 *
 * Imports only the numberField LEAF: the compare page (src/compare) prices
 * several devices side by side with the pure half, and must not reach the
 * store.
 */

/** Every device's budget, as printed. */
export const POINT_BUDGET = 100;

/** Decimals a point figure is printed with. */
export const POINT_DECIMALS = 2;

/** Decimals a rounded figure's tooltip gives — "the actual number". */
const EXACT_DECIMALS = 6;

/**
 * `raw` table points as budget points under a device whose measured budget is
 * `deviceBudget` table points. A non-positive or non-finite budget — junk no
 * resolver hands out — leaves the figure in table points rather than printing
 * NaN or Infinity.
 */
export function toBudgetPoints(raw: number, deviceBudget: number): number {
  return Number.isFinite(deviceBudget) && deviceBudget > 0 ? (raw * POINT_BUDGET) / deviceBudget : raw;
}

/** A point figure ready to print. */
export interface PointsLabel {
  /** At most two decimals, trailing zeros dropped: `17.5`, `23.33`, `4`. */
  text: string;
  /** The print dropped precision the value has: the surface marks it with a
   *  small centred dot and its tooltip carries `exact`. */
  rounded: boolean;
  /** Six decimals when `rounded`, else `text`. */
  exact: string;
}

/**
 * How every surface prints a point figure. A dot whatever the locale, the
 * number fields' rule (utils/numberField.ts). Non-finite input — a junk
 * snapshot out of a file — prints `0`, never `NaN`.
 */
export function formatPoints(value: number): PointsLabel {
  if (!Number.isFinite(value)) return { text: '0', rounded: false, exact: '0' };
  const text = formatFieldNumber(value, POINT_DECIMALS);
  // Relative slack: a figure that is exact in decimal is rarely exact in
  // binary (0.1 + 0.2), and float noise must not earn the dot.
  const rounded = Math.abs(value - Number(text)) > 1e-9 * Math.max(1, Math.abs(value));
  return { text, rounded, exact: rounded ? formatFieldNumber(value, EXACT_DECIMALS) : text };
}

/**
 * The SELECTED device's budget in table points — a module singleton beside
 * the active price table (utils/costTable.ts), set by the store at boot and on
 * every device selection (`setSelectedHeadsetId`, which also bumps
 * `costVersion`, so a React reader re-renders through `useDeviceBudget`).
 * Non-React code (the layout engine, NodeEditor's hit boxes) reads it
 * directly. 200 until then: VR_HEADSETS[0]'s budget.
 */
let deviceBudget = 200;

export function setDeviceBudget(points: number): void {
  if (Number.isFinite(points) && points > 0) deviceBudget = points;
}

export function getDeviceBudget(): number {
  return deviceBudget;
}

/** `raw` table points as budget points under the selected device. */
export function budgetPointsOf(raw: number): number {
  return toBudgetPoints(raw, deviceBudget);
}
