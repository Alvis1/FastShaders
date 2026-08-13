import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * No source file may carry a RAW C0 control byte (anything below 0x20 that is
 * not tab / LF / CR).
 *
 * This is not style policing. grep, ripgrep and BSD/GNU/ugrep all classify a
 * file containing a NUL as BINARY and stop reporting matches in it. On this
 * repo's toolchain (ugrep 7.5.0) an affected file returns "no match" with exit
 * status 1 for EVERY pattern, including patterns on line 1 -- so a repo-wide
 * grep, a sed audit or a codemod skips the whole file silently and
 * successfully. MicNode.tsx and OutputNode.tsx (a NUL/SOH separator inside a
 * template literal) and imageCodec.test.ts (a RIFF header in a string literal)
 * were all invisible this way, which is how a search for `getTargetEdges` came
 * back without the one file that uses it correctly.
 *
 * The fix is always the JS unicode-escape spelling of the same code point --
 * see the separator in ShaderNode.tsx's `edgeKey`, which has always been
 * written that way and builds a byte-identical runtime string.
 */
const SRC = fileURLToPath(new URL('.', import.meta.url));
const EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.jsx', '.css', '.json']);

/** Everything below 0x20 except tab (9), LF (10) and CR (13). */
const isBadControl = (c: number) =>
  c < 9 || c === 11 || c === 12 || (c >= 14 && c < 32);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(entry.name))) out.push(p);
  }
  return out;
}

describe('source files stay greppable', () => {
  it('no file under src/ contains a raw control byte', () => {
    const files = walk(SRC);
    // Guard against the walk silently finding nothing (wrong root, bad ext set).
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const file of files) {
      const bytes = readFileSync(file);
      for (let i = 0; i < bytes.length; i++) {
        if (!isBadControl(bytes[i])) continue;
        const line = bytes.subarray(0, i).toString('utf8').split('\n').length;
        offenders.push(
          `${path.relative(SRC, file)}:${line} - 0x${bytes[i]
            .toString(16)
            .padStart(2, '0')}`,
        );
        break; // one report per file is enough to locate it
      }
    }

    expect(
      offenders.sort(),
      'raw control bytes make these files BINARY to grep/rg/sed, so repo-wide '
        + 'searches skip them silently. Write the code point as a JS unicode '
        + 'escape instead (see the edgeKey separator in ShaderNode.tsx).',
    ).toEqual([]);
  });
});
