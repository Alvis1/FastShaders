# FastShaders Codebase Audit

A senior-engineer audit prompt, split into 5 passes. Designed to be run **one pass per fresh Claude Code session** so each pass gets a clean context window.

## How to run a pass

In a new Claude Code chat, send a single line:

```
Read audit/HEADER.md and audit/pass-4.md, then execute.
```

(Swap in `pass-1.md` through `pass-5.md` as needed.)

The project context lives in `CLAUDE.md` at the repo root and is auto-loaded — no need to paste it.

## Recommended order

**Run Pass 4 (security) first.** The cost of a missed finding is highest there because FastShaders loads user-supplied `.fastshader` files. After that, run 1 → 2 → 3 → 5 in any order.

## Output goes here

Save each pass's report as `audit/findings/pass-N-YYYY-MM-DD.md`. When you re-run the audit later, diff the new findings against the previous run to see whether issues are actually closing or just being replaced.

## Files

- `HEADER.md` — grounding rule + output format. Applies to every pass.
- `pass-1.md` — consistency (cap: 15 findings)
- `pass-2.md` — bloat (cap: 15 findings)
- `pass-3.md` — compatibility (cap: 10 findings)
- `pass-4.md` — security (cap: 12 findings) — **run first**
- `pass-5.md` — tests and resource hygiene (cap: 10 findings + 10 test cases) — ends with the cumulative Top 10
