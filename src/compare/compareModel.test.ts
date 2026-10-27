import { describe, it, expect, afterEach } from 'vitest';
import {
  builtinDevices, storedDevices, devicesFromFile, mergeFileDevices, displayLabel,
  readLinkIds, writeLinkIds, selectionFromLink, defaultSelection, linkIdsOf,
  toggleDevice, makeReference, pruneSelection,
  compareGroups, priceNoteOf, cellPoints, pointsDelta, compareTable, filterSections, languageOf,
  MAX_COLUMNS, MAX_LISTED_PROFILES, LINK_PARAM,
} from './compareModel';
import { VR_HEADSETS, deviceCostOverrides } from '@/registry/vrHeadsets';
import { CATEGORIES } from '@/registry/nodeCategories';
import { getAllDefinitions, NODE_REGISTRY } from '@/registry/nodeRegistry';
import { HIDDEN_NODE_TYPES } from '@/registry/editorVisibility';
import { getBaseCosts, setCostOverrides } from '@/utils/costTable';
import { freshNodeCost } from '@/utils/typeCost';
import { budgetPointsOf, getDeviceBudget, setDeviceBudget, toBudgetPoints, formatPoints } from '@/utils/budgetPoints';
import { nodeCostPoints } from '@/utils/nodeCost';
import {
  buildProfileFile, buildProfileBundle, createManualProfile, profileFromParsed, parseCostFile,
  type CostProfile,
} from '@/utils/costOverride';
import { makeNode, makeEdge } from '@/test-utils';

/**
 * The device-comparison page's pure half (compareModel.ts). The page itself
 * (ComparePage.tsx) cannot mount under the `node` env; everything it decides
 * — which devices exist, which a link selects, what a cell prints — lives
 * here. The cost table and the budget are worker-wide singletons
 * (isolate:false): the one test that selects a device the app's way puts both
 * back.
 */

const BUDGET_BEFORE = getDeviceBudget();

/** The page lists what the palette lists: a node unticked "In editor"
 *  (editorVisibility.json) has no row. Every expectation that names nodes goes
 *  through this, so the suite stays green with nodes actually hidden — release
 *  runs it before deploying (docs/dev/discovery-and-i18n.md). */
const listed = (type: string): boolean => !HIDDEN_NODE_TYPES.has(type);
afterEach(() => {
  setCostOverrides(null);
  setDeviceBudget(BUDGET_BEFORE);
});

const measuredRun = (device: string, costs: Record<string, number>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ metadata: { device, bench: 'microplane', date: '2026-10-21', ...extra },
    suggestions: Object.entries(costs).map(([id, suggestedPoints]) => ({ id, suggestedPoints })) });

const storedJson = (profiles: CostProfile[]) => JSON.stringify(profiles);

const measuredProfile = (device: string, costs: Record<string, number>, maxPoints = 200): CostProfile =>
  profileFromParsed(parseCostFile(measuredRun(device, costs))!, maxPoints, 2048);

describe('the device list', () => {
  it('lists every built-in row, keyed apart from profiles, with its measured prices', () => {
    const b = builtinDevices();
    expect(b.map((d) => d.linkId)).toEqual(VR_HEADSETS.map((h) => h.id));
    expect(b.every((d) => d.kind === 'builtin' && d.key === `b:${d.linkId}` && d.mark === '')).toBe(true);
    const quest = b.find((d) => d.linkId === 'quest3')!;
    const frame = b.find((d) => d.linkId === 'steamframe')!;
    expect(quest.costs).toBeNull(); // the table IS Quest 3
    expect(frame.costs).toEqual(VR_HEADSETS.find((h) => h.id === 'steamframe')!.costs);
    expect(frame.basis).toBe('steamframe-20261021');
  });

  it("reads this browser's profiles through the app's reader, marked as the dropdown marks them", () => {
    const measured = measuredProfile('Pico 4', { perlin: 50 });
    const invalid = profileFromParsed(parseCostFile(measuredRun('Old run', { fbm: 99 }, { valid: false, reasons: ['vsync-clamped'] }))!, 200, 2048);
    const manual = createManualProfile('My device', 250, 2048, new Date('2026-10-23T10:00:00Z'));
    const list = storedDevices(storedJson([measured, invalid, manual]));
    expect(list.map((d) => [d.kind, d.mark, d.label, d.linkId === d.profile!.id, d.key])).toEqual([
      ['stored', '◆', 'Pico 4', true, `s:${measured.id}`],
      ['stored', '⚠', 'Old run', true, `s:${invalid.id}`],
      ['stored', '✎', 'My device', true, `s:${manual.id}`],
    ]);
    expect(list[1].reasons).toEqual(['vsync-clamped']);
    expect(list[2].maxPoints).toBe(250);
  });

  it('survives junk, and never lets a stored row stand in for a built-in or repeat an id', () => {
    expect(storedDevices(null)).toEqual([]);
    expect(storedDevices('not json')).toEqual([]);
    expect(storedDevices('{"a":1}')).toEqual([]);
    const fake = { ...measuredProfile('X', { perlin: 1 }), id: 'quest3' };
    const twin = measuredProfile('Y', { perlin: 2 });
    const list = storedDevices(storedJson([fake, twin, { ...twin, label: 'second copy' }]));
    expect(list.map((d) => d.label)).toEqual(['Y']);
  });

  it('caps what it lists, and strips control and format characters from a label', () => {
    const many = Array.from({ length: MAX_LISTED_PROFILES + 20 }, (_, i) => ({ ...measuredProfile('D', { perlin: i }), id: `cp:${i}` }));
    expect(storedDevices(storedJson(many))).toHaveLength(MAX_LISTED_PROFILES);
    const sneaky = { ...measuredProfile('X', { perlin: 3 }), label: 'Quest‮ 3​\n  edited' };
    expect(storedDevices(storedJson([sneaky]))[0].label).toBe('Quest 3 edited');
    expect(displayLabel('‮​', 'fallback')).toBe('fallback');
    expect(displayLabel(42, 'fallback')).toBe('fallback');
    expect(Array.from(displayLabel('é'.repeat(80) + '😀', '?'))).toHaveLength(60);
    // An invalid run's reasons reach a title: cleaned the same way, and bounded.
    const loud = { ...measuredProfile('Loud', { perlin: 4 }), meta: {
      ...measuredProfile('Loud', { perlin: 4 }).meta, valid: false,
      reasons: ['‮flipped', 'x'.repeat(5000), ...Array.from({ length: 30 }, (_, i) => `r${i}`)],
    } };
    const [d] = storedDevices(storedJson([loud]));
    expect(d.mark).toBe('⚠');
    expect(d.reasons).toHaveLength(8);
    expect(d.reasons[0]).toBe('flipped');
    expect(d.reasons[1]).toHaveLength(200);
  });
});

describe('files dropped on the page', () => {
  it('a bench export becomes ONE device under the first headset’s budget', () => {
    const read = devicesFromFile(measuredRun('Adreno 650', { perlin: 70, voronoi: 400 }), 'run.json', [])!;
    expect(read.bundle).toBe(false);
    expect(read.devices).toHaveLength(1);
    const d = read.devices[0];
    expect([d.kind, d.mark, d.label, d.linkId, d.maxPoints]).toEqual(['file', '◆', 'Adreno 650', '', VR_HEADSETS[0].maxPoints]);
    expect(d.key.startsWith('f:')).toBe(true);
    expect(d.costs).toEqual({ perlin: 70, voronoi: 400 });
  });

  it('a bundle is read whole, and a file that is no cost file is refused', () => {
    const a = createManualProfile('A', 200, 2048, new Date('2026-10-23T10:00:00Z'));
    const b = createManualProfile('B', 300, 2048, new Date('2026-10-23T11:00:00Z'));
    const read = devicesFromFile(JSON.stringify(buildProfileBundle([a, b])), 'all.json', [])!;
    expect(read.bundle).toBe(true);
    expect(read.devices.map((d) => [d.label, d.maxPoints])).toEqual([['A', 200], ['B', 300]]);
    expect(devicesFromFile('{"hello":1}', 'x.json', [])).toBeNull();
    expect(devicesFromFile('not json at all', 'x.json', [])).toBeNull();
  });

  it("an edited copy of a stored profile is a column BESIDE it, and can never take over a measured one's id", () => {
    const manual = createManualProfile('Mine', 200, 2048, new Date('2026-10-23T10:00:00Z'));
    const edited = { ...manual, costs: { ...manual.costs, perlin: 99 } };
    const stored = storedDevices(storedJson([manual]));
    const read = devicesFromFile(JSON.stringify(buildProfileFile(edited)), 'mine.json', [manual])!;
    expect(read.devices[0].profile!.id).toBe(manual.id); // the edit round-trip keeps the id…
    expect(read.devices[0].key).not.toBe(stored[0].key); // …and the page keeps both columns

    const measured = measuredProfile('Quest 3', { perlin: 30 });
    const forged = { ...buildProfileFile(measured), costs: { perlin: 1 } };
    const refused = devicesFromFile(JSON.stringify(forged), 'forged.json', [measured])!.devices[0];
    expect(refused.profile!.id).not.toBe(measured.id);
    expect(refused.mark).toBe('✎'); // typed numbers never wear the measured mark
  });

  it('a re-drop replaces its device in place; the list is capped', () => {
    const first = devicesFromFile(measuredRun('A', { perlin: 1 }), 'a.json', [])!.devices;
    const second = devicesFromFile(measuredRun('B', { perlin: 2 }), 'b.json', [])!.devices;
    const again = devicesFromFile(measuredRun('A', { perlin: 1 }), 'a-copy.json', [])!.devices;
    const list = mergeFileDevices(mergeFileDevices(first, second), again);
    expect(list.map((d) => d.label)).toEqual(['A', 'B']);
    expect(list[0]).toBe(again[0]);
    const full = Array.from({ length: MAX_LISTED_PROFILES }, (_, i) => ({ ...first[0], key: `f:${i}` }));
    expect(mergeFileDevices(full, second)).toHaveLength(MAX_LISTED_PROFILES);
  });
});

describe('the link', () => {
  it('names the columns in order, an id with a comma intact', () => {
    const ids = ['quest3', 'cp:Adreno 7xx, rev 2|microplane|2026-10-21|abc', 'cp:Ž+ā'];
    const search = writeLinkIds('?lang=x', ids);
    expect(search.startsWith('?lang=x&d=quest3,cp%3AAdreno')).toBe(true);
    expect(readLinkIds(search)).toEqual(ids);
    expect(writeLinkIds('', ['quest3', 'steamframe'])).toBe(`?${LINK_PARAM}=quest3,steamframe`);
  });

  it('replaces its own parameter, keeps every other one, and leaves none for no ids', () => {
    expect(writeLinkIds('?a=1&d=old&b=2', ['quest3'])).toBe('?a=1&b=2&d=quest3');
    expect(writeLinkIds('?d=old', [])).toBe('');
    expect(writeLinkIds('?a=1&d=old', [])).toBe('?a=1');
  });

  it('reads the first d, form-decoded; malformed, empty, repeated and oversized ids are dropped', () => {
    expect(readLinkIds('?d=quest3,steamframe&d=other')).toEqual(['quest3', 'steamframe']);
    expect(readLinkIds('d=a+b,%E0%A4%A,,quest3,quest3')).toEqual(['a b', 'quest3']);
    expect(readLinkIds(`?d=${'x'.repeat(201)},quest3`)).toEqual(['quest3']);
    expect(readLinkIds('?x=1')).toEqual([]);
    expect(readLinkIds(`?d=${Array.from({ length: 50 }, (_, i) => `id${i}`).join(',')}`)).toHaveLength(MAX_COLUMNS);
  });

  it('selects built-ins before stored profiles, ignores unknown ids, and falls back to every built-in', () => {
    const p = measuredProfile('Pico', { perlin: 9 });
    const devices = [...builtinDevices(), ...storedDevices(storedJson([p]))];
    expect(selectionFromLink(['steamframe', 'nope', p.id, 'quest3'], devices)).toEqual(['b:steamframe', `s:${p.id}`, 'b:quest3']);
    expect(selectionFromLink(['nope'], devices)).toEqual(defaultSelection(devices));
    expect(defaultSelection(devices)).toEqual(VR_HEADSETS.map((h) => `b:${h.id}`));
    expect(linkIdsOf([`s:${p.id}`, 'f:whatever', 'b:quest3'], devices)).toEqual([p.id, 'quest3']);
  });
});

describe('the selection', () => {
  it('a chip appends or removes; the cap holds', () => {
    expect(toggleDevice(['b:quest3'], 'b:steamframe')).toEqual(['b:quest3', 'b:steamframe']);
    expect(toggleDevice(['b:quest3', 'b:steamframe'], 'b:quest3')).toEqual(['b:steamframe']);
    const full = Array.from({ length: MAX_COLUMNS }, (_, i) => `f:${i}`);
    expect(toggleDevice(full, 'b:quest3')).toEqual(full);
  });

  it('making a column the reference moves it first, the rest keeping their order', () => {
    expect(makeReference(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(makeReference(['a', 'b'], 'zzz')).toEqual(['a', 'b']);
  });

  it('a vanished device leaves the selection, and nothing vanishing keeps the SAME array', () => {
    const devices = builtinDevices();
    const sel = ['b:quest3', 's:gone'];
    expect(pruneSelection(sel, devices)).toEqual(['b:quest3']);
    const kept = ['b:quest3'];
    expect(pruneSelection(kept, devices)).toBe(kept);
  });
});

describe('the rows', () => {
  const groups = compareGroups();
  const types = groups.flatMap((g) => g.rows.map((r) => r.type));

  it('are every node a user can add that the table prices, grouped in CATEGORIES order', () => {
    const base = getBaseCosts();
    const expected = getAllDefinitions()
      .filter((d) => d.type !== 'output' && !HIDDEN_NODE_TYPES.has(d.type))
      .map((d) => d.type);
    expect(new Set(types)).toEqual(new Set([...expected, 'dataNode']));
    expect(types.every((t) => base[t] !== undefined)).toBe(true);
    expect(types).not.toContain('output');
    expect(types).not.toContain('unknown');
    for (const sink of ['raymarchOutput', 'splatOutput'].filter(listed)) expect(types).toContain(sink);
    const order = CATEGORIES.map((c) => c.id);
    const seen = groups.map((g) => order.indexOf(g.category));
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(groups.map((g) => g.category)).size).toBe(groups.length);
    // Registry order inside a group: the Add-node menu's.
    const noise = groups.find((g) => g.category === 'noise')!.rows.map((r) => r.type);
    expect(noise).toEqual(getAllDefinitions().filter((d) => d.category === 'noise' && listed(d.type)).map((d) => d.type));
    expect(groups.find((g) => g.rows.some((r) => r.type === 'dataNode'))!.category).toBe(NODE_REGISTRY.get('dataNode')!.category);
  });

  it('notes exactly the types whose canvas price can move off the fresh one', () => {
    const noted = Object.fromEntries(groups.flatMap((g) => g.rows).filter((r) => r.note).map((r) => [r.type, r.note]));
    expect(noted).toEqual(Object.fromEntries(Object.entries({
      add: 'operands', sub: 'operands', mul: 'operands', div: 'operands',
      imageNode: 'resolution', rgbCurves: 'curves', raymarchOutput: 'march',
    }).filter(([type]) => listed(type))));
    expect(priceNoteOf(NODE_REGISTRY.get('append')!)).toBeNull(); // grows sockets, priced flat
    // …and each note is TRUE of the canvas price (utils/nodeCost.ts), on the shipped table:
    const three = [makeEdge('x', 'out', 'n', 'a'), makeEdge('y', 'out', 'n', 'b'), makeEdge('z', 'out', 'n', 'c')];
    expect(nodeCostPoints(makeNode('n', 'div'), three)).toBe(2 * freshNodeCost('div')!);
    expect(nodeCostPoints(makeNode('n', 'imageNode', { width: 256, height: 256 }), [])).toBeLessThan(freshNodeCost('imageNode')!);
    expect(nodeCostPoints(makeNode('n', 'rgbCurves', { extend: 'horizontal' }), [])).toBeGreaterThan(freshNodeCost('rgbCurves')!);
    // A node without a note is charged its fresh price whatever its stored values.
    for (const type of types.filter((t) => !noted[t])) {
      const def = NODE_REGISTRY.get(type)!;
      expect(nodeCostPoints(makeNode('n', type, { ...def.defaultValues }), []), type).toBe(freshNodeCost(type));
    }
  });
});

describe('a cell', () => {
  it("is what the editor's palette tile prints while that device is selected", () => {
    const profile = measuredProfile('Pico 4', { perlin: 50, colormap: 10, add: 3 }, 160);
    const devices = [...builtinDevices(), ...storedDevices(storedJson([profile]))];
    const types = compareGroups().flatMap((g) => g.rows.map((r) => r.type));
    for (const d of devices) {
      // The store's selection path: its prices over the table, its budget behind the print.
      setCostOverrides(deviceCostOverrides(d.linkId, d.profile ? [d.profile] : []));
      setDeviceBudget(d.maxPoints);
      for (const type of types) expect(cellPoints(type, d), `${d.label} ${type}`).toBe(budgetPointsOf(freshNodeCost(type)!));
    }
  });

  it('prices under ITS device only — the app’s active table is never consulted', () => {
    setCostOverrides({ perlin: 999 });
    const quest = builtinDevices().find((d) => d.linkId === 'quest3')!;
    expect(cellPoints('perlin', quest)).toBe(toBudgetPoints(getBaseCosts().perlin, 200));
    expect(cellPoints('notANode', quest)).toBeNull();
  });

  it('a profile that moves only colormap reprices all three LUT nodes, its RGB Curves fresh node staying 1', () => {
    const p = storedDevices(storedJson([measuredProfile('L', { colormap: 10 })]))[0];
    expect([cellPoints('colormap', p), cellPoints('colorRamp', p), cellPoints('rgbCurves', p)])
      .toEqual([10, 10, 1].map((raw) => toBudgetPoints(raw, 200)));
  });

  it('a difference is exactly 0 for one figure computed twice, and signed otherwise', () => {
    expect(pointsDelta(0.1 + 0.2, 0.3)).toBe(0);
    expect(pointsDelta(toBudgetPoints(7, 300), toBudgetPoints(14, 600))).toBe(0);
    expect(pointsDelta(12.5, 17.5)).toBe(-5);
    expect(pointsDelta(1, 0)).toBe(1);
  });
});

describe('the table', () => {
  const groups = compareGroups();
  const [quest, frame] = ['quest3', 'steamframe'].map((id) => builtinDevices().find((d) => d.linkId === id)!);

  it('compares every column with the first: Steam Frame differs from Quest 3 in the noises it was measured on', () => {
    const table = compareTable(groups, [quest, frame]);
    const lines = table.flatMap((s) => s.lines);
    const differing = lines.filter((l) => l.differs).map((l) => l.row.type).sort();
    expect(differing).toEqual(Object.keys(frame.costs!).filter(listed).sort());
    const perlin = lines.find((l) => l.row.type === 'perlin');
    if (listed('perlin')) expect(perlin?.values).toEqual([17.5, 12.5]);
    if (listed('perlin')) expect(perlin?.deltas).toEqual([0, -5]);
    const add = lines.find((l) => l.row.type === 'add')!;
    expect(add.deltas).toEqual([0, 0]);
    // Swapping the reference flips every sign.
    const swapped = compareTable(groups, [frame, quest]).flatMap((s) => s.lines).find((l) => l.row.type === 'perlin');
    if (listed('perlin')) expect(swapped?.deltas).toEqual([0, 5]);
  });

  it('a different BUDGET is a difference too, printed with the dot when it rounds', () => {
    const strict = storedDevices(storedJson([{ ...measuredProfile('Strict', { perlin: 35 }), maxPoints: 300 }]))[0];
    const line = compareTable(groups, [quest, strict]).flatMap((s) => s.lines).find((l) => l.row.type === 'add')!;
    expect(line.deltas[1]).toBeCloseTo(1 / 3 - 1 / 2, 12);
    expect(formatPoints(Math.abs(line.deltas[1]))).toEqual({ text: '0.17', rounded: true, exact: '0.166667' });
  });

  it('no column, no figures', () => {
    const empty = compareTable(groups, []);
    expect(empty.every((s) => s.lines.every((l) => l.values.length === 0 && !l.differs))).toBe(true);
  });

  it('a search keeps names and aliases, or a whole category by its name; the switch keeps what differs', () => {
    const table = compareTable(groups, [quest, frame]);
    const typesOf = (s: ReturnType<typeof filterSections>) => s.flatMap((x) => x.lines.map((l) => l.row.type));
    expect(typesOf(filterSections(table, 'perlin', false, 'en'))).toEqual(['perlin', 'perlinVec3'].filter(listed));
    expect(typesOf(filterSections(table, '  NOISE ', false, 'en'))).toEqual(
      getAllDefinitions().filter((d) => d.category === 'noise' && listed(d.type)).map((d) => d.type),
    );
    // Prose does not match: "multiplier" sits in Time's description, never in Multiply's name.
    expect(typesOf(filterSections(table, 'multiplier', false, 'en'))).toEqual([]);
    expect(typesOf(filterSections(table, '', true, 'en')).sort()).toEqual(Object.keys(frame.costs!).filter(listed).sort());
    expect(typesOf(filterSections(table, 'add', true, 'en'))).toEqual([]);
    expect(filterSections(compareTable(groups, [quest]), '', true, 'en')).toEqual([]);
  });

  it('a Latvian name matches in Latvian', () => {
    const table = compareTable(groups, [quest]);
    const lv = filterSections(table, 'reizināt', false, 'lv').flatMap((s) => s.lines.map((l) => l.row.type));
    expect(lv).toContain('mul');
  });

  it('a Latvian name or category typed without its diacritics matches too', () => {
    const table = compareTable(groups, [quest]);
    const typesOf = (q: string) => filterSections(table, q, false, 'lv').flatMap((s) => s.lines.map((l) => l.row.type));
    expect(typesOf('reizinat')).toEqual(typesOf('reizināt'));
    expect(typesOf('reizinat')).toContain('mul');
    // "Matemātika" typed plain keeps the whole Math group, as the marked spelling does.
    expect(typesOf('matematika')).toEqual(typesOf('matemātika'));
    expect(typesOf('matematika').length).toBeGreaterThan(0);
  });
});

describe('the language', () => {
  it("is Latvian only for the exact stored 'lv', the store's rule", () => {
    expect(languageOf('lv')).toBe('lv');
    for (const v of [null, '', 'en', 'LV', ' lv', 'lv\n']) expect(languageOf(v)).toBe('en');
  });
});
