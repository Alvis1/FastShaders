#!/usr/bin/env bash
# Stop hook: a turn may not end on a red tree.
#
# Runs `tsc --noEmit` and the vitest suite (~10 s together) and, on failure,
# exits 2 so Claude keeps going with the failure tail as its instruction.
#
# Skipped when the working tree is byte-identical to the last GREEN run — a
# turn that only answered a question costs one `git diff`, not a test run.
# The stamp lives in the git dir (per worktree), never in the tree.
set -u

input=$(cat)
# Never loop: a turn this hook already sent back may stop.
[ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)" = "true" ] && exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Fingerprint: HEAD + tracked changes + untracked (non-ignored) file contents,
# the same three for every checked-out submodule. CLAUDE.md and docs/dev are
# part of it on purpose — the suites that import src/projectDocs.ts pin claims
# read from them. The submodule part is NOT optional: the superproject's diff
# renders a dirty a-frame-shaderloader as one unchanging "-dirty" line, and
# since public/js/ became generated + gitignored no tracked file mirrors the
# loader, so a second loader edit (even a syntax error) skipped every run.
fingerprint=$(
  {
    git rev-parse HEAD 2>/dev/null
    git diff HEAD --binary 2>/dev/null
    git ls-files --others --exclude-standard -z 2>/dev/null | xargs -0 shasum 2>/dev/null
    git submodule foreach --quiet --recursive \
      'echo "$displaypath"; git rev-parse HEAD; git diff HEAD --binary; git ls-files --others --exclude-standard -z | xargs -0 shasum' \
      2>/dev/null
  } | shasum | cut -d' ' -f1
)
stamp="$(git rev-parse --git-path fs-verify-green 2>/dev/null)"
[ -n "$stamp" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$fingerprint" ] && exit 0

export NO_COLOR=1 FORCE_COLOR=0 CI=1
if ! out=$(npx tsc --noEmit -p . 2>&1); then
  {
    echo "Stop hook: \`npx tsc --noEmit\` FAILED — fix before ending the turn."
    echo "(If these errors are in files another session is editing, say so instead of changing them.)"
    printf '%s\n' "$out" | head -40
  } >&2
  exit 2
fi
if ! out=$(npm test --silent 2>&1); then
  {
    echo "Stop hook: \`npm test\` FAILED — fix before ending the turn."
    echo "(If the failures are in files another session is editing, say so instead of changing them.)"
    printf '%s\n' "$out" | grep -E 'FAIL|Error|Expected|Received|❯|Test Files|Tests ' | head -60
  } >&2
  exit 2
fi

[ -n "$stamp" ] && printf '%s' "$fingerprint" > "$stamp"
exit 0
