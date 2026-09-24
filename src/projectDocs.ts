/**
 * The project's own prose, as ONE corpus: `CLAUDE.md` plus every file under
 * `docs/dev/`. A non-test module imported only by tests (the
 * `shaderloaderHarness.ts` / `gltfImportFixtures.ts` precedent) — it reads the
 * filesystem, so nothing in the app may import it.
 *
 * Several suites pin a documented CLAIM rather than a behaviour: "CLAUDE.md
 * states the rule", "CLAUDE.md does not still make the old wrong claim". Those
 * guards are about the documentation being right, not about which FILE carries
 * it — and since the rules and their reasoning were split (CLAUDE.md keeps the
 * one-line rule, `docs/dev/` keeps the measurements), a guard reading CLAUDE.md
 * alone would fail for text that simply moved.
 *
 * Reading the corpus keeps both halves honest: a positive pin still fails when
 * the claim is deleted anywhere, and a NEGATIVE pin gets stronger — a retracted
 * claim must not come back in any documentation file, not merely in CLAUDE.md.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEV_DOCS = join(ROOT, 'docs', 'dev');

let cached: string | null = null;

/** `CLAUDE.md` + `docs/dev/*.md`, newline-joined. Memoized: `isolate: false`
 *  shares module state across a worker's suites, and this is ~730 KB. */
export function projectDocs(): string {
  if (cached !== null) return cached;
  const parts = [readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8')];
  for (const name of readdirSync(DEV_DOCS).sort()) {
    if (name.endsWith('.md')) parts.push(readFileSync(join(DEV_DOCS, name), 'utf8'));
  }
  cached = parts.join('\n');
  return cached;
}
