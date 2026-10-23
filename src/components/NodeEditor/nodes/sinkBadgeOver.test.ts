/**
 * A SINK's point total turns red past the device's budget — on the canvas, on
 * every Output kind, and on the cards (the intro's budget slide draws one),
 * the same red the cost bar's total turns (owner, 2026-10-18).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('the over-budget sink badge', () => {
  it('compares against the SELECTED device\'s budget, through the one budget hook', () => {
    const hook = read('./useCostChrome.ts');
    // The device budget in table points, i.e. the printed 100 (utils/budgetPoints.ts).
    expect(hook).toContain('const max = useDeviceBudget();');
    expect(hook).toContain("return `node-base__cost-badge${cost > max ? ' node-base__cost-badge--over' : ''}`;");
  });

  it('every sink badge, and the Output card, takes the class', () => {
    for (const f of ['./OutputNode.tsx', './RaymarchOutputNode.tsx', './SplatOutputNode.tsx']) {
      const src = read(f);
      expect(src, f).toContain('const badgeClass = useSinkBadgeClass(cost);');
      expect(src, f).toContain('<span className={badgeClass} style={{ color: costTextColor }}>');
      // The snapshot is file data until the restamp: never arithmetic on it raw.
      expect(src, f).toContain('const cost = storedCost(data.cost);');
    }
    const card = read('../NodePreviewCard.tsx');
    const output = card.slice(card.indexOf('export function OutputCardContent('));
    expect(output).toContain('const badgeClass = useSinkBadgeClass(cost);');
  });

  it('is the cost bar\'s red, and beats the canvas ink rule', () => {
    const css = read('./NodeBase.css');
    expect(css).toMatch(/\.react-flow \.node-base__cost-badge\.node-base__cost-badge--over \{\s*color: var\(--cost-high\) !important;/);
    const bar = read('../../Layout/CostBar.css');
    expect(bar).toMatch(/\.cost-bar__value--over \{\s*color: var\(--cost-high\);/);
  });
});
