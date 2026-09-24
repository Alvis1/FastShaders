/**
 * The Texture (Image) node's channel-socket table (GLB Phase 4 Step 2).
 *
 * Two tables have to agree: the swizzle graphToCode will emit per socket, and
 * the channel index the CPU projection reads. If they drift, the on-node label
 * reads one channel while the shader reads another — invisible by inspection,
 * which is why the parity is pinned rather than trusted.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  IMAGE_CHANNEL_COMPONENTS,
  IMAGE_CHANNEL_INDEX,
  isImageChannelHandle,
} from './imageChannels';

describe('imageChannels — the ONE table', () => {
  it('each socket\'s CPU index is its swizzle\'s position in rgba', () => {
    for (const [id, comp] of IMAGE_CHANNEL_COMPONENTS) {
      expect(IMAGE_CHANNEL_INDEX.get(id), id).toBe('rgba'.indexOf(comp));
    }
    expect([...IMAGE_CHANNEL_INDEX.keys()].sort()).toEqual([...IMAGE_CHANNEL_COMPONENTS.keys()].sort());
  });

  it('lists the sockets in the registry order that follows `out`: r, g, b, alpha', () => {
    // engine/imageChannelSockets.test.ts pins the registry's output ids
    // against this order directly (and registry/imageNodeAddable.test.ts).
    //
    // It was alpha-FIRST until 2026-09-19. Nothing in production iterates this
    // Map — every read is `.get`/`.has` — so the move changed no emitted byte;
    // what it changed is the order the four channel sockets sit in on the
    // node, which is now the order every format the user already reads writes
    // them in (RGBA, `#rrggbbaa`, an ORM map's r/g/b).
    expect([...IMAGE_CHANNEL_COMPONENTS.keys()]).toEqual(['r', 'g', 'b', 'alpha']);
    expect([...IMAGE_CHANNEL_COMPONENTS.values()]).toEqual(['r', 'g', 'b', 'a']);
  });

  it('never names `out` — the Color socket is the RGB run, not a channel', () => {
    expect(IMAGE_CHANNEL_COMPONENTS.has('out')).toBe(false);
    expect(IMAGE_CHANNEL_INDEX.has('out')).toBe(false);
  });

  it('uses Maps, so a prototype key from a .fastshader resolves to nothing', () => {
    expect(IMAGE_CHANNEL_COMPONENTS).toBeInstanceOf(Map);
    expect(IMAGE_CHANNEL_INDEX).toBeInstanceOf(Map);
    for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(IMAGE_CHANNEL_COMPONENTS.get(k), k).toBeUndefined();
      expect(IMAGE_CHANNEL_INDEX.get(k), k).toBeUndefined();
    }
  });

  it('isImageChannelHandle is true for exactly the four channel sockets', () => {
    for (const h of ['alpha', 'r', 'g', 'b']) expect(isImageChannelHandle(h), h).toBe(true);
    for (const h of [
      'out', null, undefined, '', 'a', 'x', 'w', 'rgb', 'rgba', 'Alpha', 'R',
      '__proto__', 'constructor', 'toString',
    ]) {
      expect(isImageChannelHandle(h), String(h)).toBe(false);
    }
  });

  it('is a LEAF: it imports nothing', () => {
    // graphToCode, cpuEvaluator and NodeEditor all read it; an import here is a
    // chance to land inside the store's import cycle (the costTable lesson).
    const src = readFileSync(new URL('./imageChannels.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/\brequire\(/);
    expect(src).not.toMatch(/\bimport\(/);
  });
});
