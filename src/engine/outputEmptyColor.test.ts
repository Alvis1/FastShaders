import { describe, it, expect } from 'vitest';
import { graphToCode } from './graphToCode';
import { makeNode, makeEdge } from '@/test-utils';
import { OUTPUT_EMPTY_COLOR, OUTPUT_COLOR_VALUE_PORTS } from '@/components/NodeEditor/nodes/OutputNode';

/**
 * The Output node's Color row must not contradict the shader. graphToCode has
 * TWO different "unwired colour" behaviours and the node has to agree with
 * whichever one is live:
 *   - no channel contributes  -> `return vec3(1, 0, 0)`  (RED sentinel)
 *   - some other channel does -> object return, colorNode undefined, so
 *                                three's material default (WHITE) applies.
 */
describe('Output node empty-state colour matches the emitted shader', () => {
  it('emits the RED fallback when nothing is wired or stored', () => {
    const { code } = graphToCode([makeNode('out', 'output')], []);
    expect(code).toContain('return vec3(1, 0, 0);');
  });

  it('OUTPUT_EMPTY_COLOR is exactly that fallback colour', () => {
    // vec3(1, 0, 0) == #ff0000. If the emitter's sentinel ever changes, this
    // fails and the node stops lying only because someone updated both.
    expect(OUTPUT_EMPTY_COLOR).toBe('#ff0000');
  });

  it('does NOT emit the red fallback once another channel contributes', () => {
    // Roughness wired -> object return, no colorNode -> three renders WHITE,
    // which is what OUTPUT_COLOR_VALUE_PORTS.color still shows.
    const f = makeNode('f', 'float', { value: 0.3 });
    const out = makeNode('out', 'output');
    const { code } = graphToCode([f, out], [makeEdge('f', 'out', 'out', 'roughness')]);
    expect(code).not.toContain('return vec3(1, 0, 0);');
    expect(code).toContain('roughness:');
    expect(OUTPUT_COLOR_VALUE_PORTS.color).toBe('#ffffff');
  });

  it('a stored colour wins over both defaults', () => {
    const out = makeNode('out', 'output');
    (out.data as { values: Record<string, unknown> }).values = { color: '#00ff00' };
    (out.data as { exposedPorts: string[] }).exposedPorts = ['color'];
    const { code } = graphToCode([out], []);
    expect(code).toContain('color(0x00ff00)');
    expect(code).not.toContain('return vec3(1, 0, 0);');
  });
});
