/**
 * node-editor.html — localhost-only overview + editor for FastShaders' node registry
 * and built-in textures.
 *
 * Rows = all registry nodes (getAllDefinitions()) + all built-in textures.
 * Descriptions, search aliases and citations are editable and saved back to
 * source through the dev-only `/__nd` endpoints; outside `npm run dev` those
 * 404 and Save is disabled (see the DEV NOTE banner).
 *
 * SAFETY: this page shares its origin with the real app. src/nodeEditor.tsx calls
 * `setGraphPersistence(false)` before this component can mount — that is what
 * makes GraphModal's store writes safe. Never write the store from a path that
 * could run before it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getAllDefinitions, getFlowNodeType } from '@/registry/nodeRegistry';
import { getBuiltinTextures } from '@/registry/builtinTextures';
import { CATEGORIES } from '@/registry/nodeCategories';
import { CAT_HEX, getContrastColor } from '@/utils/colorUtils';
import { splitAliases, joinAliases } from '@/registry/descriptionSplice';
import { getCitation, CITATIONS, type Citation } from '@/registry/citations';
import complexityData from '@/registry/complexity.json';
import type { AppNode, AppEdge, NodeCategory, NodeDefinition } from '@/types';
import type { BuiltinTexture } from '@/registry/builtinTextures';
// The content browser's own tiles — reused verbatim so the previews here are the
// same artwork the app ships, not a second implementation that could drift from
// NODE_DESIGN_REQUIREMENTS.md. Their built-in click/drag handlers add nodes to a
// canvas, which is meaningless on this page; `.gp__preview` neutralizes them with
// pointer-events:none so the surrounding cell button owns the interaction.
import { NodePreviewCard } from '@/components/NodeEditor/NodePreviewCard';
import { TextureCard } from '@/components/NodeEditor/TextureCard';
import { GraphModal } from './GraphModal';
import { DesignerModal } from './DesignerModal';
import './GraphsPage.css';

/** NodePreviewCard requires a drag handler; dragging goes nowhere on this page. */
const noopDragStart = () => {};

// ─── Row model ──────────────────────────────────────────────────────────────

type Kind = 'node' | 'texture';

interface Row {
  kind: Kind;
  /** Node type ('sin') or texture id ('polka-dots') — the description-patch key. */
  key: string;
  name: string;
  category: NodeCategory;
  /** Description head — the "Also:" tail is split off into `aliases`. */
  description: string;
  /** The "Also:" tail: search-only aliases, never shown in tooltips. */
  aliases: string;
  /** Read-only TSL: def.tslFunction for nodes, the full source for textures. */
  tsl: string;
  nodes: AppNode[];
  edges: AppEdge[];
  /**
   * True when the Node Designer can actually edit this row's appearance, i.e.
   * `getFlowNodeType(def) === 'shader'` — the glyph path. Everything else (the
   * live-canvas nodes: time/color/sin/cos/the 8 noise nodes/output, plus every
   * texture) paints itself with a bespoke component and has no glyph to design,
   * so those rows keep opening the read-only GraphModal instead of routing the
   * user to a tool that can't touch them.
   */
  designable: boolean;
  /** Node rows only — backs the NodePreviewCard shown in the Graph column. */
  def?: NodeDefinition;
  /** Texture rows only — backs the TextureCard shown in the Graph column. */
  texture?: BuiltinTexture;
}

interface Edits {
  description: string;
  aliases: string;
  ref: string;
  url: string;
}

const rowId = (r: { kind: Kind; key: string }) => `${r.kind}:${r.key}`;

/** Build the single-node graph a node row's modal shows. Mirrors codeToGraph's createNode. */
function singleNodeGraph(def: NodeDefinition): AppNode[] {
  const costs = complexityData.costs as Record<string, number>;
  return [
    {
      id: `preview-${def.type}`,
      type: getFlowNodeType(def),
      position: { x: 0, y: 0 },
      data: {
        registryType: def.type,
        label: def.label,
        cost: costs[def.type] ?? 0,
        values: { ...def.defaultValues },
      },
    } as AppNode,
  ];
}

function buildRows(): Row[] {
  const nodeRows: Row[] = getAllDefinitions().map((def) => {
    const split = splitAliases(def.description ?? '');
    return {
      kind: 'node' as const,
      key: def.type,
      name: def.label,
      category: def.category,
      description: split.description,
      aliases: split.aliases,
      tsl: def.tslFunction,
      nodes: singleNodeGraph(def),
      edges: [],
      designable: getFlowNodeType(def) === 'shader',
      def,
    };
  });

  const textureRows: Row[] = getBuiltinTextures().map((tex) => {
    const split = splitAliases(tex.description ?? '');
    return {
      kind: 'texture' as const,
      key: tex.id,
      name: tex.name,
      category: 'texture' as NodeCategory,
      description: split.description,
      aliases: split.aliases,
      tsl: tex.code,
      nodes: tex.nodes,
      edges: tex.edges,
      designable: false,
      texture: tex,
    };
  });

  return [...nodeRows, ...textureRows];
}

function seedEdits(rows: Row[]): Record<string, Edits> {
  const out: Record<string, Edits> = {};
  for (const r of rows) {
    const cit = getCitation(r.kind, r.key);
    out[rowId(r)] = {
      description: r.description,
      aliases: r.aliases,
      ref: cit?.ref ?? '',
      url: cit?.url ?? '',
    };
  }
  return out;
}

// ─── Small pieces ───────────────────────────────────────────────────────────

function CategoryChip({ category }: { category: NodeCategory }) {
  const hex = CAT_HEX[category] ?? CAT_HEX.unknown;
  return (
    <span className="gp__chip" style={{ background: hex, color: getContrastColor(hex) }}>
      {category}
    </span>
  );
}

/** Textarea that grows to fit its content — descriptions are 1–4 lines. */
function AutoTextarea({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const resize = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  return (
    <textarea
      className="gp__ta"
      ref={resize}
      value={value}
      placeholder={placeholder}
      rows={1}
      onChange={(e) => {
        resize(e.currentTarget);
        onChange(e.target.value);
      }}
    />
  );
}

type SortKey = 'name' | 'category';

// ─── Page ───────────────────────────────────────────────────────────────────

export function GraphsPage() {
  const rows = useMemo(buildRows, []);
  const baseline = useMemo(() => seedEdits(rows), [rows]);
  const [edits, setEdits] = useState<Record<string, Edits>>(() => seedEdits(rows));

  const [query, setQuery] = useState('');
  const [activeCats, setActiveCats] = useState<Set<NodeCategory>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>('category');
  const [sortAsc, setSortAsc] = useState(true);
  const [modal, setModal] = useState<Row | null>(null);
  /** Designer deep-link target — set only for `designable` rows. */
  const [designerRow, setDesignerRow] = useState<Row | null>(null);

  /** null = still probing, true/false = /__nd availability. */
  const [devAvailable, setDevAvailable] = useState<boolean | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // ── Dev-endpoint probe ────────────────────────────────────────────────────
  // A built/deployed copy has no /__nd middleware; the page still reads fine,
  // it just can't write. Probe once and disable Save if absent.
  useEffect(() => {
    let cancelled = false;
    fetch('/__nd/descriptions')
      .then((res) => {
        if (!cancelled) setDevAvailable(res.ok);
      })
      .catch(() => {
        if (!cancelled) setDevAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Dirty tracking ────────────────────────────────────────────────────────
  const dirtyIds = useMemo(() => {
    const out = new Set<string>();
    for (const r of rows) {
      const id = rowId(r);
      const a = baseline[id];
      const b = edits[id];
      if (!a || !b) continue;
      if (a.description !== b.description || a.aliases !== b.aliases || a.ref !== b.ref || a.url !== b.url) {
        out.add(id);
      }
    }
    return out;
  }, [rows, baseline, edits]);

  useEffect(() => {
    if (dirtyIds.size === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirtyIds]);

  const patch = useCallback(
    (id: string, field: keyof Edits, value: string) => {
      setEdits((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
    },
    []
  );

  // ── Filter + sort ─────────────────────────────────────────────────────────
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = rows.filter((r) => {
      if (activeCats.size > 0 && !activeCats.has(r.category)) return false;
      if (!q) return true;
      const e = edits[rowId(r)];
      return (
        r.name.toLowerCase().includes(q) ||
        r.key.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        e.aliases.toLowerCase().includes(q)
      );
    });
    out = [...out].sort((a, b) => {
      const dir = sortAsc ? 1 : -1;
      if (sortKey === 'name') return dir * a.name.localeCompare(b.name);
      const cat = a.category.localeCompare(b.category);
      return cat !== 0 ? dir * cat : a.name.localeCompare(b.name);
    });
    return out;
  }, [rows, query, activeCats, sortKey, sortAsc, edits]);

  const toggleCat = (cat: NodeCategory) => {
    setActiveCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  // ── Save ──────────────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    if (!devAvailable || dirtyIds.size === 0 || saving) return;
    setSaving(true);
    setSaveMsg(null);

    // Descriptions: only dirty rows, value = the FULL string (head + "Also:" tail),
    // which is exactly what the registry source holds.
    const registry: Record<string, string> = {};
    const textures: Record<string, string> = {};
    for (const r of rows) {
      const id = rowId(r);
      if (!dirtyIds.has(id)) continue;
      const e = edits[id];
      if (e.description === baseline[id].description && e.aliases === baseline[id].aliases) continue;
      const full = joinAliases(e.description, e.aliases);
      if (r.kind === 'node') registry[r.key] = full;
      else textures[r.key] = full;
    }

    // Citations: the endpoint rewrites the WHOLE file, so send every entry —
    // not just the dirty ones — or the untouched ones would be dropped. Seed
    // from CITATIONS first: it may hold keys this table has no row for (the 3
    // hidden defs — unknown/dataNode/imageNode — aren't in getAllDefinitions()),
    // and those must survive a save from this page.
    const citNodes: Record<string, Citation> = { ...CITATIONS.nodes };
    const citTextures: Record<string, Citation> = { ...CITATIONS.textures };
    for (const r of rows) {
      const e = edits[rowId(r)];
      const ref = e.ref.trim();
      const target = r.kind === 'node' ? citNodes : citTextures;
      // An emptied ref means "remove this citation", not "keep the seeded one".
      if (!ref) {
        delete target[r.key];
        continue;
      }
      target[r.key] = e.url.trim() ? { ref, url: e.url.trim() } : { ref };
    }

    const descCount = Object.keys(registry).length + Object.keys(textures).length;
    const citDirty = [...dirtyIds].some((id) => {
      const a = baseline[id];
      const b = edits[id];
      return a.ref !== b.ref || a.url !== b.url;
    });

    try {
      const done: string[] = [];
      if (descCount > 0) {
        const res = await fetch('/__nd/descriptions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ registry, textures }),
        });
        if (!res.ok) throw new Error(`descriptions → ${res.status} ${await res.text()}`);
        done.push(
          `${Object.keys(registry).length} node description(s), ${Object.keys(textures).length} texture description(s)`
        );
      }
      if (citDirty) {
        const res = await fetch('/__nd/citations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodes: citNodes, textures: citTextures }),
        });
        if (!res.ok) throw new Error(`citations → ${res.status} ${await res.text()}`);
        done.push(
          `citations.json rewritten (${Object.keys(citNodes).length} node, ${Object.keys(citTextures).length} texture)`
        );
      }
      setSaveMsg(done.length ? `Saved: ${done.join(' · ')}. HMR will reload the app's tooltips.` : 'Nothing to write.');
      // Baseline is a useMemo over `rows` and can't be reassigned; a reload picks
      // up the on-disk truth. Tell the user the write landed instead of faking
      // a clean state we can't verify.
    } catch (err) {
      setSaveMsg(`Save failed — ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [devAvailable, dirtyIds, saving, rows, edits, baseline]);

  const catsInUse = useMemo(() => {
    const present = new Set(rows.map((r) => r.category));
    return CATEGORIES.filter((c) => present.has(c.id));
  }, [rows]);

  const nodeCount = rows.filter((r) => r.kind === 'node').length;
  const texCount = rows.filter((r) => r.kind === 'texture').length;

  return (
    <div className="gp">
      <header className="gp__top">
        <h1 className="gp__h1">Node &amp; Graph Overview</h1>
        <span className="gp__meta">
          {nodeCount} nodes · {texCount} textures
        </span>
        <input
          className="gp__search"
          type="search"
          placeholder="filter by name, type, description, aliases…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="gp__spacer" />
        {saveMsg && <span className="gp__savemsg">{saveMsg}</span>}
        {dirtyIds.size > 0 && <span className="gp__dirtypill">{dirtyIds.size} unsaved</span>}
        <button
          className="gp__save"
          onClick={save}
          disabled={!devAvailable || dirtyIds.size === 0 || saving}
          title={
            devAvailable === false
              ? 'The /__nd endpoint exists only under `npm run dev`'
              : 'Write descriptions + citations back to source'
          }
        >
          {saving ? 'Saving…' : `Save${dirtyIds.size > 0 ? ` (${dirtyIds.size})` : ''}`}
        </button>
      </header>

      {devAvailable === false && (
        <div className="gp__devnote">
          ⚠ <b>Local tool</b> — run <code>npm run dev</code> and open{' '}
          <code>http://localhost:5173/FastShaders/node-editor.html</code>. Saving writes{' '}
          <code>nodeRegistry.ts</code>, <code>builtinTextures.ts</code> and <code>citations.json</code> through the dev
          server and <b>works locally only</b> (the <code>/__nd</code> endpoint exists in dev only). This copy is
          read-only.
        </div>
      )}

      <div className="gp__chips">
        {catsInUse.map((c) => {
          const on = activeCats.has(c.id);
          const hex = CAT_HEX[c.id] ?? CAT_HEX.unknown;
          return (
            <button
              key={c.id}
              className={`gp__catbtn${on ? ' is-on' : ''}`}
              style={on ? { background: hex, color: getContrastColor(hex), borderColor: hex } : { borderColor: hex }}
              onClick={() => toggleCat(c.id)}
            >
              {c.label}
            </button>
          );
        })}
        {activeCats.size > 0 && (
          <button className="gp__catbtn gp__catclear" onClick={() => setActiveCats(new Set())}>
            clear
          </button>
        )}
        <span className="gp__count">
          {visible.length} / {rows.length}
        </span>
      </div>

      <div className="gp__tablewrap">
        <table className="gp__table">
          <thead>
            <tr>
              <th className="gp__c-kind">Kind</th>
              <th className="gp__c-name gp__sortable" onClick={() => toggleSort('name')}>
                Name {sortKey === 'name' ? (sortAsc ? '▲' : '▼') : ''}
              </th>
              <th className="gp__c-cat gp__sortable" onClick={() => toggleSort('category')}>
                Category {sortKey === 'category' ? (sortAsc ? '▲' : '▼') : ''}
              </th>
              <th className="gp__c-graph">Graph</th>
              <th className="gp__c-desc">
                Description
                <span className="gp__hint">shown in tooltips</span>
              </th>
              <th className="gp__c-alias">
                Search aliases
                <span className="gp__hint">
                  the <code>Also:</code> tail — feeds search only, never shown in tooltips. Clearing this deletes the
                  alias terms (lerp→mix, saturate→clamp, …) that resolve <b>only</b> here.
                </span>
              </th>
              <th className="gp__c-cite">Citation</th>
              <th className="gp__c-tsl">TSL</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const id = rowId(r);
              const e = edits[id];
              const dirty = dirtyIds.has(id);
              const childCount = r.nodes.filter((n) => n.type !== 'group').length;
              return (
                <tr key={id} className={dirty ? 'is-dirty' : undefined}>
                  <td className="gp__c-kind">
                    <span className={`gp__kind gp__kind--${r.kind}`}>{r.kind}</span>
                  </td>
                  <td className="gp__c-name">
                    <div className="gp__name">{r.name}</div>
                    <div className="gp__type">{r.key}</div>
                  </td>
                  <td className="gp__c-cat">
                    <CategoryChip category={r.category} />
                  </td>
                  <td className="gp__c-graph">
                    {/* Two destinations, one control — so the footer line + the
                        accent frame say which BEFORE the click, and the title
                        says why. Designable → the embedded Node Designer;
                        everything else → the read-only graph viewer. */}
                    <button
                      className={`gp__graphbtn${r.designable ? ' is-designable' : ''}`}
                      onClick={() => (r.designable ? setDesignerRow(r) : setModal(r))}
                      title={
                        r.designable
                          ? `Design the glyph for “${r.name}” — opens the Node Designer here`
                          : r.kind === 'texture'
                            ? `View the graph behind “${r.name}” — a texture is a node graph, not a single node, so there is no glyph to design`
                            : `View graph — “${r.name}” has no glyph to design (live-canvas node, drawn by its own component)`
                      }
                    >
                      <span className="gp__preview">
                        {r.def ? (
                          <NodePreviewCard def={r.def} onDragStart={noopDragStart} />
                        ) : r.texture ? (
                          <TextureCard texture={r.texture} />
                        ) : null}
                      </span>
                      <span className="gp__graphcount">
                        {r.designable ? (
                          <>
                            <span className="gp__act">✎ design glyph</span>
                          </>
                        ) : (
                          <>
                            {childCount} node{childCount === 1 ? '' : 's'} · view
                          </>
                        )}
                      </span>
                    </button>
                  </td>
                  <td className="gp__c-desc">
                    <AutoTextarea
                      value={e.description}
                      onChange={(v) => patch(id, 'description', v)}
                      placeholder="Tooltip description…"
                    />
                  </td>
                  <td className="gp__c-alias">
                    <input
                      className="gp__in"
                      value={e.aliases}
                      onChange={(ev) => patch(id, 'aliases', ev.target.value)}
                      placeholder="mix, lerp, blend…"
                    />
                  </td>
                  <td className="gp__c-cite">
                    <input
                      className="gp__in"
                      value={e.ref}
                      onChange={(ev) => patch(id, 'ref', ev.target.value)}
                      placeholder="—"
                    />
                    <input
                      className="gp__in gp__in--url"
                      value={e.url}
                      onChange={(ev) => patch(id, 'url', ev.target.value)}
                      placeholder="url (optional)"
                    />
                  </td>
                  <td className="gp__c-tsl">
                    {r.kind === 'node' ? (
                      <code className="gp__tsl">{r.tsl}</code>
                    ) : (
                      <button className="gp__codebtn" onClick={() => setModal(r)} title="Open the graph + TSL source">
                        {r.tsl.split('\n').length} lines
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {modal && (
        <GraphModal
          title={modal.name}
          subtitle={modal.key}
          nodes={modal.nodes}
          edges={modal.edges}
          code={modal.kind === 'texture' ? modal.tsl : undefined}
          onClose={() => setModal(null)}
        />
      )}

      {designerRow && (
        <DesignerModal
          type={designerRow.key}
          label={designerRow.name}
          onClose={() => setDesignerRow(null)}
        />
      )}
    </div>
  );
}
