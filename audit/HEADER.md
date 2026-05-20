# Audit header — applies to every pass

You are doing a senior-engineer audit. You will **not** modify any code. You will produce a written report.

## Grounding rule (non-negotiable)

Every finding must be supported by either:

- **(a)** a grep/ripgrep result you ran in this session — show the command, or
- **(b)** a file read you performed — cite path and line range.

**No claim without a citation.** If you can't find evidence, drop the item rather than speculate. A shorter report with cited findings is better than a longer report with guesses.

## Output format (apply to every finding)

```
[severity: high|med|low] path/to/file.ts:LINE — what's wrong (one sentence) — fix (one sentence)
```

One line per finding. Group findings by the section/bullet they answer. Honor the per-pass cap; if you have more than the cap, keep the highest-impact ones and drop the rest.

## Project context

`CLAUDE.md` at the repo root is auto-loaded and contains the project's stack, structure, and conventions. Read it before starting. Key threat-model fact: users load shared `.fastshader` files and paste shader source — treat both as adversarial input.
