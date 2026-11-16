import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NODE_REGISTRY } from '@/registry/nodeRegistry';
import { CONSTANT_KEY_TYPES, constantKeyType } from './constantKeys';

/** 1 / 2 / 3 + click drops a Float / Vec2 / Vec3 (constantKeys.ts). */
describe('constant keys', () => {
  it('maps 1, 2, 3 to the Float, Vec2 and Vec3 registry types', () => {
    expect(constantKeyType({ key: '1', code: 'Digit1' })).toBe('float');
    expect(constantKeyType({ key: '2', code: 'Digit2' })).toBe('vec2');
    expect(constantKeyType({ key: '3', code: 'Digit3' })).toBe('vec3');
    for (const type of Object.values(CONSTANT_KEY_TYPES)) expect(NODE_REGISTRY.has(type), type).toBe(true);
  });

  it('reads the key by its place too: the number pad, and a layout that shifts its digits', () => {
    expect(constantKeyType({ key: '1', code: 'Numpad1' })).toBe('float');
    // AZERTY: the digit row types & é " unshifted.
    expect(constantKeyType({ key: '&', code: 'Digit1' })).toBe('float');
    expect(constantKeyType({ key: '"', code: 'Digit3' })).toBe('vec3');
  });

  it('answers nothing for any other key', () => {
    for (const e of [{ key: '4', code: 'Digit4' }, { key: '0', code: 'Digit0' }, { key: 'a', code: 'KeyA' }, { key: 'constructor' }, {}]) {
      expect(constantKeyType(e), JSON.stringify(e)).toBeNull();
    }
  });

  it('NodeEditor arms it among the guarded bare canvas keys and places through the one path, unscattered', () => {
    const src = readFileSync(path.join(__dirname, 'NodeEditor.tsx'), 'utf8');
    // Armed AFTER the typing, dialog and modifier guards of the bare keys.
    const keys = src.indexOf('const constType = constantKeyType(e);');
    expect(keys).toBeGreaterThan(src.indexOf("if (e.metaKey || e.ctrlKey || e.altKey) return;\n      // 1 / 2 / 3"));
    // Placed as a DROP at the click (activate false), marked as a key add.
    expect(src).toContain("placeTileRef.current?.({ kind: 'node', nodeType: constType }, event.clientX, event.clientY, false, true);");
  });
});
