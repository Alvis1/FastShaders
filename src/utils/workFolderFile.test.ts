import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { toKebabCase } from './nameUtils';
import {
  MAX_WORK_FOLDER_NAME_BYTES,
  adoptShaderName,
  fitsWorkFolderName,
  isShaderRenamed,
  sameShaderFile,
  stripShaderExt,
  workFolderSaveName,
} from './workFolderFile';

/**
 * These rules decide which FILE the desktop Work folder's Save button replaces,
 * and `work_folder_write_bytes` has no undo — so the properties below are the ones
 * that stop a save landing on the wrong shader. WorkFolder.tsx itself is a
 * Tauri-bridged component the `node` test env cannot mount; this is the whole
 * decision layer pulled out of it.
 */

describe('stripShaderExt', () => {
  it('drops one .js/.zip, case-insensitively', () => {
    expect(stripShaderExt('waves.js')).toBe('waves');
    expect(stripShaderExt('Waves.JS')).toBe('Waves');
    expect(stripShaderExt('bundle.zip')).toBe('bundle');
  });

  it('leaves a non-shader extension alone', () => {
    // `.jsx` must not be mistaken for `.js` — the regex is anchored.
    expect(stripShaderExt('waves.jsx')).toBe('waves.jsx');
    expect(stripShaderExt('waves')).toBe('waves');
  });

  it('strips only the LAST extension', () => {
    // Looping would collapse this to `foo` and could re-target a real foo.js.
    expect(stripShaderExt('foo.js.zip')).toBe('foo.js');
  });
});

describe('adoptShaderName', () => {
  it('keeps the prettier authored name when it denotes the same file', () => {
    expect(adoptShaderName('my-shader.js', 'My Shader')).toBe('My Shader');
    expect(adoptShaderName('waves.zip', 'Waves')).toBe('Waves');
  });

  it('lets the file name win when the two diverge', () => {
    // The reported bug: waves.js whose graph is still called "Untitled".
    expect(adoptShaderName('waves.js', 'Untitled')).toBe('waves');
  });

  it('falls back to the stem when the file supplied no name', () => {
    // Bare scripts (no FASTSHADERS_PROJECT_V1 block) reach this.
    expect(adoptShaderName('waves.js', null)).toBe('waves');
    expect(adoptShaderName('waves.js', '')).toBe('waves');
  });

  it('does not adopt a whitespace-only authored name', () => {
    // '   ' is truthy and would otherwise blank the toolbar's name box.
    expect(adoptShaderName('shader.js', '   ')).toBe('shader');
  });

  it('trims before comparing, so padding is not a divergence', () => {
    expect(adoptShaderName('waves.js', '  Waves  ')).toBe('Waves');
  });

  it('refuses names that only match through toKebabCase\'s fallback', () => {
    // '***', '日本語' and '' all kebab to 'shader'; treating that as an identity
    // would adopt any of them for the file the app writes them all as.
    expect(toKebabCase('***')).toBe('shader');
    expect(adoptShaderName('shader.js', '***')).toBe('shader');
    expect(adoptShaderName('shader.js', '日本語')).toBe('shader');
    // A REAL match on that stem is still kept.
    expect(adoptShaderName('shader.js', 'Shader')).toBe('Shader');
  });

  it('preserves a diacritic name across the round trip', () => {
    // toKebabCase strips non-ASCII, so the file name alone cannot carry it —
    // the project block can, and the kebab-equality branch is what keeps it.
    const authored = 'Mans Ēnotājs';
    const file = `${toKebabCase(authored)}.js`;
    expect(adoptShaderName(file, authored)).toBe(authored);
  });

  it('is idempotent — load→save→load converges and never drifts', () => {
    const pairs: [string, string | null][] = [
      ['my-shader.js', 'My Shader'],
      ['waves.js', 'Untitled'],
      ['waves.js', null],
      ['Waves.JS', 'Waves'],
      ['bundle.zip', null],
      ['shader.js', '***'],
    ];
    for (const [file, authored] of pairs) {
      const once = adoptShaderName(file, authored);
      expect(adoptShaderName(file, once)).toBe(once);
    }
  });

  it('always yields a name that resolves back to the opened file', () => {
    // The invariant Save depends on: with no rename, the derived export name
    // hits the file that was opened.
    const files = ['my-shader.js', 'waves.js', 'Waves.JS', 'bundle.zip', 'a-b-c.js'];
    const authored = ['My Shader', 'Untitled', null, '', 'Waves', '  x  '];
    for (const f of files) {
      for (const a of authored) {
        const adopted = adoptShaderName(f, a);
        expect(toKebabCase(adopted)).toBe(toKebabCase(stripShaderExt(f)));
      }
    }
  });
});

describe('sameShaderFile', () => {
  it('compares case-insensitively (APFS/NTFS see one file)', () => {
    expect(sameShaderFile('Waves.js', 'waves.JS')).toBe(true);
    expect(sameShaderFile('waves.js', 'waves.zip')).toBe(false);
  });
});

describe('isShaderRenamed', () => {
  it('is false while the name still resolves to the same file', () => {
    expect(isShaderRenamed('My Shader', 'My  Shader')).toBe(false);
    expect(isShaderRenamed('my-shader', 'My Shader')).toBe(false);
    expect(isShaderRenamed('Waves', 'Waves ')).toBe(false);
  });

  it('is true for a rename that reaches a different file', () => {
    expect(isShaderRenamed('Waves', 'Ripples')).toBe(true);
  });

  it('reports the kebab collision honestly rather than guessing', () => {
    // Two different words, one file name — the caller prompts before replacing.
    expect(toKebabCase('Zīle')).toBe(toKebabCase('Zāle'));
    expect(isShaderRenamed('Zīle', 'Zāle')).toBe(false);
  });
});

describe('workFolderSaveName', () => {
  it('uses the export name when nothing is tracked', () => {
    expect(workFolderSaveName(null, 'my-shader.js', 'js')).toBe('my-shader.js');
  });

  it('returns the tracked name VERBATIM when the kind matches', () => {
    // Keeping the on-disk casing is what makes the write replace the opened
    // file instead of creating a lowercase sibling.
    expect(workFolderSaveName('Waves.JS', 'waves.js', 'js')).toBe('Waves.JS');
    expect(workFolderSaveName('My Shader.js', 'my-shader.js', 'js')).toBe('My Shader.js');
    expect(workFolderSaveName('Pack.ZIP', 'pack.zip', 'zip')).toBe('Pack.ZIP');
  });

  it('re-extends the stem when the bundle kind flips', () => {
    expect(workFolderSaveName('waves.js', 'waves.zip', 'zip')).toBe('waves.zip');
    expect(workFolderSaveName('Waves.zip', 'waves.js', 'js')).toBe('Waves.js');
  });

  it('falls back to the export name when the flip breaks the byte budget', () => {
    // safe_name measures BYTES: a name at the limit cannot grow .js → .zip.
    const stem = 'x'.repeat(MAX_WORK_FOLDER_NAME_BYTES - 3);
    const atLimit = `${stem}.js`;
    expect(fitsWorkFolderName(atLimit)).toBe(true);
    expect(fitsWorkFolderName(`${stem}.zip`)).toBe(false);
    expect(workFolderSaveName(atLimit, 'fallback.zip', 'zip')).toBe('fallback.zip');
    // Same-kind saves are unaffected — those bytes were already accepted.
    expect(workFolderSaveName(atLimit, 'fallback.js', 'js')).toBe(atLimit);
  });

  it('measures the budget in bytes, not characters', () => {
    // 130 Latvian chars = 260 bytes: a String.length check would pass this and
    // the Rust side would then reject the save.
    const wide = `${'ē'.repeat(130)}.js`;
    expect(wide.length).toBeLessThan(MAX_WORK_FOLDER_NAME_BYTES);
    expect(fitsWorkFolderName(wide)).toBe(false);
  });
});

/**
 * The single-GLB export is the THIRD work-folder kind (GLB Phase 7 Step 7).
 * Its extension has to be accepted on BOTH sides in one commit: `safe_name`
 * alone would list `.glb` files that `loadEntry` would TextDecode as a script.
 */
describe('the .glb kind', () => {
  it('strips one .glb like any other extension', () => {
    expect(stripShaderExt('a.glb')).toBe('a');
    expect(stripShaderExt('a.GLB')).toBe('a');
    // Single-strip: `a.glb.zip` keeps the ugly-but-distinct stem.
    expect(stripShaderExt('a.glb.zip')).toBe('a.glb');
  });

  it('flips a tracked file to .glb and keeps the on-disk spelling when it already is one', () => {
    expect(workFolderSaveName('Waves.zip', 'waves.glb', 'glb')).toBe('Waves.glb');
    expect(workFolderSaveName('Waves.glb', 'waves.glb', 'glb')).toBe('Waves.glb');
    expect(workFolderSaveName('Waves.GLB', 'waves.glb', 'glb')).toBe('Waves.GLB');
    expect(workFolderSaveName(null, 'x.glb', 'glb')).toBe('x.glb');
    // …and back, when the Format switches to the shader file again.
    expect(workFolderSaveName('Waves.glb', 'waves.js', 'js')).toBe('Waves.js');
  });

  it('a .zip name at the byte limit flips to .glb, which is the same length', () => {
    const stem = 'x'.repeat(MAX_WORK_FOLDER_NAME_BYTES - 4);
    expect(fitsWorkFolderName(`${stem}.zip`)).toBe(true);
    expect(workFolderSaveName(`${stem}.zip`, 'fallback.glb', 'glb')).toBe(`${stem}.glb`);
  });

  it('accepts exactly the extensions Rust does (work_folder.rs safe_name)', () => {
    const rust = readFileSync(
      path.resolve(__dirname, '../../src-tauri/src/work_folder.rs'),
      'utf8',
    );
    const at = rust.indexOf('fn safe_name(');
    expect(at).toBeGreaterThan(-1);
    const body = rust.slice(at, rust.indexOf('\n}\n', at));
    const rustExts = [...body.matchAll(/ends_with\("\.([a-z0-9]+)"\)/g)].map((m) => m[1]).sort();
    expect(rustExts).toEqual(['glb', 'js', 'zip']);
    // The TS side's own list, through the one function that reads it.
    for (const ext of rustExts) expect(stripShaderExt(`a.${ext}`), ext).toBe('a');
    expect(stripShaderExt('a.gltf')).toBe('a.gltf');
  });
});
