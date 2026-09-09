import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const NODE_EDITOR = read('./NodeEditor.tsx');
const CONTEXT_MENU = read('./menus/ContextMenu.tsx');
const NOTE_NODE = read('./nodes/NoteNode.tsx');
const MESH_PICKER = read('./nodes/MeshTargetPicker.tsx');

/**
 * A wheel aimed at floating chrome must not move the canvas underneath it.
 *
 * NodeEditor binds its wheel handler on `.node-editor__canvas` in the CAPTURE
 * phase, and every panel that floats over the graph is a DESCENDANT of that
 * element — so an ancestor listener beats the scroll container the wheel was
 * actually aimed at: the graph panned and the list did not move. `.nowheel`
 * (React Flow's own opt-out, which that handler honours) is the escape, and
 * the alternative escape is portalling out of the canvas entirely.
 */
describe('the canvas wheel opt-out', () => {
  it('is honoured by the canvas wheel handler', () => {
    // Without this the class is decoration and every assertion below is
    // vacuous.
    expect(NODE_EDITOR).toMatch(/closest\?\.\('\.nowheel'\)/);
  });

  it('covers the node settings menus — every one of them', () => {
    // ONE class on the shared shell, so a new submenu cannot be added without
    // it. The reported defect: scrolling a node's properties scrolled the
    // graph instead.
    expect(CONTEXT_MENU).toMatch(/className=\{`context-menu nowheel/);
  });

  it('covers the note body and the canvas bar', () => {
    expect(NOTE_NODE).toMatch(/note-node__body nodrag nowheel/);
    expect(NODE_EDITOR).toMatch(/fs-canvas-bar nodrag nowheel/);
  });

  it('lets the mesh picker escape by portalling to the body instead', () => {
    // The other valid answer: a panel OUTSIDE the canvas element is never
    // reached by the capture listener, so it needs no class.
    expect(MESH_PICKER).toMatch(/createPortal\([\s\S]*document\.body/);
  });

  it('accounts for every scroll container under components/NodeEditor', () => {
    // The sweep that makes this expire on its own: a NEW `overflow-y: auto`
    // inside the canvas is a new place where a wheel silently pans the graph,
    // and it must be opted out (or portalled) the same way.
    const dir = new URL('./', import.meta.url);
    const files: string[] = [];
    const walk = (u: URL, prefix: string) => {
      for (const e of readdirSync(u, { withFileTypes: true })) {
        if (e.isDirectory()) walk(new URL(`${e.name}/`, u), `${prefix}${e.name}/`);
        else if (e.name.endsWith('.css')) files.push(prefix + e.name);
      }
    };
    walk(dir, '');
    const scrollers = files.filter((f) => /overflow(-y)?:\s*(auto|scroll)/.test(read('./' + f)));
    expect(scrollers.sort()).toEqual([
      'menus/ContextMenu.css',        // .nowheel on the shared shell
      'nodes/MeshTargetPicker.css',   // portalled to document.body
      'nodes/NoteNode.css',           // .nowheel on the note body
    ]);
  });
});
